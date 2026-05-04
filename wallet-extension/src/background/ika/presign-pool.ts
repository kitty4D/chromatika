/**
 * presign refill: Sui PTBs for `sui` ika base; ika Solana pre-alpha uses gRPC `PresignForDWallet`.
 */
import { Curve, IkaTransaction, SignatureAlgorithm } from '@ika.xyz/sdk';
import { Transaction } from '@mysten/sui/transactions';
import { getSession } from '@/background/session';
import type { CurveKey } from '@/background/session';
import { requireSuiAndIkaCoins } from '@/background/ika/coins';
import { executeSuiTransaction } from '@/background/sui/execute-transaction';
import { getSuiFeePayerSuiAddress } from '@/background/sui/sui-fee-payer-signing';
import { getRequiredCoinAmounts } from '@/background/ika/pricing';
import { runSerializedIkaTx } from '@/background/ika/tx-serialize';
import type { SolanaDkgCurve, SolanaPresignSigAlg } from '@/background/ika/solana-grpc-client';
import { IKA_SOLANA_SECP_SIGNING_IMPLEMENTED } from '@/background/ika/solana-secp-signing';
import { VAULT_SCOPED_KEYS } from '@/background/storage';

export type PresignPoolKey = 'SECP256K1_ECDSA' | 'SECP256K1_TAPROOT' | 'ED25519_EDDSA';

type PoolsStore = Partial<Record<PresignPoolKey, string[]>>;

function poolsStorageKey(vaultId: string): string {
  return VAULT_SCOPED_KEYS.presignPools(vaultId);
}

const POOL_CONFIG: Record<PresignPoolKey, { curve: Curve; sigAlgo: SignatureAlgorithm }> = {
  SECP256K1_ECDSA:   { curve: Curve.SECP256K1, sigAlgo: SignatureAlgorithm.ECDSASecp256k1 },
  SECP256K1_TAPROOT: { curve: Curve.SECP256K1, sigAlgo: SignatureAlgorithm.Taproot },
  ED25519_EDDSA:     { curve: Curve.ED25519,   sigAlgo: SignatureAlgorithm.EdDSA },
};

function poolToCurveKey(key: PresignPoolKey): CurveKey {
  return key === 'ED25519_EDDSA' ? 'ED25519' : 'SECP256K1';
}

function poolToSolanaGrpc(key: PresignPoolKey): { curve: SolanaDkgCurve; sigAlg: SolanaPresignSigAlg } {
  if (key === 'SECP256K1_ECDSA') return { curve: 'Secp256k1', sigAlg: 'ECDSASecp256k1' };
  if (key === 'SECP256K1_TAPROOT') return { curve: 'Secp256k1', sigAlg: 'Taproot' };
  return { curve: 'Curve25519', sigAlg: 'EdDSA' };
}

async function replenishPoolSolana(key: PresignPoolKey, count: number): Promise<{ added: number }> {
  // secp256k1 presigns are not consumable for EVM / BTC until Solana `approve_message` + gRPC Sign ships.
  if (
    (key === 'SECP256K1_ECDSA' || key === 'SECP256K1_TAPROOT')
    && !IKA_SOLANA_SECP_SIGNING_IMPLEMENTED
  ) {
    return { added: 0 };
  }
  // ED25519 / EdDSA is deterministic per RFC 8032 (no per-signature random nonce) so a presign
  // is meaningless. the Solana pre-alpha gRPC's `PresignForDWallet` is also gated to imported
  // ECDSA keys today; calling it for `Curve25519 / EdDSA` returns
  // "PresignForDWallet is only for imported ECDSA keys". skip the refill; `signMessageSol`
  // shortcuts past the presign-pool entirely on Solana base and passes empty
  // `presign_session_identifier` bytes straight to `requestSignEd25519Message`.
  if (key === 'ED25519_EDDSA') {
    return { added: 0 };
  }
  const s = getSession();
  if (!s?.solanaIkaGrpc) throw new Error('Wallet locked');
  // each presign fires a gRPC `approve_message` chain. in `in_extension` mode this guard tops
  // up the fee account before we start; in `seeker_direct` mode it's a no-op (each gRPC call
  // surfaces its own phone prompt). done here rather than at every call site so the alarm path
  // and the lazy on-demand path both stay covered.
  const { ensureFeePayerFunded } = await import('@/background/ika/ensure-fee-payer-funded');
  await ensureFeePayerFunded(s);
  const vaultId = s.activeVaultId;
  const ck = poolToCurveKey(key);
  const meta = s.dwalletMeta[ck];
  const dwalletId = meta?.dwalletId;
  if (!dwalletId) {
    throw new Error(`Create a ${ck} dWallet on Solana before presign refill`);
  }
  const dwalletPublicKeyB64 = meta?.dwalletPublicKeyB64;
  const dwalletAttestationBytesB64 = meta?.dwalletAttestationBytesB64;
  if (!dwalletPublicKeyB64 || !dwalletAttestationBytesB64) {
    throw new Error(`Missing Solana dWallet attestation for ${ck}; re-run DKG on 0.1.1`);
  }
  const { curve, sigAlg } = poolToSolanaGrpc(key);
  const pools = await loadPools(vaultId);
  pools[key] ??= [];
  let added = 0;
  for (let i = 0; i < count; i++) {
    const { presignIdHex } = await s.solanaIkaGrpc.requestPresignForDWallet(
      dwalletId,
      curve,
      sigAlg,
      { dwalletPublicKeyB64, dwalletAttestationBytesB64 },
    );
    pools[key]!.push(presignIdHex);
    added++;
  }
  await savePools(vaultId, pools);
  return { added };
}

function requireVaultId(): string {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  return s.activeVaultId;
}

async function loadPools(vaultId: string): Promise<PoolsStore> {
  const key = poolsStorageKey(vaultId);
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([key], (r) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve((r[key] as PoolsStore) ?? {});
    });
  });
}

async function savePools(vaultId: string, p: PoolsStore): Promise<void> {
  const key = poolsStorageKey(vaultId);
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [key]: p }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

/**
 * SDK event objects vary by call path. `signAndExecuteTransaction` returns
 * `{ eventType, json }`, raw GraphQL nodes use `{ contents: { type: { repr }, json } }`,
 * and some paths normalize to `{ type, parsedJson }`. handle them all.
 */
 
function presignIdFromEvents(events: any): string | undefined {
  const list: unknown[] = Array.isArray(events)
    ? events
    : events?.nodes ?? [];
  for (const raw of list) {
    const e = raw as Record<string, unknown>;
    const typeStr =
      (e.type as string | undefined) ??
      (e.eventType as string | undefined) ??
      ((e.contents as Record<string, unknown> | undefined)?.type as Record<string, unknown> | undefined)?.repr as string | undefined ??
      '';
    if (!typeStr.includes('Presign')) continue;
    const json =
      (e.parsedJson as Record<string, unknown> | undefined) ??
      (e.json as Record<string, unknown> | undefined) ??
      ((e.contents as Record<string, unknown> | undefined)?.json as Record<string, unknown> | undefined);
    if (!json) continue;
    const eventData = json.event_data as Record<string, unknown> | undefined;
    const presignId = eventData?.presign_id;
    if (typeof presignId === 'string' && presignId.startsWith('0x')) return presignId;
    if (typeof json.presign_id === 'string') return json.presign_id as string;
    if (typeof json.id === 'string') return json.id as string;
  }
  return undefined;
}

export async function getPresignPoolStatus() {
  const vaultId = requireVaultId();
  const pools = await loadPools(vaultId);
  return {
    SECP256K1_ECDSA:   pools.SECP256K1_ECDSA?.length ?? 0,
    SECP256K1_TAPROOT: pools.SECP256K1_TAPROOT?.length ?? 0,
    ED25519_EDDSA:     pools.ED25519_EDDSA?.length ?? 0,
  };
}

export async function replenishPool(key: PresignPoolKey, count = 3): Promise<{ added: number }> {
  const s0 = getSession();
  if (!s0) throw new Error('Wallet locked');
  if (s0.activeVaultBaseChain === 'solana') {
    return replenishPoolSolana(key, count);
  }
  return runSerializedIkaTx(async () => {
    const s = getSession();
    if (!s) throw new Error('Wallet locked');
    const vaultId = s.activeVaultId;
    const { curve, sigAlgo } = POOL_CONFIG[key];
    const owner = getSuiFeePayerSuiAddress(s);
    const { ikaAmount, suiAmount } = await getRequiredCoinAmounts(s.ikaClient);
    const networkKey = await s.ikaClient.getLatestNetworkEncryptionKey();
    const pools = await loadPools(vaultId);
    pools[key] ??= [];
    let added = 0;
    for (let i = 0; i < count; i++) {
      let lastErr: unknown;
      let result: Awaited<ReturnType<typeof executeSuiTransaction>> | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          // re-select coin objects each attempt so we never reuse stale object
          // versions after concurrent signing / indexer lag.
          const { suiCoinId, ikaCoinId } = await requireSuiAndIkaCoins(
            s.suiClient,
            s.ikaClient.ikaConfig,
            owner,
            { minSuiProtocolSplitMist: suiAmount, session: s },
          );
          const tx = new Transaction();
          const ikaTx = new IkaTransaction({ ikaClient: s.ikaClient, transaction: tx as never });
          const splitIka = tx.splitCoins(tx.object(ikaCoinId), [ikaAmount]);
          const splitSui = tx.splitCoins(tx.object(suiCoinId), [suiAmount]);
          const presignReqResult = ikaTx.requestGlobalPresign({
            dwalletNetworkEncryptionKeyId: networkKey.id,
            curve,
            signatureAlgorithm: sigAlgo,
            ikaCoin: splitIka[0],
            suiCoin: splitSui[0],
          });
          tx.transferObjects([presignReqResult as never], owner);
          tx.transferObjects([splitIka[0], splitSui[0]], owner);
          // first attempt uses full simulate checks; retries relax checks (node / GraphQL quirks).
          const dryRunChecksEnabled = attempt === 0;
          result = await executeSuiTransaction(s, tx, {
            include: { events: true },
            dryRunChecksEnabled,
          });
          break;
        } catch (e) {
          lastErr = e;
          if (attempt < 2) await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        }
      }
      if (!result) {
        throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? 'presign execute failed'));
      }
      if (result.$kind === 'FailedTransaction') {
        const failErr = result.FailedTransaction?.status?.error;
        const reason = typeof failErr === 'string' ? failErr : JSON.stringify(failErr ?? 'unknown');
        throw new Error(`Presign ${key} tx failed on iteration ${i + 1}/${count}: ${reason}`);
      }
      const id = presignIdFromEvents(result.Transaction.events);
      if (id) {
        pools[key]!.push(id);
        added++;
      } else {
        console.warn(`[presign-pool] iteration ${i + 1}: tx succeeded but no presign_id found in events. raw events shape:`, JSON.stringify(result.Transaction.events, null, 2)?.slice(0, 2000));
      }
      // brief pause between iterations so the indexer reflects mutated coin versions
      if (i < count - 1) await new Promise((r) => setTimeout(r, 1500));
    }
    await savePools(vaultId, pools);
    return { added };
  });
}

export async function takePresign(key: PresignPoolKey): Promise<string | undefined> {
  const vaultId = requireVaultId();
  const pools = await loadPools(vaultId);
  const id = pools[key]?.shift();
  await savePools(vaultId, pools);
  return id;
}

// backward-compat wrappers used by existing EVM signing code
export const replenishPresignPool = (count = 3) => replenishPool('SECP256K1_ECDSA', count);
export const takePresignId = () => takePresign('SECP256K1_ECDSA');
