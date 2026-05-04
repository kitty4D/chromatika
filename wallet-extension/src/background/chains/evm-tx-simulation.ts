import { JsonRpcProvider } from 'ethers';
import { findEvmNetwork } from '@/config/networks';
import { getCustomNetworks } from '@/background/network/custom-networks';
import { estimateEvmGasAcrossRpcs } from '@/background/chains/evm-send';

const SIM_GAS_BUFFER_NUM = 12n;
const SIM_GAS_BUFFER_DEN = 10n;
const SIM_GAS_CEILING = 30_000_000n;
const SIM_DEFAULT_GAS = 15_000_000n;

export type EvmStaticSimPhase = 'no_network' | 'estimate' | 'call';

export type EvmStaticSimResult =
  | { ok: true; phase: EvmStaticSimPhase; detail: string; rawError?: string }
  | { ok: false; phase: EvmStaticSimPhase; detail: string; rawError: string };

/**
 * cheap pre-sign check: eth_call at latest block. catches most reverts before ika MPC.
 * uses padded estimateGas when possible so deep calls are less likely to false-OOG.
 * does not replace Tenderly-style balance-delta previews (optional follow-up with API keys).
 */
export async function simulateEvmTxStaticCall(opts: {
  chainId: number;
  from: string;
  to: string | null;
  value: string;
  data: string;
}): Promise<EvmStaticSimResult> {
  const { evm: customEvm } = await getCustomNetworks();
  const network = findEvmNetwork(opts.chainId, customEvm);
  if (!network) {
    return {
      ok: false,
      phase: 'no_network',
      detail: `No RPC configured for chain ${opts.chainId}`,
      rawError: `no RPC configured for chain ${opts.chainId}`,
    };
  }
  const provider = new JsonRpcProvider(network.rpcUrl);
  const value = BigInt(opts.value || '0x0');
  const data = opts.data && opts.data !== '0x' ? opts.data : '0x';

  const { gas: est, lastError: estErr } = await estimateEvmGasAcrossRpcs(opts.chainId, network.rpcUrl, {
    from: opts.from,
    to: opts.to,
    value,
    data,
  });

  let gasLimit: bigint;
  let detailPrefix: string;
  if (est != null) {
    gasLimit = (est * SIM_GAS_BUFFER_NUM) / SIM_GAS_BUFFER_DEN;
    if (gasLimit > SIM_GAS_CEILING) gasLimit = SIM_GAS_CEILING;
    detailPrefix = `Using gas limit ${gasLimit} (padded estimate). `;
  } else {
    gasLimit = SIM_DEFAULT_GAS;
    detailPrefix = `Gas estimate failed; simulation used default gas ${gasLimit} (result may differ from a mined tx). ${estErr ? `Estimate error: ${estErr.slice(0, 180)}` : ''} `;
  }

  try {
    await provider.call({
      from: opts.from,
      to: opts.to ?? undefined,
      value,
      data,
      gasLimit,
    });
    return {
      ok: true,
      phase: 'call',
      detail: `${detailPrefix}Static call succeeded at latest block.`,
      rawError: est == null ? estErr : undefined,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      phase: 'call',
      detail: `${detailPrefix}eth_call reverted or RPC error: ${msg}`,
      rawError: msg,
    };
  }
}
