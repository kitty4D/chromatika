// micro-USD bigint -> display string. compact uses hand-rolled k/M because Intl's
// 'compact' notation gives lowercase 'k' which looks weird next to the rocket-gauge
// chrome. partial probes get a leading ~ to signal "incomplete sum".

export type VaultTotalDisplayInput = {
  usdMicros: bigint;
  partial: boolean;
};

export type VaultTotalFormat = 'compact' | 'exact';

const ONE_THOUSAND_MICROS = 1_000_000_000n;
const ONE_MILLION_MICROS = 1_000_000_000_000n;

function microsToFloat(micros: bigint): number {
  return Number(micros) / 1_000_000;
}

function exactFormat(micros: bigint): string {
  const usd = microsToFloat(micros);
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function compactFormat(micros: bigint): string {
  if (micros < ONE_THOUSAND_MICROS) return exactFormat(micros);
  if (micros < ONE_MILLION_MICROS) {
    const k = microsToFloat(micros) / 1000;
    return `$${k.toFixed(1)}K`;
  }
  const m = microsToFloat(micros) / 1_000_000;
  return `$${m.toFixed(1)}M`;
}

export function formatVaultTotalUsd(
  input: VaultTotalDisplayInput,
  format: VaultTotalFormat,
): string {
  const body = format === 'compact' ? compactFormat(input.usdMicros) : exactFormat(input.usdMicros);
  return input.partial ? `~${body}` : body;
}

export type VaultTieredTotalsInput = {
  mainnetUsdMicros: bigint;
  testnetUsdMicros: bigint;
  partial: boolean;
};

/** format the mainnet + testnet rows for the BTTF time-circuits readout. */
export function formatVaultTieredTotals(
  input: VaultTieredTotalsInput,
  format: VaultTotalFormat,
): { mainnetText: string; testnetText: string } {
  const fmt = (m: bigint) => (format === 'compact' ? compactFormat(m) : exactFormat(m));
  const mainnetBody = fmt(input.mainnetUsdMicros);
  const testnetBody = fmt(input.testnetUsdMicros);
  return {
    mainnetText: input.partial ? `~${mainnetBody}` : mainnetBody,
    testnetText: input.partial ? `~${testnetBody}` : testnetBody,
  };
}
