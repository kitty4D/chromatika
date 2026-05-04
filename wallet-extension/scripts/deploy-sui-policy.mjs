#!/usr/bin/env node
/**
 * deploy-sui-policy.mjs - Build + publish the chromatika_policy Move package to Sui.
 *
 * Wraps `sui move build` + `sui client publish` so the chromatika team can deploy with
 * one command instead of remembering the right `--gas-budget` and `--json` flags. Parses
 * the JSON publish response to extract the new packageId and prints the next steps for
 * pasting it into chromatika Settings -> Security -> "On-chain spend caps + panic".
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
 *                                       [--skip-build] [--skip-deps]
 *
 * Examples:
 *   pnpm run deploy:sui-policy:testnet
 *   pnpm run deploy:sui-policy:mainnet
 *   pnpm run build:sui-policy            # build-only (sui move build)
 *   pnpm run test:sui-policy             # sui move test
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
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--network') out.network = args[++i];
    else if (a === '--gas-budget') out.gasBudget = args[++i];
    else if (a === '--build-only') out.buildOnly = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--skip-build') out.skipBuild = true;
    else if (a === '--skip-deps') out.skipDeps = true;
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
  --network <name>      switch the active sui client env first (testnet/mainnet/devnet/localnet)
  --gas-budget <mist>   gas budget for publish (default ${DEFAULT_GAS_BUDGET})
  --build-only          run \`sui move build\` only (no publish)
  --dry-run             run \`sui client publish --dry-run\` (no on-chain action)
  --skip-build          skip the build step (assume target/ is current)
  --skip-deps           pass --skip-fetch-latest-git-deps to sui (faster local iteration)
  --help, -h            show this message
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

function publish(opts) {
  const args = ['client', 'publish', '--gas-budget', opts.gasBudget, '--json'];
  if (opts.dryRun) args.splice(2, 0, '--dry-run');
  if (opts.skipDeps) args.push('--skip-fetch-latest-git-deps');
  // Run from inside the package dir so sui picks up the right Move.toml.
  const stdout = run('sui', args, { cwd: PACKAGE_DIR, captureStdout: true });
  if (opts.dryRun) {
    console.log('[sui-policy] dry-run complete; no on-chain publish was performed.');
    return null;
  }
  const pkgId = extractPackageIdFromPublishJson(stdout);
  if (!pkgId) {
    console.error('[sui-policy] published but could not auto-extract packageId from output');
    console.error('full publish stdout follows:');
    console.error(stdout);
    return null;
  }
  return pkgId;
}

function printNextSteps(packageId) {
  console.log('');
  console.log('-----------------------------------------------------------');
  console.log('  chromatika_policy published');
  console.log('-----------------------------------------------------------');
  console.log(`  packageId: ${packageId}`);
  console.log('');
  console.log('  next steps:');
  console.log('    1. open chromatika side panel');
  console.log('    2. Settings -> Security -> "On-chain spend caps + panic button"');
  console.log('    3. paste the packageId above into the input, click save');
  console.log('    4. opt in your dWallet via the panel');
  console.log('');
  console.log('  the same packageId hosts all four sign_gate modules:');
  console.log('    - sign_gate        (PolicyVault + sign_with_policy + panic + setters)');
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
  const pkgId = publish(opts);
  if (pkgId) printNextSteps(pkgId);
}

try {
  main();
} catch (e) {
  console.error('[sui-policy] failed:', e instanceof Error ? e.message : String(e));
  exit(1);
}
