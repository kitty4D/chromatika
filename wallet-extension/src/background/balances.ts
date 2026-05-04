import { PublicKey } from '@solana/web3.js';
import { ikaCoinType, getFundingReadiness } from '@/background/ika/coins';
import { resolveCanonicalSuiReceiveAddress } from '@/background/identity';
import { getVaultNetworkSettings } from '@/background/network/tier-network-settings';
import { getSession } from '@/background/session';
import { resolveBuiltinSolanaPreset } from '@/config/networks';
import { graphqlUrlForNetwork } from '@/config/sui';
import { isSuiGraphqlDebugEnabled } from '@/background/sui-graphql-debug-fetch';
import { getSuiFeePayerSuiAddress } from '@/background/sui/sui-fee-payer-signing';

const SUI_TYPE = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';

function isSolanaRpcLikelyBlockedError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    /\b403\b/.test(m) ||
    /\b401\b/.test(m) ||
    m.includes('access forbidden') ||
    m.includes('forbidden') ||
    m.includes('unauthorized')
  );
}

/** MV3 service workers suspend; graphql can hang - fail fast so the ui can show an error instead of spinning forever */
const BALANCE_FETCH_TIMEOUT_MS = 45_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) => {
      setTimeout(() => rej(new Error(`${label} timed out after ${ms / 1000}s — check network or retry`)), ms);
    }),
  ]);
}

/**
 * vault chrome summary: fee-payer SUI + IKA (+ ika funding readiness) via `vaultSuiClient` GraphQL,
 * or Solana fee-payer lamports when `activeVaultBaseChain === 'solana'`.
 * not a multi-chain portfolio: EVM/BTC/etc. native on dWallet cards comes from `getDwalletHomeGasMany` / `getDwalletHomeGas` (JSON-RPC / esplora).
 */
export async function getTrpcBalanceSummary() {
  const s = getSession();
  if (!s) return { locked: true as const };

  if (s.activeVaultBaseChain === 'solana') {
    // hardware vaults paired via WC/MWA may have no in-extension keypair if the user picked
    // `seeker_direct` mode; those vaults still have `solanaWcAccount` / `solanaMwaAccount` for
    // chain signing. the "fee payer material" guard below tolerates that case.
    const seekerAddr = s.solanaWcAccount?.address ?? s.solanaMwaAccount?.address ?? null;
    if (!(s.solanaFeePayer || s.solanaLedgerFee || seekerAddr)) {
      throw new Error(
        'Solana ika vault is missing fee payer material (software key, Ledger fee identity, or paired phone wallet). Re-import or fix hardware linkage, then retry.',
      );
    }
    const vaultNet = await getVaultNetworkSettings(s.activeVaultId, {
      network: s.network,
      baseChain: 'solana',
    });
    const solNetworkId = vaultNet.solana.solNetworkId;
    const solPreset = resolveBuiltinSolanaPreset(solNetworkId);

    /**
     * canonical user-facing Solana receive address. priority:
     *  1. dWallet ED25519 address: once DKG has run, the user's "Solana wallet" is the dWallet.
     *  2. Seeker pubkey: for hardware vaults pre-DKG; users send/receive Solana to this address
     *     until they've completed dWallet setup.
     *  3. fee payer address: fallback for HD / imported-key vaults where the fee payer IS the
     *     user's Solana key (mnemonic-derived or imported privkey).
     *
     * the fee payer is reported separately as `feePayerAddress` so management UIs can show
     * it without surfacing it as the user's "wallet address".
     */
    // optional chain on `dwalletMeta` itself: tests can construct a session without it, and
    // pre-DKG vaults legitimately have no ED25519 entry yet.
    const ed25519DwalletId = s.dwalletMeta?.ED25519?.dwalletId;
    const ed25519PublicKeyB64 = s.dwalletMeta?.ED25519?.dwalletPublicKeyB64;
    let canonicalSource: 'dwallet_ed25519_active' | 'seeker_pubkey' | 'solana_fee_payer';
    let canonicalAddr: string;
    if (ed25519DwalletId && ed25519PublicKeyB64) {
      // dWallet base58 address. use the stored dwalletId (which already IS the base58 PDA on Solana).
      canonicalAddr = ed25519DwalletId;
      canonicalSource = 'dwallet_ed25519_active';
    } else if (seekerAddr) {
      canonicalAddr = seekerAddr;
      canonicalSource = 'seeker_pubkey';
    } else {
      const feePk = s.solanaFeePayer?.publicKey ?? new PublicKey(s.solanaLedgerFee!.feePayerPubkeyB58);
      canonicalAddr = feePk.toBase58();
      canonicalSource = 'solana_fee_payer';
    }

    const feePayerPk =
      s.solanaFeePayer?.publicKey ??
      (s.solanaLedgerFee ? new PublicKey(s.solanaLedgerFee.feePayerPubkeyB58) : null);
    const feePayerAddrForReport = feePayerPk?.toBase58() ?? canonicalAddr;

    let lamportsStr = '0';
    let solanaBalanceFetchDegraded = false;
    let solanaBalanceWarning: string | undefined;
    if (s.solanaConnection) {
      try {
        const lamports = await withTimeout(
          s.solanaConnection.getBalance(new PublicKey(canonicalAddr)),
          BALANCE_FETCH_TIMEOUT_MS,
          'solana balance fetch',
        );
        lamportsStr = String(lamports);
      } catch (e) {
        const base = e instanceof Error ? e.message : String(e);
        if (isSolanaRpcLikelyBlockedError(base)) {
          solanaBalanceFetchDegraded = true;
          solanaBalanceWarning =
            `Solana RPC blocked or denied balance reads (try devnet + custom RPC in settings). ${base.slice(0, 120)}`;
        } else {
          throw new Error(`${base} · solana ${solPreset.name} address ${canonicalAddr.slice(0, 8)}…`);
        }
      }
    }
    const lamports = Number(lamportsStr);
    return {
      locked: false as const,
      ikaBase: 'solana' as const,
      /** Sui ika package network (mainnet/testnet) for shared `IkaClient`: not the Solana cluster. */
      network: s.network,
      solanaNetworkId: solNetworkId,
      solanaRpcUrl: solPreset.rpcUrl,
      feePayerAddress: feePayerAddrForReport,
      canonicalReceiveAddress: canonicalAddr,
      canonicalSource,
      address: canonicalAddr,
      sui: '0',
      ika: '0',
      solanaLamports: lamportsStr,
      solanaRpcMissing: !s.solanaConnection,
      solanaBalanceFetchDegraded,
      ...(solanaBalanceWarning ? { solanaBalanceWarning } : {}),
      /** ika pre-alpha: mock signer; devnet only - see repo CLAUDE.md disclaimer */
      solanaPreAlpha: true as const,
      funding: {
        ready: lamports > 0,
        missing: [] as ('sui' | 'ika')[],
      },
    };
  }

  // --- Sui ika base (or Solana vault fell through should be impossible after guard above) ---
  const owner = getSuiFeePayerSuiAddress(s);
  const ikaType = ikaCoinType(s.ikaClient.ikaConfig);
  const graphqlUrl = graphqlUrlForNetwork(s.network);

  try {
    const summary = await withTimeout(
      Promise.all([
        s.vaultSuiClient.getBalance({ owner, coinType: SUI_TYPE }),
        s.vaultSuiClient.getBalance({ owner, coinType: ikaType }).catch(() => ({ balance: { balance: '0' } })),
        getFundingReadiness(s.vaultSuiClient, s.ikaClient.ikaConfig, owner),
        resolveCanonicalSuiReceiveAddress(s),
      ]),
      BALANCE_FETCH_TIMEOUT_MS,
      'balance fetch',
    );
    const [suiBal, ikaBal, funding, identity] = summary;
    return {
      locked: false as const,
      ikaBase: 'sui' as const,
      network: s.network,
      feePayerAddress: owner,
      canonicalReceiveAddress: identity.address,
      canonicalSource: identity.source,
      /** @deprecated use canonicalReceiveAddress + feePayerAddress */
      address: identity.address,
      sui: suiBal.balance.balance,
      ika: ikaBal.balance.balance,
      funding,
    };
  } catch (e) {
    const base = e instanceof Error ? e.message : String(e);
    const shortOwner = `${owner.slice(0, 12)}…`;
    const hint =
      ` · graphql ${graphqlUrl} · network ${s.network} · gas addr ${shortOwner}` +
      (isSuiGraphqlDebugEnabled()
        ? ' · see extension service worker console for [chromatika graphql] lines'
        : ' · add VITE_DEBUG_GRAPHQL=true and rebuild for detailed GraphQL logs');
    const wrapped = new Error(`${base}${hint}`);
    (wrapped as Error & { cause?: unknown }).cause = e;
    throw wrapped;
  }
}
