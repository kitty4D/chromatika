#!/usr/bin/env node
/**
 * deploy-sui-policy.mjs - Build + publish the chromatika_policy Move package to Sui.
 *
 * Wraps `sui move build` + `sui client publish` so the chromatika team can deploy with
 * one command instead of remembering the right `--gas-budget` and `--json` flags. Parses
 * the JSON publish response to extract the new packageId and prints the next steps for
 * either pasting it into the chromatika Policy Vault tab "chromatika team only" override
 * input (iteration deploys) or splicing it into `policy-vault-builtin.ts` (audited `:final`).
 *
 * Modules deployed (all under `chromatika_policy/sources/`):
 *   - sign_gate          (the canonical PolicyVault + sign_with_policy + panic + setters)
 *   - sign_gate_evm      (EVM RLP hard-decoder)
 *   - sign_gate_btc      (BTC BIP143 witness-v0 hard-decoder)
 *   - sign_gate_deso     (DeSo v0 binary hard-decoder)
 *
 * Usage:
 *   node scripts/deploy-sui-policy.mjs [--network testnet|mainnet|devnet|localnet]
 *                                       [--gas-budget <mist>] [--build-only] [--dry-run]
 *                                       [--skip-build] [--skip-deps] [--burn-upgrade-cap]
 *
 * Examples:
 *   pnpm run deploy:sui-policy:testnet           # iteration deploy, UpgradeCap retained
 *   pnpm run deploy:sui-policy:mainnet           # iteration deploy, UpgradeCap retained
 *   pnpm run deploy:sui-policy:mainnet:final     # audited production cut: UpgradeCap burned
 *   pnpm run build:sui-policy                    # build-only (sui move build)
 *   pnpm run test:sui-policy                     # sui move test
 *
 * --burn-upgrade-cap is the audited-production-cut flag. After publish, it calls
 * `0x2::package::make_immutable` on the freshly-created UpgradeCap. The package becomes
 * immutable forever; no future upgrades are possible. Use this only when the audit is clean
 * and the bytecode is final. Iteration deploys should keep the UpgradeCap so bugs can be
 * patched via `sui client upgrade`.
 *
 * Prereqs:
 *   - `sui` CLI installed and on PATH (https://docs.sui.io/guides/developer/getting-started/sui-install)
 *   - `sui client envs` includes the target network and an active address with gas
 *
 * Notes:
 *   - The package id is captured from the publish tx's objectChanges of type "published".
 *   - `--build-only` runs `sui move build` and exits; useful for CI smoke runs.
 *   - `--dry-run` runs `sui client publish --dry-run` to estimate gas without spending.
 *   - On Windows + PowerShell, `sui.exe` is invoked via spawnSync(shell=true) so PATH
 *     resolution works the same as `pnpm run`.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { argv, exit, platform } from 'node:process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const PACKAGE_DIR = join(REPO_ROOT, 'move', 'chromatika-policy');

const DEFAULT_GAS_BUDGET = '200000000'; // 0.2 SUI; matches docs/POLICY_VAULT.md runbook

function parseArgs(args) {
  const out = {
    network: null,
    gasBudget: DEFAULT_GAS_BUDGET,
    buildOnly: false,
    dryRun: false,
    skipBuild: false,
    skipDeps: false,
    burnUpgradeCap: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--network') out.network = args[++i];
    else if (a === '--gas-budget') out.gasBudget = args[++i];
    else if (a === '--build-only') out.buildOnly = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--skip-build') out.skipBuild = true;
    else if (a === '--skip-deps') out.skipDeps = true;
    else if (a === '--burn-upgrade-cap') out.burnUpgradeCap = true;
    else if (a === '--help' || a === '-h') {
      console.log(USAGE);
      exit(0);
    }
  }
  return out;
}

const USAGE = `chromatika sui policy deployer
usage:
  node scripts/deploy-sui-policy.mjs [options]

options:
  --network <name>       switch the active sui client env first (testnet/mainnet/devnet/localnet)
  --gas-budget <mist>    gas budget for publish (default ${DEFAULT_GAS_BUDGET})
  --build-only           run \`sui move build\` only (no publish)
  --dry-run              run \`sui client publish --dry-run\` (no on-chain action)
  --skip-build           skip the build step (assume target/ is current)
  --skip-deps            pass --skip-fetch-latest-git-deps to sui (faster local iteration)
  --burn-upgrade-cap     after publish, consume the UpgradeCap via
                         \`0x2::package::make_immutable\`. The package becomes immutable
                         forever and no future upgrades are possible. Use this ONLY for the
                         audited production cut; iteration / test deploys should leave the
                         flag off so bugs can be patched via \`sui client upgrade\`.
  --help, -h             show this message
`;

/**
 * spawn a child process and stream stdout/stderr live. Returns the captured stdout (also
 * passed through to the user's terminal). Throws on non-zero exit.
 *
 * Uses shell=true on Windows so `.exe` extension lookup + PATH resolution works the same
 * way as in PowerShell / cmd.
 */
function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  const useShell = platform === 'win32';
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd ?? process.cwd(),
    stdio: opts.captureStdout ? ['inherit', 'pipe', 'inherit'] : 'inherit',
    shell: useShell,
    encoding: 'utf8',
  });
  if (res.error) {
    throw new Error(`spawn failed: ${res.error.message}`);
  }
  if (res.status !== 0) {
    throw new Error(`${cmd} exited with code ${res.status}`);
  }
  return res.stdout ?? '';
}

function ensureSuiInstalled() {
  const useShell = platform === 'win32';
  const probe = spawnSync('sui', ['--version'], { stdio: 'pipe', shell: useShell, encoding: 'utf8' });
  if (probe.status !== 0) {
    console.error(
      'sui CLI not found on PATH. install from https://docs.sui.io/guides/developer/getting-started/sui-install',
    );
    exit(1);
  }
  console.log(`> sui --version: ${(probe.stdout ?? '').trim()}`);
}

function ensurePackageDir() {
  if (!existsSync(PACKAGE_DIR)) {
    console.error(`expected Move package at ${PACKAGE_DIR} but it does not exist`);
    exit(1);
  }
  if (!existsSync(join(PACKAGE_DIR, 'Move.toml'))) {
    console.error(`no Move.toml in ${PACKAGE_DIR}`);
    exit(1);
  }
}

function maybeSwitchNetwork(network) {
  if (!network) return;
  console.log(`[sui-policy] switching active sui env to "${network}"...`);
  run('sui', ['client', 'switch', '--env', network]);
}

function buildMovePackage(opts) {
  if (opts.skipBuild) {
    console.log('[sui-policy] skipping build (--skip-build)');
    return;
  }
  const args = ['move', 'build'];
  if (opts.skipDeps) args.push('--skip-fetch-latest-git-deps');
  run('sui', args, { cwd: PACKAGE_DIR });
}

/**
 * Parse `sui client publish --json` output for the new package id. The JSON shape we look
 * for: `objectChanges` array with one entry of type "published" carrying a `packageId`.
 *
 * Defensive parsing: dumps the raw JSON to stderr on parse failure so the user can recover.
 */
function extractPackageIdFromPublishJson(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (e) {
    console.error('[sui-policy] could not parse publish JSON output');
    console.error(stdout.slice(0, 2000));
    throw e;
  }
  const changes = parsed.objectChanges ?? parsed.effects?.objectChanges;
  if (!Array.isArray(changes)) {
    console.error('[sui-policy] publish output had no objectChanges array');
    return null;
  }
  for (const c of changes) {
    if (c?.type === 'published' && typeof c.packageId === 'string') {
      return c.packageId;
    }
  }
  return null;
}

/**
 * Extract the freshly-created UpgradeCap object id from a publish tx. The Sui CLI returns
 * `objectChanges` entries of type "created" for the UpgradeCap, with objectType matching
 * `0x2::package::UpgradeCap`. We tolerate the long-form (`0x0000...0002::package::UpgradeCap`)
 * via a suffix check.
 */
function extractUpgradeCapIdFromPublishJson(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (e) {
    return null;
  }
  const changes = parsed.objectChanges ?? parsed.effects?.objectChanges;
  if (!Array.isArray(changes)) return null;
  for (const c of changes) {
    if (
      c?.type === 'created' &&
      typeof c.objectId === 'string' &&
      typeof c.objectType === 'string' &&
      c.objectType.endsWith('::package::UpgradeCap')
    ) {
      return c.objectId;
    }
  }
  return null;
}

function publish(opts) {
  const args = ['client', 'publish', '--gas-budget', opts.gasBudget, '--json'];
  if (opts.dryRun) args.splice(2, 0, '--dry-run');
  if (opts.skipDeps) args.push('--skip-fetch-latest-git-deps');
  // Run from inside the package dir so sui picks up the right Move.toml.
  const stdout = run('sui', args, { cwd: PACKAGE_DIR, captureStdout: true });
  if (opts.dryRun) {
    console.log('[sui-policy] dry-run complete; no on-chain publish was performed.');
    return { packageId: null, upgradeCapId: null, rawStdout: stdout };
  }
  const packageId = extractPackageIdFromPublishJson(stdout);
  if (!packageId) {
    console.error('[sui-policy] published but could not auto-extract packageId from output');
    console.error('full publish stdout follows:');
    console.error(stdout);
    return { packageId: null, upgradeCapId: null, rawStdout: stdout };
  }
  const upgradeCapId = extractUpgradeCapIdFromPublishJson(stdout);
  return { packageId, upgradeCapId, rawStdout: stdout };
}

/**
 * Consume the UpgradeCap via `0x2::package::make_immutable`. This is a separate transaction
 * after publish. If it fails, the package is published but the UpgradeCap is still on the
 * deployer keypair; rerun `make_immutable` manually with the cap id printed below.
 *
 * (We could do publish + make_immutable as a single PTB via `sui client ptb`, but the CLI
 * surface for stitching publish results into a PTB is awkward, and the two-tx form is
 * recoverable: a failed make_immutable just means try again with the printed cap id.)
 */
function burnUpgradeCap(upgradeCapId, opts) {
  if (!upgradeCapId) {
    console.error('[sui-policy] cannot burn UpgradeCap: object id was not found in publish output');
    console.error('[sui-policy] you can find the UpgradeCap by reading the publish tx on chain,');
    console.error('[sui-policy] then run: sui client call --package 0x2 --module package \\');
    console.error('[sui-policy]                          --function make_immutable --args <cap_id> \\');
    console.error(`[sui-policy]                          --gas-budget ${opts.gasBudget}`);
    exit(1);
  }
  console.log('');
  console.log('-----------------------------------------------------------');
  console.log('  burning UpgradeCap (make_immutable)');
  console.log('-----------------------------------------------------------');
  console.log(`  UpgradeCap object: ${upgradeCapId}`);
  console.log('');
  console.log('  WARNING: this consumes the UpgradeCap. After this transaction,');
  console.log('  the package becomes IMMUTABLE FOREVER. No upgrade tx (sui client');
  console.log('  upgrade) will ever succeed against this packageId again. Bugfixes');
  console.log('  will require publishing a fresh immutable package and migrating');
  console.log('  users via the chromatika unwrap + re-wrap flow.');
  console.log('-----------------------------------------------------------');
  console.log('');
  run('sui', [
    'client',
    'call',
    '--package',
    '0x2',
    '--module',
    'package',
    '--function',
    'make_immutable',
    '--args',
    upgradeCapId,
    '--gas-budget',
    opts.gasBudget,
  ]);
  console.log('');
  console.log(`[sui-policy] UpgradeCap ${upgradeCapId} consumed. Package is now immutable.`);
}

function printNextSteps(packageId, opts, upgradeCapId) {
  console.log('');
  console.log('-----------------------------------------------------------');
  console.log('  chromatika_policy published');
  console.log('-----------------------------------------------------------');
  console.log(`  packageId: ${packageId}`);
  if (opts.burnUpgradeCap) {
    console.log('  upgrade authority: BURNED (package is immutable forever)');
  } else if (upgradeCapId) {
    console.log(`  UpgradeCap: ${upgradeCapId} (held on deployer; package is upgradable)`);
  }
  console.log('');
  if (opts.burnUpgradeCap) {
    console.log('  this is an audited production cut. To register it as a built-in market in');
    console.log('  chromatika, paste the packageId into src/background/policy-vault/policy-vault-builtin.ts');
    console.log('  along with the audit hash + audit report link, then ship a chromatika release.');
  } else {
    console.log('  this is a testing / iteration deploy. UpgradeCap stays on the deployer so you');
    console.log('  can patch bugs via `sui client upgrade`. When the package is audit-clean, run');
    console.log('  the same command with --burn-upgrade-cap to publish a fresh immutable copy.');
  }
  console.log('');
  console.log('  the same packageId hosts all four sign_gate modules:');
  console.log('    - sign_gate        (PolicyVault + sign_with_policy + panic + setters + unwrap)');
  console.log('    - sign_gate_evm    (EVM RLP hard-decoder)');
  console.log('    - sign_gate_btc    (BTC BIP143 witness-v0 hard-decoder)');
  console.log('    - sign_gate_deso   (DeSo v0 binary hard-decoder)');
  console.log('-----------------------------------------------------------');
}

function main() {
  const opts = parseArgs(argv.slice(2));
  console.log(`[sui-policy] package dir: ${PACKAGE_DIR}`);
  ensureSuiInstalled();
  ensurePackageDir();
  maybeSwitchNetwork(opts.network);
  buildMovePackage(opts);
  if (opts.buildOnly) {
    console.log('[sui-policy] --build-only specified; done.');
    return;
  }
  const result = publish(opts);
  if (!result.packageId) return;
  if (opts.burnUpgradeCap && !opts.dryRun) {
    burnUpgradeCap(result.upgradeCapId, opts);
  }
  printNextSteps(result.packageId, opts, result.upgradeCapId);
}

try {
  main();
} catch (e) {
  console.error('[sui-policy] failed:', e instanceof Error ? e.message : String(e));
  exit(1);
}
