import {
  Curve,
  Hash,
  SignatureAlgorithm,
  IkaTransaction,
  parseSignatureFromSignOutput,
} from '@ika.xyz/sdk';
import { Transaction } from '@mysten/sui/transactions';
import {
  eip191EthereumSignedMessagePreimage,
  personalSignMessageBody,
} from '@/background/chains/evm-eip191';
import { getSession } from '@/background/session';
import type { CurveKey } from '@/background/session';
import { allocateIkaCoinsForOperation } from '@/background/ika/coin-allocation';
import { getSuiFeePayerSuiAddress } from '@/background/sui/sui-fee-payer-signing';
import { replenishPool } from '@/background/ika/presign-pool';
import { getIkaAdapter } from '@/background/ika/ika-adapter';
import { setSigningProgress } from '@/background/signing-progress';
import type { SuiGraphQLClient } from '@mysten/sui/graphql';
import { resolveSecpDwalletIdForDapp } from '@/background/dapp-dwallet-resolve';
import { IKA_SOLANA_SECP_SIGNING_IMPLEMENTED } from '@/background/ika/solana-secp-signing';
import type { IkaTxBenchSession } from '@/background/ika/ika-tx-benchmark';
import { assertNotSolanaBaseForSecpSigning } from '@/background/chains/signing-solana-guard';
import { graphqlUrlForNetwork } from '@/config/sui';
import {
  assertActiveSecpDwallet,
  capIdForDwallet,
  ensureEncryptedShareId,
  ikaBenchMeasure,
  isUpstreamTimeoutError,
  resolveSignSessionId,
  runSignWithRetry,
  sleep,
  takePresignWithAutoRefill,
  tryRecoverSignSession,
  withTransientSuiReadRetry,
} from './internal';
import { signSecp256k1MessageSolanaGrpc } from './solana-grpc';

/**
 * sign raw bytes with secp256k1 + ECDSA + KECCAK256 via ika MPC.
 * used by EVM personal_sign and EIP-712 typed data signing.
 * routes through IkaAdapter so Solana-based dWallets are handled automatically when SDK ships.
 *
 * **policy vault dispatch**: when the active vault has a `chromatika_policy::sign_gate`
 * PolicyVault link (set after opt-in), this function delegates to
 * `signBytesSecpThroughPolicy`, which routes the sign through the on-chain policy module.
 * the MPC network refuses to issue a signature unless the policy's cap + cool-down +
 * non-panicked + actuator checks all pass. caller may pass `declaredValueMicros` via opts,
 * defaults to 0 (counts as zero against the daily cap, suitable for message-sign flows).
 *
 * presign take + auto-refill runs OUTSIDE runSerializedIkaTx to avoid deadlock:
 * replenishPool itself uses runSerializedIkaTx, so calling it from inside the
 * serialized signing zone would deadlock on the non-reentrant mutex.
 */
export async function signBytesEvm(
  msgBytes: Uint8Array,
  _chainId: number = 1,
  opts?: {
    dappOrigin?: string;
    ikaBench?: IkaTxBenchSession;
    /** override for policy-vault dispatch: declared USD value (micro-USD). default 0. */
    declaredValueMicros?: bigint;
    /**
     * when true, msgBytes is an RLP-encoded EVM tx. policy-vault dispatches use
     * `sign_evm_with_policy` (Move RLP decoder, chain-derived value enforced against the
     * cap). when false (default), msgBytes is treated as opaque (personal_sign /
     * EIP-712 / etc.) and uses the soft path with caller's `declaredValueMicros`.
     */
    isEvmTx?: boolean;
    /**
     * EVM tx hard-mode price: micro-USD per ETH. only used when `isEvmTx` is true.
     * caller resolves via `getPrice('eth')` and converts to micro-USD * 1e6.
     */
    priceMicrosPerEth?: bigint;
  },
) {
  setSigningProgress('taking-presign');
  assertNotSolanaBaseForSecpSigning(getSession(), 'evm');
  // policy vault dispatch: opt-in vaults route signing through `sign_with_policy` (soft
  // policy) or `sign_evm_with_policy` (hard policy via Move RLP decoder, only for actual
  // EVM tx signing). the direct path below stops working post-opt-in because the dWallet
  // cap moves into the shared PolicyVault object.
  const { shouldDispatchThroughPolicy, signBytesSecpThroughPolicy } = await import(
    '@/background/policy-vault/policy-vault-sign'
  );
  if (await shouldDispatchThroughPolicy()) {
    const { Hash } = await import('@ika.xyz/sdk');
    return signBytesSecpThroughPolicy({
      message: msgBytes,
      hashScheme: Hash.KECCAK256,
      declaredValueMicros: opts?.declaredValueMicros ?? 0n,
      evmHardPolicy:
        opts?.isEvmTx && typeof opts.priceMicrosPerEth === 'bigint'
          ? { priceMicrosPerEth: opts.priceMicrosPerEth }
          : undefined,
    });
  }
  const ikaBench = opts?.ikaBench;
  const explicitId =
    opts?.dappOrigin != null && opts.dappOrigin !== ''
      ? await ikaBenchMeasure(ikaBench, 'ika.resolve_secp_dwallet_for_dapp', opts.dappOrigin, () =>
          resolveSecpDwalletIdForDapp(opts.dappOrigin!),
        )
      : undefined;
  const result = await runSignWithRetry(
    () =>
      ikaBench
        ? ikaBench.measure('ika.presign_pool_take', 'takePresign + optional refill', () =>
            takePresignWithAutoRefill(
              'SECP256K1_ECDSA',
              'Presign pool empty - auto-refill failed for SECP256K1_ECDSA',
            ),
          )
        : takePresignWithAutoRefill(
            'SECP256K1_ECDSA',
            'Presign pool empty - auto-refill failed for SECP256K1_ECDSA',
          ),
    (presignId) => signBytesEvmCore(msgBytes, _chainId, presignId, explicitId, ikaBench),
  );
  // fire-and-forget: top off the pool after consuming a presign so the next sign is instant
  void replenishPool('SECP256K1_ECDSA', 2).catch(() => {});
  return result;
}

async function signBytesEvmCore(
  msgBytes: Uint8Array,
  _chainId: number,
  presignId: string,
  explicitDwalletId?: string,
  ikaBench?: IkaTxBenchSession,
): Promise<{ signature: string; signId: string }> {
  void _chainId;
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  const curveKey: CurveKey = 'SECP256K1';
  const adapter = getIkaAdapter(s, s.dwalletMeta[curveKey]?.baseChain ?? 'sui');
  const { dWallet, dwalletId } = await ikaBenchMeasure(ikaBench, 'ika.assert_active_secp_dwallet', explicitDwalletId, () =>
    assertActiveSecpDwallet(s, adapter, explicitDwalletId),
  );
  if (IKA_SOLANA_SECP_SIGNING_IMPLEMENTED && s.activeVaultBaseChain === 'solana') {
    void dWallet;
    void ikaBench;
    setSigningProgress('solana-grpc-secp-sign');
    return signSecp256k1MessageSolanaGrpc(msgBytes, presignId, dwalletId, s, 'Keccak256');
  }
  const encShareId = await ikaBenchMeasure(ikaBench, 'ika.ensure_encrypted_share_id', dwalletId, () =>
    ensureEncryptedShareId(s, curveKey, adapter, dwalletId),
  );

  setSigningProgress('waiting-presign', presignId);
  const presign = await ikaBenchMeasure(ikaBench, 'ika.wait_presign_mpc_completed', presignId, () =>
    adapter.getPresignInParticularState(presignId, 'Completed', {
      timeout: 45_000,
    }),
  );
  const encShare = await ikaBenchMeasure(ikaBench, 'ika.fetch_encrypted_user_share', encShareId, () =>
    adapter.getEncryptedUserSecretKeyShare(encShareId),
  );
  // brief pause before coin fetch, the mutex may have just been released by a concurrent
  // presign refill or alarm, and the graphql indexer needs a moment to reflect those mutations
  await ikaBenchMeasure(ikaBench, 'ika.post_mutation_sleep', '1500ms graphql settle', () => sleep(1500));
  const owner = getSuiFeePayerSuiAddress(s);

  setSigningProgress('building-ika-tx');
  const tx = await ikaBenchMeasure(ikaBench, 'ika.ptb_build_approve_request_sign', undefined, async () => {
    const localTx = new Transaction();
    const alloc = await allocateIkaCoinsForOperation(s, adapter, localTx);
    const capId = await capIdForDwallet(adapter, alloc.owner, dwalletId);
    const keys = s.ikaShareKeys[curveKey];
    const ikaTx = new IkaTransaction({
      ikaClient: adapter.ikaClient,
      transaction: localTx as never,
      userShareEncryptionKeys: keys,
    });
    const messageApproval = await ikaTx.approveMessage({
      dWalletCap: capId,
      curve: Curve.SECP256K1,
      signatureAlgorithm: SignatureAlgorithm.ECDSASecp256k1,
      hashScheme: Hash.KECCAK256,
      message: msgBytes,
    });
    const verifiedPresignCap = await ikaTx.verifyPresignCap({ presign: presign as never });
    await ikaTx.requestSign({
      dWallet,
      messageApproval,
      hashScheme: Hash.KECCAK256,
      verifiedPresignCap,
      presign: presign as never,
      encryptedUserSecretKeyShare: encShare,
      message: msgBytes,
      signatureScheme: SignatureAlgorithm.ECDSASecp256k1,
      ikaCoin: alloc.ikaCoin,
      suiCoin: alloc.suiCoin,
    });
    alloc.finalize();
    return localTx;
  });

  setSigningProgress('executing-ika-tx');
  let signId: string | undefined;
  await ikaBenchMeasure(ikaBench, 'ika.execute_signing_ptb_on_sui', undefined, async () => {
    try {
      const result = await adapter.executeTx(s, tx);
      if (result.$kind === 'FailedTransaction') {
        const err = result.FailedTransaction.status.error;
        throw new Error(typeof err === 'string' ? err : JSON.stringify(err));
      }
      const T = result.Transaction;
      signId = await resolveSignSessionId(
        adapter,
        Curve.SECP256K1,
        SignatureAlgorithm.ECDSASecp256k1,
        T.effects,
        T.events,
      );
      if (!signId) throw new Error('Could not resolve Sign session id from transaction effects');
    } catch (execErr) {
      if (isUpstreamTimeoutError(execErr)) {
        // the signing PTB may have committed on chain despite the timeout response,
        // query recent transactions to find the sign session before giving up
        setSigningProgress('executing-ika-tx', 'recovering sign session after timeout…');
        signId = await tryRecoverSignSession(s.suiClient as SuiGraphQLClient, owner, presignId);
      }
      if (!signId) throw execErr;
    }
  });

  setSigningProgress('waiting-signature', signId);
  const gqlUrl = graphqlUrlForNetwork(s.network);
  return ikaBenchMeasure(ikaBench, 'ika.wait_mpc_signature_and_parse', signId, async () => {
    const sign = await withTransientSuiReadRetry(
      () =>
        adapter.getSignInParticularState(
          signId!,
          Curve.SECP256K1,
          SignatureAlgorithm.ECDSASecp256k1,
          'Completed',
          { timeout: 120_000 },
        ),
      { log: { graphqlUrl: gqlUrl, label: 'getSignInParticularState secp256k1 evm' } },
    );
    if (sign.state.$kind !== 'Completed') {
      throw new Error(`Sign session not completed: ${sign.state.$kind}`);
    }
    const raw = Uint8Array.from(sign.state.Completed.signature);
    // ika `IkaClient.getSign` already runs `parseSignatureFromSignOutput` for Completed sessions.
    // feeding compact r||s through wasm again can throw opaque errors (e.g. "unexpected end of input")
    // and wastes transient GraphQL retries on a non-network fault.
    const parsed =
      raw.length === 64
        ? raw
        : await parseSignatureFromSignOutput(
            Curve.SECP256K1,
            SignatureAlgorithm.ECDSASecp256k1,
            raw,
          );
    if (parsed.length !== 64) {
      throw new Error(`unexpected ika secp256k1 signature length ${parsed.length} (expected 64-byte r||s)`);
    }
    const hex = Array.from(parsed, (b) => b.toString(16).padStart(2, '0')).join('');
    return { signature: `0x${hex}`, signId: signId! };
  });
}

/** EVM personal_sign semantics: EIP-191 preimage bytes, then ika KECCAK256 + ECDSA (same digest as `ethers.hashMessage`). */
export async function signMessageEvm(
  message: string,
  chainId: number,
  opts?: { dappOrigin?: string; ikaBench?: IkaTxBenchSession },
) {
  const body = personalSignMessageBody(message);
  return signBytesEvm(eip191EthereumSignedMessagePreimage(body), chainId, opts);
}
