/**
 * EVM transaction building, signing via ika MPC, and broadcasting.
 * `signBytesEvm` returns compact r||s (64 bytes) after `parseSignatureFromSignOutput`.
 * we try both recovery bits and pick the one that restores our address.
 */

import {
  JsonRpcProvider,
  Transaction,
  Signature,
  keccak256,
  getBytes,
  recoverAddress,
  hexlify,
} from 'ethers';
import { signBytesEvm } from '@/background/chains/signing';
import { getEvmAddress, getEvmAddressForOrigin } from '@/background/chains/evm';
import { enqueueHardwareSign } from '@/background/hardware/pending-queue';
import { findLedgerEvmAccount } from '@/background/hardware/accounts';
import { getActiveNetworks } from '@/background/network/active-network';
import { getCustomNetworks } from '@/background/network/custom-networks';
import { findEvmNetwork } from '@/config/networks';
import { orderRpcUrlsByLatency, recordRpcError, recordRpcSuccess } from '@/background/chains/evm-rpc-health';
import { setSigningProgress, clearSigningProgress } from '@/background/signing-progress';
import { ikaTxBenchEnabled } from '@/lib/ika-tx-bench-env';
import { IkaTxBenchSession } from '@/background/ika/ika-tx-benchmark';
import { getSession } from '@/background/session';
import { recordSignedTx } from '@/background/services/tx-record';

/**
 * ankr now requires an API key on `rpc.ankr.com/eth` (returns 401), so try keyless mainnet RPCs first
 * and keep Ankr last as a sometimes-still-working fallback. publicnode stays for chain ids beyond mainnet.
 */
const CHAIN_FALLBACK_RPC: Record<number, string[]> = {
  1: [
    'https://eth.llamarpc.com',
    'https://ethereum.publicnode.com',
    'https://rpc.ankr.com/eth',
  ],
  10: ['https://optimism.publicnode.com'],
  56: ['https://bsc-rpc.publicnode.com'],
  137: ['https://polygon-bor-rpc.publicnode.com'],
  8453: ['https://base-rpc.publicnode.com'],
  42161: ['https://arbitrum-one.publicnode.com'],
};

function rpcCandidates(chainId: number, primary: string): string[] {
  const list = [primary, ...(CHAIN_FALLBACK_RPC[chainId] ?? [])];
  return [...new Set(list)];
}

/** max gas limit we accept from a dapp or use as an upper bound for padded estimates. */
const DAPP_GAS_CAP = 30_000_000n;
/** when every RPC estimate fails and the dapp did not supply gas. */
const CONSERVATIVE_GAS_FALLBACK = 1_500_000n;

function parseNonceParam(s: string): number {
  let bi: bigint;
  try {
    bi = BigInt(s.trim());
  } catch {
    throw new Error(`Invalid transaction nonce: ${s}`);
  }
  if (bi < 0n) throw new Error(`Invalid transaction nonce: ${s}`);
  if (bi > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Transaction nonce is too large for this wallet (exceeds safe integer range)');
  }
  return Number(bi);
}

/**
 * try estimateGas on each RPC (latency-ordered). used for sends and simulation.
 */
export async function estimateEvmGasAcrossRpcs(
  chainId: number,
  primaryRpcUrl: string,
  tx: { from: string; to?: string | null; value: bigint; data: string },
): Promise<{ gas: bigint | null; lastError: string }> {
  const rawUrls = rpcCandidates(chainId, primaryRpcUrl);
  const urls = await orderRpcUrlsByLatency(chainId, rawUrls);
  let lastErr = '';
  for (const rpcUrl of urls) {
    try {
      const p = new JsonRpcProvider(rpcUrl);
      const estimated = await p.estimateGas({
        from: tx.from,
        to: tx.to ?? undefined,
        value: tx.value,
        data: tx.data,
      });
      const capped = estimated > DAPP_GAS_CAP ? DAPP_GAS_CAP : estimated;
      return { gas: capped, lastError: '' };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  return { gas: null, lastError: lastErr };
}

export async function resolveGasLimitWithFallback(
  chainId: number,
  primaryRpcUrl: string,
  from: string,
  to: string | null,
  value: bigint,
  data: string,
  dappGasHex: string | null | undefined,
): Promise<{ gasLimit: bigint; note?: string; estimateErr?: string }> {
  const { gas, lastError } = await estimateEvmGasAcrossRpcs(chainId, primaryRpcUrl, {
    from,
    to,
    value,
    data,
  });
  if (gas != null) {
    const padded = (gas * 12n) / 10n;
    return { gasLimit: padded > DAPP_GAS_CAP ? DAPP_GAS_CAP : padded };
  }
  if (dappGasHex) {
    let g: bigint;
    try {
      g = BigInt(dappGasHex);
    } catch {
      throw new Error(`Invalid gas limit from dapp: ${dappGasHex}`);
    }
    if (g <= 0n) throw new Error('Invalid gas limit from dapp');
    if (g > DAPP_GAS_CAP) throw new Error(`Gas limit from dapp exceeds wallet cap (${DAPP_GAS_CAP})`);
    return {
      gasLimit: g,
      note: `Gas estimate failed on all RPCs, using dapp-provided limit (${g}). ${lastError ? lastError.slice(0, 220) : ''}`,
      estimateErr: lastError,
    };
  }
  return {
    gasLimit: CONSERVATIVE_GAS_FALLBACK,
    note: `Gas estimate failed on all RPCs, using conservative limit ${CONSERVATIVE_GAS_FALLBACK}. Actual cost depends on execution, the tx may still revert. ${lastError ? lastError.slice(0, 220) : ''}`,
    estimateErr: lastError,
  };
}

export type FilledEvmTx =
  | {
      kind: 'eip1559';
      to: string | null;
      value: bigint;
      data: string;
      nonce: number;
      gasLimit: bigint;
      maxFeePerGas: bigint;
      maxPriorityFeePerGas: bigint;
      chainId: number;
      gasFillNote?: string;
    }
  | {
      kind: 'legacy';
      to: string | null;
      value: bigint;
      data: string;
      nonce: number;
      gasLimit: bigint;
      gasPrice: bigint;
      chainId: number;
      gasFillNote?: string;
    };

function isRetryableRpcError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('network') ||
    msg.includes('timeout') ||
    msg.includes('econn') ||
    msg.includes('failed to fetch') ||
    msg.includes('429') ||
    msg.includes('503') ||
    // ethers JsonRpcProvider: empty / truncated HTTP body
    msg.includes('unexpected end of') ||
    msg.includes('invalid json') ||
    msg.includes('json parse')
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function applyLedgerSigToTx(
  tx: Transaction,
  unsignedBytes: Uint8Array,
  fromAddress: string,
  sigHex: string,
): void {
  const h = sigHex.replace(/^0x/i, '');
  if (h.length < 130) throw new Error('invalid Ledger signature length');
  const r = `0x${h.slice(0, 64)}`;
  const s = `0x${h.slice(64, 128)}`;
  const vReported = parseInt(h.slice(128, 130), 16);
  const txHash = keccak256(unsignedBytes);
  const candidates: number[] = [vReported, 27, 28];
  if (vReported >= 27) {
    candidates.push(vReported - 27 + 27, vReported - 27 + 28);
  }
  const uniq = [...new Set(candidates)];
  for (const v of uniq) {
    try {
      const sig = Signature.from({ r, s, v });
      if (recoverAddress(txHash, sig).toLowerCase() === fromAddress.toLowerCase()) {
        tx.signature = sig;
        return;
      }
    } catch {
      /* try next v */
    }
  }
  throw new Error('could not recover Ledger EVM transaction signature');
}

export async function getRpcProvider(): Promise<{ provider: JsonRpcProvider; chainId: number; rpcUrl: string }> {
  const { evmChainId } = await getActiveNetworks();
  return getRpcProviderForChain(evmChainId);
}

export async function getRpcProviderForChain(
  chainId: number,
): Promise<{ provider: JsonRpcProvider; chainId: number; rpcUrl: string }> {
  const { evm: customEvm } = await getCustomNetworks();
  const network = findEvmNetwork(chainId, customEvm);
  if (!network) throw new Error(`No RPC config for chainId ${chainId}`);
  const provider = new JsonRpcProvider(network.rpcUrl);
  return { provider, chainId, rpcUrl: network.rpcUrl };
}

export async function sendEvmRpcWithRetry(
  chainId: number,
  primaryRpcUrl: string,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const rawUrls = rpcCandidates(chainId, primaryRpcUrl);
  const urls = await orderRpcUrlsByLatency(chainId, rawUrls);
  let lastErr: unknown;
  for (const rpcUrl of urls) {
    const provider = new JsonRpcProvider(rpcUrl);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const t0 = performance.now();
        const res = await provider.send(method, params);
        await recordRpcSuccess(chainId, rpcUrl, Math.round(performance.now() - t0));
        return res;
      } catch (err) {
        lastErr = err;
        await recordRpcError(chainId, rpcUrl, err);
        if (!isRetryableRpcError(err) || attempt === 1) break;
        await sleep(250 * (attempt + 1));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? 'rpc request failed'));
}

/** broadcast a signed serialized tx, rotating/failing over like `sendEvmRpcWithRetry` (single-URL `broadcastTransaction` flakes on empty bodies). */
export async function broadcastSignedEvmTxWithRetry(
  chainId: number,
  primaryRpcUrl: string,
  serialized: string,
): Promise<string> {
  const res = await sendEvmRpcWithRetry(chainId, primaryRpcUrl, 'eth_sendRawTransaction', [serialized]);
  if (typeof res !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(res)) {
    throw new Error(`unexpected eth_sendRawTransaction result: ${String(res)}`);
  }
  return res;
}

export type EvmTxParams = {
  to: string | null;
  value: string;           // hex
  data: string;            // hex
  gas: string | null;      // hex gas limit
  maxFeePerGas: string | null;
  maxPriorityFeePerGas: string | null;
  gasPrice: string | null;
  nonce: string | null;
  /** when set, use this chain for rpc + tx `chainId` instead of the wallet active evm network. */
  chainId?: number | null;
  /** when set, signing uses this origin's per-site SECP dWallet (see dapp permissions). */
  dappOrigin?: string;
  /** when `VITE_IKA_TX_BENCH=true`, copied into the benchmark JSON (e.g. `{ source: 'dapp_eth_sendTransaction' }`). */
  ikaBenchContext?: Record<string, unknown>;
};

/** fill in missing nonce, gasLimit, fee params from RPC. returns filled params. */
export async function completeTxParams(
  params: EvmTxParams,
  fromAddress: string,
  rpc: { provider: JsonRpcProvider; chainId: number; rpcUrl: string },
): Promise<FilledEvmTx> {
  const { provider, chainId, rpcUrl } = rpc;

  const nonce =
    params.nonce != null && params.nonce !== ''
      ? parseNonceParam(params.nonce)
      : await provider.getTransactionCount(fromAddress, 'latest');

  const feeData = await provider.getFeeData();
  const block = await provider.getBlock('latest');
  const baseFee = block?.baseFeePerGas ?? null;
  const networkSupports1559 = baseFee != null && baseFee > 0n;

  const has1559Params = Boolean(
    (params.maxFeePerGas && BigInt(params.maxFeePerGas) > 0n) ||
      (params.maxPriorityFeePerGas && BigInt(params.maxPriorityFeePerGas) > 0n),
  );
  const dappLegacyPrice =
    params.gasPrice != null &&
    params.gasPrice !== '' &&
    params.gasPrice !== '0x0' &&
    BigInt(params.gasPrice) > 0n;

  const useLegacy = !networkSupports1559 || (dappLegacyPrice && !has1559Params);

  const value = BigInt(params.value || '0x0');
  const to = params.to ?? null;
  const data = params.data || '0x';

  const { gasLimit, note: gasFillNote } = await resolveGasLimitWithFallback(
    chainId,
    rpcUrl,
    fromAddress,
    to,
    value,
    data,
    params.gas,
  );

  if (useLegacy) {
    const gasPrice =
      dappLegacyPrice
        ? BigInt(params.gasPrice!)
        : (feeData.gasPrice ?? feeData.maxFeePerGas ?? 20_000_000_000n);
    return {
      kind: 'legacy',
      to,
      value,
      data,
      nonce,
      gasLimit,
      gasPrice: (gasPrice * 11n) / 10n,
      chainId,
      gasFillNote,
    };
  }

  const maxFeePerGas = params.maxFeePerGas
    ? BigInt(params.maxFeePerGas)
    : ((feeData.maxFeePerGas ?? feeData.gasPrice ?? 20_000_000_000n) * 12n) / 10n;
  const maxPriorityFeePerGas = params.maxPriorityFeePerGas
    ? BigInt(params.maxPriorityFeePerGas)
    : (feeData.maxPriorityFeePerGas ?? 1_000_000_000n);

  return {
    kind: 'eip1559',
    to,
    value,
    data,
    nonce,
    gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas,
    chainId,
    gasFillNote,
  };
}

export type SignedEvmTxResult = {
  /** hex-encoded signed RLP/serialized tx ready to broadcast (with 0x prefix). */
  signedRawTx: string;
  /** computed tx hash (keccak256 of the serialized signed tx, with 0x prefix). */
  txHash: string;
  /** origin address (the signer). */
  fromAddress: string;
  /** chain id the tx is bound to. */
  chainId: number;
  /** nonce used (after `completeTxParams` resolved it). */
  nonce: number;
  /** gas limit used (after fallback resolution). */
  gasLimit: bigint;
};

/**
 * sign an EVM transaction with ika MPC (or hardware) WITHOUT broadcasting it.
 *
 * use this for the MCP `signTransaction` tool / relayer / bundler / abstract-wallet flows
 * where the caller broadcasts through their own infrastructure. returns the signed serialized
 * tx hex + the tx hash it would settle as. the wallet does NOT touch the network from here,
 * the nonce is reserved on the wallet's view of the chain at sign time, but no submission
 * happens, so a slow caller can race with another tx and find the nonce already used. that's
 * the caller's problem to manage, this function is the tightest possible "produce a signed
 * tx" primitive.
 *
 * mostly mirrors the prepare/sign half of `signAndBroadcastEvm` with the broadcast block
 * removed. skips the bench instrumentation so a future MCP-signTransaction caller doesn't
 * unintentionally show up as a `evm_sign_broadcast` row in the dev bench, we'll add a
 * dedicated `evm_sign_only` parent later if/when this gets benched.
 */
export async function signEvmTxOnly(params: EvmTxParams): Promise<SignedEvmTxResult> {
  setSigningProgress('preparing');
  const fromAddress = params.dappOrigin != null && params.dappOrigin !== ''
    ? await getEvmAddressForOrigin(params.dappOrigin)
    : await getEvmAddress();

  const rpc = params.chainId != null && params.chainId > 0
    ? await getRpcProviderForChain(params.chainId)
    : await getRpcProvider();

  setSigningProgress('fetching-gas');
  const filled = await completeTxParams(params, fromAddress, rpc);
  if (filled.gasFillNote) {
    setSigningProgress('fetching-gas', filled.gasFillNote);
  }

  setSigningProgress('building-tx');
  const tx = filled.kind === 'eip1559'
    ? Transaction.from({
        type: 2,
        to: filled.to ?? undefined,
        value: filled.value,
        data: filled.data,
        nonce: filled.nonce,
        gasLimit: filled.gasLimit,
        maxFeePerGas: filled.maxFeePerGas,
        maxPriorityFeePerGas: filled.maxPriorityFeePerGas,
        chainId: filled.chainId,
      })
    : Transaction.from({
        type: 0,
        to: filled.to ?? undefined,
        value: filled.value,
        data: filled.data,
        nonce: filled.nonce,
        gasLimit: filled.gasLimit,
        gasPrice: filled.gasPrice,
        chainId: filled.chainId,
      });

  const unsignedBytes = getBytes(tx.unsignedSerialized);

  const hw = await findLedgerEvmAccount(fromAddress);
  if (hw) {
    setSigningProgress('waiting-hardware');
    const payloadHex = hexlify(unsignedBytes).replace(/^0x/i, '');
    const sigHex = await enqueueHardwareSign({
      vendor: 'ledger',
      chain: 'evm',
      derivationPath: hw.derivationPath,
      payloadHex,
      kind: 'tx',
    });
    applyLedgerSigToTx(tx, unsignedBytes, fromAddress, sigHex);
  } else {
    // ika applies KECCAK256 to unsignedBytes, signs the tx hash. when the active vault
    // is policy-gated, signBytesEvm dispatches through chromatika_policy. EVM tx sends use
    // HARD policy (Move RLP decoder enforces value on-chain), message signs (personal_sign,
    // EIP-712) use SOFT policy with declared value 0.
    const { resolveEvmDeclaredValueMicros } = await import(
      '@/background/policy-vault/policy-vault-evm-value'
    );
    const declaredValueMicros = await resolveEvmDeclaredValueMicros(unsignedBytes);
    // resolve current ETH price for hard-policy dispatch. soft path ignores this.
    const { getPrice } = await import('@/background/services/price');
    const ethPriceUsd = await getPrice('eth').catch(() => 0);
    const priceMicrosPerEth =
      ethPriceUsd > 0 ? BigInt(Math.round(ethPriceUsd * 1_000_000)) : 0n;
    const { signature: rawSig } = await signBytesEvm(unsignedBytes, filled.chainId, {
      dappOrigin: params.dappOrigin,
      declaredValueMicros,
      isEvmTx: true,
      priceMicrosPerEth,
    });
    setSigningProgress('recovering-v');
    const sigHex = rawSig.startsWith('0x') ? rawSig.slice(2) : rawSig;
    const r = `0x${sigHex.slice(0, 64)}`;
    const s = `0x${sigHex.slice(64, 128)}`;
    const txHash = keccak256(unsignedBytes);
    const sig0 = Signature.from({ r, s, v: 27 });
    const recovered0 = recoverAddress(txHash, sig0);
    const sig = recovered0.toLowerCase() === fromAddress.toLowerCase()
      ? sig0
      : Signature.from({ r, s, v: 28 });
    tx.signature = sig;
  }

  // after signature is set, ethers exposes both the signed serialized hex + tx hash.
  const signedRawTx = tx.serialized;
  const txHash = tx.hash;
  if (!txHash) {
    throw new Error('signed tx has no hash, signature was not applied correctly');
  }

  setSigningProgress('done', txHash);
  setTimeout(clearSigningProgress, 5000);

  return {
    signedRawTx,
    txHash,
    fromAddress,
    chainId: filled.chainId,
    nonce: filled.nonce,
    gasLimit: filled.gasLimit,
  };
}

/**
 * sign an EVM transaction with ika MPC and broadcast it.
 * returns the transaction hash.
 */
export async function signAndBroadcastEvm(params: EvmTxParams): Promise<string> {
  const bench = ikaTxBenchEnabled()
    ? new IkaTxBenchSession('evm_sign_broadcast', {
        chainId: params.chainId ?? null,
        dappOrigin: params.dappOrigin ?? null,
        ...params.ikaBenchContext,
      })
    : null;

  let benchOutcome: { ok: true; txHash: string } | { ok: false; error: string } | null = null;

  const finalizeBench = async () => {
    if (!bench) return;
    const outcome =
      benchOutcome ??
      ({ ok: false as const, error: '(no outcome recorded, worker may have been interrupted)' } satisfies {
        ok: false;
        error: string;
      });
    try {
      await bench.finalize(outcome);
    } catch (e) {
      console.error('[chromatika ika bench] finalize failed', e);
    }
  };

  try {
    setSigningProgress('preparing');
    const fromAddress = await (bench
      ? bench.measure('evm.resolve_signer_address', undefined, () =>
          params.dappOrigin != null && params.dappOrigin !== ''
            ? getEvmAddressForOrigin(params.dappOrigin)
            : getEvmAddress(),
        )
      : params.dappOrigin != null && params.dappOrigin !== ''
        ? getEvmAddressForOrigin(params.dappOrigin)
        : getEvmAddress());

    const rpc = await (bench
      ? bench.measure('evm.rpc_provider', undefined, () =>
          params.chainId != null && params.chainId > 0
            ? getRpcProviderForChain(params.chainId)
            : getRpcProvider(),
        )
      : params.chainId != null && params.chainId > 0
        ? getRpcProviderForChain(params.chainId)
        : getRpcProvider());

    setSigningProgress('fetching-gas');
    const filled = await (bench
      ? bench.measure('evm.complete_tx_params', undefined, () => completeTxParams(params, fromAddress, rpc))
      : completeTxParams(params, fromAddress, rpc));
    if (filled.gasFillNote) {
      setSigningProgress('fetching-gas', filled.gasFillNote);
    }

    setSigningProgress('building-tx');
    const tx = bench
      ? bench.measureSync('evm.build_unsigned_transaction', filled.gasFillNote ?? undefined, () =>
          filled.kind === 'eip1559'
            ? Transaction.from({
                type: 2,
                to: filled.to ?? undefined,
                value: filled.value,
                data: filled.data,
                nonce: filled.nonce,
                gasLimit: filled.gasLimit,
                maxFeePerGas: filled.maxFeePerGas,
                maxPriorityFeePerGas: filled.maxPriorityFeePerGas,
                chainId: filled.chainId,
              })
            : Transaction.from({
                type: 0,
                to: filled.to ?? undefined,
                value: filled.value,
                data: filled.data,
                nonce: filled.nonce,
                gasLimit: filled.gasLimit,
                gasPrice: filled.gasPrice,
                chainId: filled.chainId,
              }),
        )
      : filled.kind === 'eip1559'
        ? Transaction.from({
            type: 2,
            to: filled.to ?? undefined,
            value: filled.value,
            data: filled.data,
            nonce: filled.nonce,
            gasLimit: filled.gasLimit,
            maxFeePerGas: filled.maxFeePerGas,
            maxPriorityFeePerGas: filled.maxPriorityFeePerGas,
            chainId: filled.chainId,
          })
        : Transaction.from({
            type: 0,
            to: filled.to ?? undefined,
            value: filled.value,
            data: filled.data,
            nonce: filled.nonce,
            gasLimit: filled.gasLimit,
            gasPrice: filled.gasPrice,
            chainId: filled.chainId,
          });

    const unsignedBytes = getBytes(tx.unsignedSerialized);

    const hw = await (bench
      ? bench.measure('evm.ledger_lookup', undefined, () => findLedgerEvmAccount(fromAddress))
      : findLedgerEvmAccount(fromAddress));
    if (hw) {
      setSigningProgress('waiting-hardware');
      const payloadHex = hexlify(unsignedBytes).replace(/^0x/i, '');
      const sigHex = await (bench
        ? bench.measure('evm.hardware_sign_wait', 'ledger evm tx', () =>
            enqueueHardwareSign({
              vendor: 'ledger',
              chain: 'evm',
              derivationPath: hw.derivationPath,
              payloadHex,
              kind: 'tx',
            }),
          )
        : enqueueHardwareSign({
            vendor: 'ledger',
            chain: 'evm',
            derivationPath: hw.derivationPath,
            payloadHex,
            kind: 'tx',
          }));
      applyLedgerSigToTx(tx, unsignedBytes, fromAddress, sigHex);
      setSigningProgress('broadcasting');
      let txHashOut: string;
      try {
        txHashOut = await (bench
          ? bench.measure('evm.broadcast', `chainId=${filled.chainId}`, () =>
              broadcastSignedEvmTxWithRetry(filled.chainId, rpc.rpcUrl, tx.serialized),
            )
          : broadcastSignedEvmTxWithRetry(filled.chainId, rpc.rpcUrl, tx.serialized));
      } catch (be) {
        const raw = be instanceof Error ? be.message : String(be);
        setSigningProgress('error', `broadcast failed: ${raw}`);
        benchOutcome = { ok: false, error: `EVM broadcast failed: ${raw}` };
        throw new Error(`EVM broadcast failed: ${raw}`);
      }
      setSigningProgress('done', txHashOut);
      benchOutcome = { ok: true, txHash: txHashOut };
      const ledgerSession = getSession();
      if (ledgerSession?.activeVaultId) {
        await recordSignedTx({
          txHash: txHashOut,
          origin: params.dappOrigin ?? null,
          chainId: filled.chainId,
          vaultId: ledgerSession.activeVaultId,
          timestampMs: Date.now(),
          kind: 'evm-send',
        });
      }
      return txHashOut;
    }

    // ika applies KECCAK256 to unsignedBytes, signs the tx hash
    // signBytesEvm reports its own sub-steps via setSigningProgress
    // for policy-gated vaults, declaredValueMicros lets the on-chain cap apply to ETH value.
    // EVM tx hard-mode: pass isEvmTx + priceMicrosPerEth so the Move RLP decoder enforces.
    const { resolveEvmDeclaredValueMicros: resolveDeclaredValueIka } = await import(
      '@/background/policy-vault/policy-vault-evm-value'
    );
    const declaredValueMicrosIka = await resolveDeclaredValueIka(unsignedBytes);
    const { getPrice: getPriceIka } = await import('@/background/services/price');
    const ethPriceUsdIka = await getPriceIka('eth').catch(() => 0);
    const priceMicrosPerEthIka =
      ethPriceUsdIka > 0 ? BigInt(Math.round(ethPriceUsdIka * 1_000_000)) : 0n;
    const { signature: rawSig } = await signBytesEvm(unsignedBytes, filled.chainId, {
      dappOrigin: params.dappOrigin,
      ikaBench: bench ?? undefined,
      declaredValueMicros: declaredValueMicrosIka,
      isEvmTx: true,
      priceMicrosPerEth: priceMicrosPerEthIka,
    });

    setSigningProgress('recovering-v');
    if (bench) {
      bench.measureSync('evm.recover_v_and_apply_sig', undefined, () => {
        const sigHex = rawSig.startsWith('0x') ? rawSig.slice(2) : rawSig;
        const r = `0x${sigHex.slice(0, 64)}`;
        const s = `0x${sigHex.slice(64, 128)}`;
        const txHash = keccak256(unsignedBytes);
        const sig0 = Signature.from({ r, s, v: 27 });
        const recovered0 = recoverAddress(txHash, sig0);
        const sig = recovered0.toLowerCase() === fromAddress.toLowerCase()
          ? sig0
          : Signature.from({ r, s, v: 28 });
        tx.signature = sig;
      });
    } else {
      const sigHex = rawSig.startsWith('0x') ? rawSig.slice(2) : rawSig;
      const r = `0x${sigHex.slice(0, 64)}`;
      const s = `0x${sigHex.slice(64, 128)}`;
      const txHash = keccak256(unsignedBytes);
      const sig0 = Signature.from({ r, s, v: 27 });
      const recovered0 = recoverAddress(txHash, sig0);
      const sig = recovered0.toLowerCase() === fromAddress.toLowerCase()
        ? sig0
        : Signature.from({ r, s, v: 28 });
      tx.signature = sig;
    }

    setSigningProgress('broadcasting');
    let txHashOut: string;
    try {
      txHashOut = await (bench
        ? bench.measure('evm.broadcast', `chainId=${filled.chainId}`, () =>
            broadcastSignedEvmTxWithRetry(filled.chainId, rpc.rpcUrl, tx.serialized),
          )
        : broadcastSignedEvmTxWithRetry(filled.chainId, rpc.rpcUrl, tx.serialized));
    } catch (be) {
      const raw = be instanceof Error ? be.message : String(be);
      setSigningProgress('error', `broadcast failed: ${raw}`);
      benchOutcome = { ok: false, error: `EVM broadcast failed: ${raw}` };
      throw new Error(`EVM broadcast failed: ${raw}`);
    }
    setSigningProgress('done', txHashOut);
    benchOutcome = { ok: true, txHash: txHashOut };
    const ikaSession = getSession();
    if (ikaSession?.activeVaultId) {
      await recordSignedTx({
        txHash: txHashOut,
        origin: params.dappOrigin ?? null,
        chainId: filled.chainId,
        vaultId: ikaSession.activeVaultId,
        timestampMs: Date.now(),
        kind: 'evm-send',
      });
    }
    return txHashOut;
  } catch (e) {
    setSigningProgress('error', e instanceof Error ? e.message : String(e));
    if (!benchOutcome) {
      benchOutcome = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    throw e;
  } finally {
    try {
      await finalizeBench();
    } catch {
      /* dev-only bench must never mask signing errors */
    }
    // clear after a short delay so the popup can read the final state
    setTimeout(clearSigningProgress, 5000);
  }
}
