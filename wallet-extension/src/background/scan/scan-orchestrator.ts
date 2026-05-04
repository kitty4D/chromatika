/**
 * scan orchestrator: takes a `ScanInput` + chain selection, runs probes against every candidate,
 * aggregates the results into a `ScanResult` for the UI.
 *
 * - **HD**: builds candidates 0..hardLimit. probes them in order. stops once `gap` consecutive
 *   "empty" candidates (no activity, no dwallets) are seen past the last hit. the default slot
 *   (account 0) is always included even if empty. matches bip44 account discovery.
 * - **passkey / seeker / waap / lazor**: single candidate, all opted-in chains probed in parallel.
 *
 * dwallet count = owned-cap count for the candidate's primary sui address (or solana pda for
 * solana-base). queried once per candidate. v1 doesn't match per ika encryption index - the
 * count is what users read first, and per-index matching is a future precision feature.
 *
 * concurrency: probes for one (candidate, chain) pair run in parallel; HD candidates run
 * sequentially to keep the rpc fan-out bounded (gap_limit * num_chains can be big).
 */

import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { BUILTIN_SUI } from '@/config/networks';
import { buildDefaultProbes, buildSuperProProbes } from '@/background/scan/scan-probes';
import { buildCandidates } from '@/background/scan/scan-derivations';
import type {
  ChainProbe,
  ScanCandidate,
  ScanCandidateRow,
  ScanChainSelection,
  ScanGapLimits,
  ScanInput,
  ScanProbeResult,
  ScanResult,
} from '@/background/scan/scan-types';

const DEFAULT_ACCOUNT_GAP = 5;
const PROBE_TIMEOUT_MS = 12_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/**
 * count owned dwallet caps for a sui address by querying owned objects of the cap type. uses
 * the same approach as `collectOwnedCaps` in dwallet-discovery.ts but standalone (no session
 * dependency, since the scan runs before any vault is unlocked).
 *
 * **conservative**: returns 0 on any error. the user still sees activity probes for sui mainnet,
 * which should reveal whether they have dwallet activity even if the cap query stumbles.
 */
async function countOwnedDwalletCaps(suiAddress: string): Promise<number> {
  try {
    const def = BUILTIN_SUI.find((n) => n.id === 'sui-mainnet');
    if (!def) return 0;
    const client = new SuiGraphQLClient({ url: def.rpcUrl, network: 'mainnet' });
    // dwallet cap type pattern is `<package>::<module>::DWalletCap`. we filter by the cap struct
    // tag suffix rather than full package id so this works across ika package upgrades.
    const res = await client.query({
      query: /* graphql */`
        query OwnedCaps($owner: SuiAddress!) {
          address(address: $owner) {
            objects(first: 50) {
              nodes {
                contents {
                  type { repr }
                }
              }
            }
          }
        }
      `,
      variables: { owner: suiAddress },
    }) as { data?: { address?: { objects?: { nodes?: Array<{ contents?: { type?: { repr?: string } } }> } } } };
    const nodes = res.data?.address?.objects?.nodes ?? [];
    let count = 0;
    for (const n of nodes) {
      const repr = n.contents?.type?.repr ?? '';
      // catches `0xPKG::dwallet_2pc_mpc::DWalletCap` and any future cap-type renames that keep the
      // `DWalletCap` suffix. broad enough to survive ika package id rotations.
      if (/::DWalletCap\b/.test(repr) || /::CapHeader\b/.test(repr)) count += 1;
    }
    return count;
  } catch {
    return 0;
  }
}

async function probeOne(
  candidate: ScanCandidate,
  probes: ChainProbe[],
  warnings: string[],
): Promise<ScanProbeResult[]> {
  const tasks = probes.map(async (p) => {
    const addr = p.addressFor(candidate);
    if (!addr) return null;
    try {
      const r = await withTimeout(p.probe(addr), PROBE_TIMEOUT_MS, `${p.chainName} probe`);
      return {
        chainId: p.chainId,
        chainName: p.chainName,
        address: addr,
        ...r,
      } as ScanProbeResult;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      warnings.push(`${p.chainName} (${addr}): ${msg}`);
      return {
        chainId: p.chainId,
        chainName: p.chainName,
        address: addr,
        hasActivity: false,
        error: msg,
      } as ScanProbeResult;
    }
  });
  const results = await Promise.all(tasks);
  return results.filter((r): r is ScanProbeResult => r !== null);
}

function rowHasActivity(row: ScanCandidateRow): boolean {
  if (row.dwalletCount > 0) return true;
  for (const p of row.probes) {
    if (p.hasActivity) return true;
    if (p.balanceSmallest && p.balanceSmallest > 0n) return true;
    if (typeof p.txCount === 'number' && p.txCount > 0) return true;
  }
  return false;
}

export async function runScan(
  input: ScanInput,
  chains: ScanChainSelection,
  gap: ScanGapLimits = {},
): Promise<ScanResult> {
  const t0 = Date.now();
  const warnings: string[] = [];
  const notes: string[] = [];
  const probes: ChainProbe[] = [];
  if (chains.defaults) probes.push(...buildDefaultProbes());
  if (chains.superProChainIds?.length) probes.push(...buildSuperProProbes(chains.superProChainIds));

  const allCandidates = buildCandidates(input, gap);
  const accountGap = gap.accountIndexGap ?? DEFAULT_ACCOUNT_GAP;
  const rows: ScanCandidateRow[] = [];

  // setup-time notes: surface the lazor placeholder-PDA case loudly so the user understands why
  // solana probes might be skipped. happens BEFORE any RPC calls go out.
  if (input.method === 'lazor' && allCandidates[0]?.solanaAddress === undefined) {
    notes.push(
      'lazor smart-wallet PDA not yet resolved (chromatika v1 stores the passkey pubkey as a placeholder); solana probes skipped. signing flows resolve the canonical PDA via Lazor\'s `getSmartWalletByCredentialHash` - that fix lands in a follow-up slice.',
    );
  }

  let consecutiveEmpty = 0;
  let lastHitIdx = -1;
  for (let i = 0; i < allCandidates.length; i++) {
    const c = allCandidates[i]!;
    const isDefaultSlot = (c.accountIndex ?? 0) === 0;

    // probe + count caps in parallel.
    const [probeResults, dwalletCount] = await Promise.all([
      probeOne(c, probes, warnings),
      c.suiAddress ? countOwnedDwalletCaps(c.suiAddress) : Promise.resolve(0),
    ]);
    const row: ScanCandidateRow = {
      candidate: c,
      probes: probeResults,
      dwallets: [], // v1: count only, no per-cap listing yet
      dwalletCount,
      hasAnyActivity: false,
      isDefaultSlot,
    };
    row.hasAnyActivity = rowHasActivity(row);
    rows.push(row);

    if (input.method === 'hd') {
      if (row.hasAnyActivity) {
        consecutiveEmpty = 0;
        lastHitIdx = i;
      } else {
        consecutiveEmpty += 1;
      }
      // stop once `gap` consecutive misses past the last hit. always include up to lastHitIdx + gap.
      if (consecutiveEmpty >= accountGap && lastHitIdx >= 0 && i >= lastHitIdx + accountGap) break;
      // for HD with no hits at all, we still scan up to gap rows and stop (the default slot is
      // always row 0).
      if (lastHitIdx === -1 && i + 1 >= accountGap) break;
    }
  }

  // suggest: default slot + every active row.
  const suggestedKeys = rows.filter((r) => r.isDefaultSlot || r.hasAnyActivity).map((r) => r.candidate.key);

  return {
    method: input.method,
    rows,
    suggestedKeys,
    elapsedMs: Date.now() - t0,
    warnings,
    notes,
  };
}
