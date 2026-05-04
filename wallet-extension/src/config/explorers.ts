export type SuiExplorerPreset = 'suiscan' | 'suivision' | 'custom';
export type SolanaExplorerPreset = 'solscan' | 'solanaExplorer' | 'orb' | 'custom';

export type ExplorerPreferences = {
  sui: {
    preset: SuiExplorerPreset;
    customTemplate?: string;
  };
  solana: {
    preset: SolanaExplorerPreset;
    customTemplate?: string;
  };
};

export type SuiExplorerKind = 'address' | 'object' | 'package' | 'tx' | 'coin';
export type SolanaExplorerKind = 'address' | 'program' | 'tx' | 'token';

export const DEFAULT_EXPLORER_PREFERENCES: ExplorerPreferences = {
  sui: {
    preset: 'suiscan',
  },
  solana: {
    preset: 'solscan',
  },
};

export const SUI_EXPLORER_OPTIONS: Array<{ id: SuiExplorerPreset; label: string }> = [
  { id: 'suiscan', label: 'suiscan' },
  { id: 'suivision', label: 'suivision' },
  { id: 'custom', label: 'custom template' },
];

export const SOLANA_EXPLORER_OPTIONS: Array<{ id: SolanaExplorerPreset; label: string }> = [
  { id: 'solscan', label: 'solscan' },
  { id: 'solanaExplorer', label: 'solana explorer' },
  { id: 'orb', label: 'orb markets' },
  { id: 'custom', label: 'custom template' },
];

function replaceTemplate(
  template: string | undefined,
  vars: Record<string, string>,
): string | null {
  if (!template?.trim()) return null;
  let out = template.trim();
  for (const [key, value] of Object.entries(vars)) {
    out = out.replaceAll(`{${key}}`, encodeURIComponent(value));
  }
  return out;
}

export function suiExplorerNetworkSlug(networkId: string): 'mainnet' | 'testnet' {
  if (networkId === 'sui-testnet') return 'testnet';
  return 'mainnet';
}

export function solanaExplorerCluster(networkId: string): 'mainnet-beta' | 'devnet' | 'testnet' {
  if (networkId === 'sol-testnet') return 'testnet';
  if (networkId === 'sol-devnet') return 'devnet';
  return 'mainnet-beta';
}

/** suiscan-only deep link (traders tab). other explorers may not expose this path. */
export function buildSuiscanCoinTradersUrl(networkId: string, coinType: string): string {
  const network = suiExplorerNetworkSlug(networkId);
  return `https://suiscan.xyz/${network}/coin/${encodeURIComponent(coinType)}/traders`;
}

export function buildSuiExplorerUrl(
  prefs: ExplorerPreferences,
  networkId: string,
  kind: SuiExplorerKind,
  value: string,
): string | null {
  const network = suiExplorerNetworkSlug(networkId);
  const custom = replaceTemplate(prefs.sui.customTemplate, {
    network,
    type: kind,
    id: value,
  });
  if (prefs.sui.preset === 'custom') return custom;

  if (prefs.sui.preset === 'suivision') {
    const base = network === 'mainnet' ? 'https://suivision.xyz' : `https://${network}.suivision.xyz`;
    const path =
      kind === 'address' ? 'address'
      : kind === 'object' ? 'object'
      : kind === 'package' ? 'package'
      : kind === 'coin' ? 'coin'
      : 'txblock';
    return `${base}/${path}/${encodeURIComponent(value)}`;
  }

  const path =
    kind === 'address' ? 'account'
    : kind === 'object' ? 'object'
    : kind === 'package' ? 'package'
    : kind === 'coin' ? 'coin'
    : 'tx';
  return `https://suiscan.xyz/${network}/${path}/${encodeURIComponent(value)}`;
}

export function buildSolanaExplorerUrl(
  prefs: ExplorerPreferences,
  networkId: string,
  kind: SolanaExplorerKind,
  value: string,
): string | null {
  const cluster = solanaExplorerCluster(networkId);
  const custom = replaceTemplate(prefs.solana.customTemplate, {
    cluster,
    type: kind,
    id: value,
  });
  if (prefs.solana.preset === 'custom') return custom;

  if (prefs.solana.preset === 'solanaExplorer') {
    const path = kind === 'tx' ? 'tx' : 'address';
    return `https://explorer.solana.com/${path}/${encodeURIComponent(value)}?cluster=${encodeURIComponent(cluster)}`;
  }

  if (prefs.solana.preset === 'orb') {
    const path =
      kind === 'tx' ? 'tx'
      : kind === 'token' ? 'token'
      : 'address';
    return `https://orbmarkets.io/${path}/${encodeURIComponent(value)}?cluster=${encodeURIComponent(cluster)}`;
  }

  const path =
    kind === 'tx' ? 'tx'
    : kind === 'token' ? 'token'
    : 'account';
  return `https://solscan.io/${path}/${encodeURIComponent(value)}?cluster=${encodeURIComponent(cluster)}`;
}
