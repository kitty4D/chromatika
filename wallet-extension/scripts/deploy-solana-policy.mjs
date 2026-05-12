#!/usr/bin/env node
/**
 * deploy-solana-policy.mjs - Build + deploy the chromatika-policy Anchor program to Solana.
 *
 * Wraps `anchor build` + `anchor deploy` so the chromatika team can deploy with one command.
 * Reads the program id from `target/deploy/chromatika_policy-keypair.json` after build,
 * optionally syncs `declare_id!` in lib.rs and `[programs.<cluster>]` in Anchor.toml so the
 * placeholder ids match the keypair's actual pubkey.
 *
 * **PRE-ALPHA. Per CLAUDE.md "ika solana pre-alpha":** Solana ika today uses a single mock
 * signer (not distributed MPC); the on-chain program data WILL BE WIPED on Alpha-1. The
 * chromatika-policy `do_approve_message_cpi` is a `Ok(())` stub until ika exposes a CPI
 * target for caller-PDA-as-authority approve_message. Deploy this for storage-shape +
 * UI-surface validation only. Do NOT submit real-value transactions through Solana ika
 * pre-alpha.
 *
 * Usage:
 *   node scripts/deploy-solana-policy.mjs [--cluster devnet|testnet|mainnet|localnet]
 *                                          [--build-only] [--skip-build]
 *                                          [--sync-program-id] [--dry-run] [--final]
 *
 * Examples:
 *   pnpm run deploy:solana-policy:devnet           # iteration deploy, upgrade authority retained
 *   pnpm run deploy:solana-policy:devnet:final     # audited production cut: upgrade authority None
 *   pnpm run build:solana-policy                   # build-only (anchor build)
 *   pnpm run test:solana-policy                    # anchor test (skip-local-validator)
 *
 * --final is the audited-production-cut flag. After `anchor deploy`, it runs `solana program
 * set-upgrade-authority --final` which permanently sets the program's upgrade authority to
 * None. No future `anchor deploy` or `solana program deploy` against this program id can
 * succeed; bugfixes require deploying a fresh program id and migrating users via the
 * chromatika unwrap + re-wrap flow.
 *
 * Prereqs:
 *   - `anchor` CLI installed (https://www.anchor-lang.com/docs/installation)
 *   - `solana` CLI installed and configured with a funded keypair on the target cluster
 *
 * Notes:
 *   - First-time deploy: `anchor build` creates `target/deploy/chromatika_policy-keypair.json`
 *     with a randomly-generated program keypair. Pass `--sync-program-id` to splice that
 *     pubkey into `lib.rs` and `Anchor.toml` automatically (replaces the placeholder
 *     `Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS`).
 *   - Subsequent deploys: program id is fixed; `anchor deploy` upgrades the existing program
 *     account if you're the upgrade authority.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { argv, exit, platform } from 'node:process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const PROGRAM_DIR = join(REPO_ROOT, 'solana', 'chromatika-policy');
const LIB_RS_PATH = join(PROGRAM_DIR, 'programs', 'chromatika-policy', 'src', 'lib.rs');
const ANCHOR_TOML_PATH = join(PROGRAM_DIR, 'Anchor.toml');
const PROGRAM_KEYPAIR_PATH = join(PROGRAM_DIR, 'target', 'deploy', 'chromatika_policy-keypair.json');
// Canonical Anchor scaffold placeholder; valid Base58 + correct 32-byte length so
// `anchor build` parses it cleanly. Gets overwritten on first run with --sync-program-id.
// Note: we picked this exact constant over our previous custom string because the previous
// string contained a capital `I`, which is excluded from Base58 (along with 0, O, l).
const PLACEHOLDER_PROGRAM_ID = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS';

function parseArgs(args) {
  const out = {
    cluster: null,
    buildOnly: false,
    skipBuild: false,
    syncProgramId: false,
    dryRun: false,
    final: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--cluster') out.cluster = args[++i];
    else if (a === '--build-only') out.buildOnly = true;
    else if (a === '--skip-build') out.skipBuild = true;
    else if (a === '--sync-program-id') out.syncProgramId = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--final') out.final = true;
    else if (a === '--help' || a === '-h') {
      console.log(USAGE);
      exit(0);
    }
  }
  return out;
}

const USAGE = `chromatika solana policy deployer (PRE-ALPHA)
usage:
  node scripts/deploy-solana-policy.mjs [options]

options:
  --cluster <name>       target Solana cluster (devnet/testnet/mainnet/localnet); defaults to Anchor.toml
  --build-only           run \`anchor build\` only (no deploy)
  --skip-build           skip the build step
  --sync-program-id      splice the keypair's pubkey into lib.rs declare_id! + Anchor.toml
  --dry-run              print what would run without invoking anchor deploy
  --final                after deploy, run \`solana program set-upgrade-authority --final\` so
                         the program becomes IMMUTABLE FOREVER. Use only for the audited
                         production cut; iteration deploys should leave this off so bugs can
                         be patched via repeat \`anchor deploy\`.
  --help, -h             show this message

WARNING: pre-alpha. Solana ika today uses a single mock signer + program data wipes on
Alpha-1. \`do_approve_message_cpi\` is a Ok(()) stub. Deploy for storage-shape + UI-surface
validation only. Do NOT submit real-value transactions.
`;

function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  if (opts.dryRun) {
    console.log('  [dry-run] (skipped)');
    return '';
  }
  const useShell = platform === 'win32';
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd ?? process.cwd(),
    stdio: opts.captureStdout ? ['inherit', 'pipe', 'inherit'] : 'inherit',
    shell: useShell,
    encoding: 'utf8',
  });
  if (res.error) throw new Error(`spawn failed: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`${cmd} exited with code ${res.status}`);
  return res.stdout ?? '';
}

function ensureCliInstalled(name) {
  const useShell = platform === 'win32';
  const probe = spawnSync(name, ['--version'], { stdio: 'pipe', shell: useShell, encoding: 'utf8' });
  if (probe.status !== 0) {
    console.error(`${name} CLI not found on PATH. install before continuing.`);
    exit(1);
  }
  console.log(`> ${name} --version: ${(probe.stdout ?? '').trim()}`);
}

function ensureProgramDir() {
  if (!existsSync(PROGRAM_DIR)) {
    console.error(`expected Anchor program at ${PROGRAM_DIR} but it does not exist`);
    exit(1);
  }
  if (!existsSync(ANCHOR_TOML_PATH)) {
    console.error(`no Anchor.toml in ${PROGRAM_DIR}`);
    exit(1);
  }
}

/**
 * Compute the base58 pubkey from an Anchor program keypair file (a 64-byte JSON array).
 * Bytes 32..63 are the public key (ed25519 keypair = 32 secret + 32 public).
 *
 * Pure-deps implementation: bs58 isn't a chromatika dep but `@solana/web3.js` has
 * `Keypair.fromSecretKey().publicKey.toBase58()` which we use.
 */
async function readProgramPubkeyFromKeypair(path) {
  if (!existsSync(path)) {
    throw new Error(
      `program keypair not found at ${path}. Run \`anchor build\` first to generate it.`,
    );
  }
  const raw = readFileSync(path, 'utf8');
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr) || arr.length !== 64) {
    throw new Error('program keypair JSON must be a 64-byte array');
  }
  const { Keypair } = await import('@solana/web3.js');
  const kp = Keypair.fromSecretKey(Uint8Array.from(arr));
  return kp.publicKey.toBase58();
}

function syncProgramIdInSources(programPubkey) {
  // 1. lib.rs declare_id!("...") -> replace inside the macro literal
  if (!existsSync(LIB_RS_PATH)) throw new Error(`lib.rs missing at ${LIB_RS_PATH}`);
  const libBefore = readFileSync(LIB_RS_PATH, 'utf8');
  const declareIdRe = /declare_id!\("([^"]+)"\)/;
  const libMatch = libBefore.match(declareIdRe);
  if (!libMatch) {
    console.warn('[solana-policy] could not find declare_id!() in lib.rs; skipping lib.rs sync');
  } else if (libMatch[1] === programPubkey) {
    console.log('[solana-policy] lib.rs declare_id! already matches; no change');
  } else {
    const libAfter = libBefore.replace(declareIdRe, `declare_id!("${programPubkey}")`);
    writeFileSync(LIB_RS_PATH, libAfter);
    console.log(`[solana-policy] synced lib.rs declare_id! -> ${programPubkey}`);
  }

  // 2. Anchor.toml [programs.devnet] / [programs.testnet] / [programs.mainnet] entries
  const tomlBefore = readFileSync(ANCHOR_TOML_PATH, 'utf8');
  // Replace any line of the form `chromatika_policy = "<pubkey>"` (under a [programs.*] section)
  const tomlAfter = tomlBefore.replace(
    /(chromatika_policy\s*=\s*")[^"]+(")/g,
    `$1${programPubkey}$2`,
  );
  if (tomlAfter !== tomlBefore) {
    writeFileSync(ANCHOR_TOML_PATH, tomlAfter);
    console.log(`[solana-policy] synced Anchor.toml [programs.*] -> ${programPubkey}`);
  } else {
    console.log('[solana-policy] Anchor.toml already current; no change');
  }
}

function buildAnchor(opts) {
  if (opts.skipBuild) {
    console.log('[solana-policy] skipping build (--skip-build)');
    return;
  }
  run('anchor', ['build'], { cwd: PROGRAM_DIR, dryRun: opts.dryRun });
}

function deployAnchor(opts) {
  const args = ['deploy'];
  if (opts.cluster) {
    args.push('--provider.cluster', opts.cluster);
  }
  run('anchor', args, { cwd: PROGRAM_DIR, dryRun: opts.dryRun });
}

/**
 * Mark the program's upgrade authority as `None` via `solana program set-upgrade-authority --final`.
 * After this, no future `anchor deploy` or `solana program deploy` against this program id can
 * succeed: the program account's upgrade authority is permanently null.
 *
 * Mirrors the Sui-side `make_immutable(UpgradeCap)` step. Runs as a separate solana CLI call
 * after `anchor deploy` (Anchor's CLI does not expose a `--final` flag directly).
 *
 * Recovery: if this fails (network error, fee insufficient), the program is deployed but
 * upgrade authority is still on the deployer keypair. Rerun the command manually:
 *   solana program set-upgrade-authority <program_id> --final
 */
function setUpgradeAuthorityFinal(programPubkey, opts) {
  console.log('');
  console.log('-----------------------------------------------------------');
  console.log('  burning Solana program upgrade authority (--final)');
  console.log('-----------------------------------------------------------');
  console.log(`  program id: ${programPubkey}`);
  console.log('');
  console.log('  WARNING: this sets the upgrade authority to None. After this');
  console.log('  transaction, no future `anchor deploy` or `solana program deploy`');
  console.log('  against this program id can succeed. The program becomes IMMUTABLE');
  console.log('  FOREVER. Bugfixes will require a fresh program id and chromatika-side');
  console.log('  migration via the unwrap + re-wrap flow.');
  console.log('-----------------------------------------------------------');
  console.log('');
  const args = ['program', 'set-upgrade-authority', programPubkey, '--final'];
  if (opts.cluster) {
    args.push('--url', opts.cluster);
  }
  run('solana', args, { cwd: PROGRAM_DIR, dryRun: opts.dryRun });
  console.log('');
  console.log(`[solana-policy] upgrade authority for ${programPubkey} is now None. Program is immutable.`);
}

function printNextSteps(programPubkey, cluster, opts) {
  const clusterLabel = cluster ?? 'as configured in Anchor.toml';
  console.log('');
  console.log('-----------------------------------------------------------');
  console.log('  chromatika-policy (Solana) deployed');
  console.log('-----------------------------------------------------------');
  console.log(`  cluster:    ${clusterLabel}`);
  console.log(`  program id: ${programPubkey}`);
  if (opts.final) {
    console.log('  upgrade authority: None (program is immutable forever)');
  } else {
    console.log('  upgrade authority: held on deployer keypair (program is upgradable)');
  }
  console.log('');
  if (opts.final) {
    console.log('  this is an audited production cut. To register it as a built-in market in');
    console.log('  chromatika, paste the program id into src/background/policy-vault/policy-vault-builtin.ts');
    console.log('  alongside the audit hash + audit report link, then ship a chromatika release.');
  } else {
    console.log('  this is a testing / iteration deploy. Upgrade authority stays on the deployer');
    console.log('  keypair so you can patch bugs via repeat `anchor deploy`. When the program is');
    console.log('  audit-clean, run the same command with --final to lock the upgrade authority.');
  }
  console.log('');
  console.log('  honesty disclosure: per CLAUDE.md, Solana ika is pre-alpha. The');
  console.log('  chromatika-policy program enforces panic / cap / cool-down state changes,');
  console.log('  but `do_approve_message_cpi` and `do_release_authority_cpi` are Ok(()) stubs.');
  console.log('  Real signature production + dWallet authority release await ika Solana Alpha-1.');
  console.log('  Do NOT use for real-value transactions.');
  console.log('-----------------------------------------------------------');
}

async function main() {
  const opts = parseArgs(argv.slice(2));
  console.log(`[solana-policy] program dir: ${PROGRAM_DIR}`);
  ensureCliInstalled('anchor');
  ensureProgramDir();
  buildAnchor(opts);

  // Read the program pubkey from the keypair (generated by anchor build).
  let programPubkey = PLACEHOLDER_PROGRAM_ID;
  if (existsSync(PROGRAM_KEYPAIR_PATH)) {
    try {
      programPubkey = await readProgramPubkeyFromKeypair(PROGRAM_KEYPAIR_PATH);
      console.log(`[solana-policy] program pubkey from keypair: ${programPubkey}`);
    } catch (e) {
      console.warn(
        `[solana-policy] could not derive pubkey from keypair: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  if (opts.syncProgramId && programPubkey !== PLACEHOLDER_PROGRAM_ID) {
    syncProgramIdInSources(programPubkey);
    if (!opts.skipBuild) {
      // Rebuild after syncing so the deployed binary's declare_id! matches the keypair pubkey.
      console.log('[solana-policy] rebuilding after declare_id! sync...');
      run('anchor', ['build'], { cwd: PROGRAM_DIR, dryRun: opts.dryRun });
    }
  } else if (programPubkey === PLACEHOLDER_PROGRAM_ID) {
    console.warn(
      '[solana-policy] WARNING: program pubkey is the placeholder. Run with --sync-program-id to splice the real pubkey into lib.rs + Anchor.toml.',
    );
  }

  if (opts.buildOnly) {
    console.log('[solana-policy] --build-only specified; done.');
    return;
  }

  deployAnchor(opts);
  if (opts.final && !opts.dryRun && programPubkey !== PLACEHOLDER_PROGRAM_ID) {
    ensureCliInstalled('solana');
    setUpgradeAuthorityFinal(programPubkey, opts);
  }
  if (!opts.dryRun) printNextSteps(programPubkey, opts.cluster, opts);
}

main().catch((e) => {
  console.error('[solana-policy] failed:', e instanceof Error ? e.message : String(e));
  exit(1);
});
