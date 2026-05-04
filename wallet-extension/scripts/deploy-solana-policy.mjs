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
 *                                          [--sync-program-id] [--dry-run]
 *
 * Examples:
 *   pnpm run deploy:solana-policy:devnet   # the only cluster you should use today
 *   pnpm run build:solana-policy           # build-only (anchor build)
 *   pnpm run test:solana-policy            # anchor test (skip-local-validator)
 *
 * Prereqs:
 *   - `anchor` CLI installed (https://www.anchor-lang.com/docs/installation)
 *   - `solana` CLI installed and configured with a funded keypair on the target cluster
 *
 * Notes:
 *   - First-time deploy: `anchor build` creates `target/deploy/chromatika_policy-keypair.json`
 *     with a randomly-generated program keypair. Pass `--sync-program-id` to splice that
 *     pubkey into `lib.rs` and `Anchor.toml` automatically (replaces the placeholder
 *     `ChrPo1icyVau1tProgramID11111111111111111111`).
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
const PLACEHOLDER_PROGRAM_ID = 'ChrPo1icyVau1tProgramID11111111111111111111';

function parseArgs(args) {
  const out = {
    cluster: null,
    buildOnly: false,
    skipBuild: false,
    syncProgramId: false,
    dryRun: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--cluster') out.cluster = args[++i];
    else if (a === '--build-only') out.buildOnly = true;
    else if (a === '--skip-build') out.skipBuild = true;
    else if (a === '--sync-program-id') out.syncProgramId = true;
    else if (a === '--dry-run') out.dryRun = true;
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
  --cluster <name>      target Solana cluster (devnet/testnet/mainnet/localnet); defaults to Anchor.toml
  --build-only          run \`anchor build\` only (no deploy)
  --skip-build          skip the build step
  --sync-program-id     splice the keypair's pubkey into lib.rs declare_id! + Anchor.toml
  --dry-run             print what would run without invoking anchor deploy
  --help, -h            show this message

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

function printNextSteps(programPubkey, cluster) {
  const clusterLabel = cluster ?? 'as configured in Anchor.toml';
  console.log('');
  console.log('-----------------------------------------------------------');
  console.log('  chromatika-policy (Solana) deployed');
  console.log('-----------------------------------------------------------');
  console.log(`  cluster:    ${clusterLabel}`);
  console.log(`  program id: ${programPubkey}`);
  console.log('');
  console.log('  next steps:');
  console.log('    1. open chromatika side panel');
  console.log('    2. Settings -> Security -> "On-chain spend caps + panic button"');
  console.log('    3. paste the program id into the Solana program id field');
  console.log('    4. opt in your Solana-base dWallet (pre-alpha; CPI body is a stub')
  console.log('       until ika Solana Alpha-1)');
  console.log('');
  console.log('  honesty disclosure: per CLAUDE.md, Solana ika is pre-alpha. The');
  console.log('  chromatika-policy program enforces panic / cap / cool-down state changes,');
  console.log('  but `do_approve_message_cpi` is a Ok(()) stub - real signature production');
  console.log('  awaits ika Solana Alpha-1. Do NOT use for real-value transactions.');
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
  if (!opts.dryRun) printNextSteps(programPubkey, opts.cluster);
}

main().catch((e) => {
  console.error('[solana-policy] failed:', e instanceof Error ? e.message : String(e));
  exit(1);
});
