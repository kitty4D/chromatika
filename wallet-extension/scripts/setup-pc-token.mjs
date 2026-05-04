#!/usr/bin/env node
/**
 * one-shot setup for chromatika's PC-Token integration. runs:
 *   1. preflight checks (cargo, solana CLI, devnet config, keypair balance)
 *   2. clone or pull dwallet-labs/encrypt-pre-alpha into .pc-token-deploy/
 *   3. cargo build-sbf the pinocchio variant
 *   4. solana program deploy
 *   5. capture the printed Program Id, save as a hint file, print paste instructions
 *
 * **the script does NOT touch chrome.storage** - it can't, that's browser-only. after this
 * finishes, copy the printed program ID and paste it into chromatika side panel -> Settings ->
 * "private balances (encrypt.xyz pc-token)" -> "configure program ID".
 *
 * re-runs are safe: clone step skips if the repo's already there (does a `git pull`); cargo
 * caches its own build artifacts; `solana program deploy` of an unchanged .so just prints the
 * existing program ID without burning more SOL on rent.
 *
 * usage:
 *   pnpm setup:pc-token              # full pipeline
 *   pnpm setup:pc-token --skip-deploy # build only (useful for CI smoke)
 *   pnpm setup:pc-token --help        # this message
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
// script lives at wallet-extension/scripts/, so wallet-extension root is its parent.
const WALLET_EXTENSION_ROOT = resolve(__dirname, '..');
const DEPLOY_WORKSPACE = resolve(WALLET_EXTENSION_ROOT, '.pc-token-deploy');
const REPO_DIR = resolve(DEPLOY_WORKSPACE, 'encrypt-pre-alpha');
const PINOCCHIO_MANIFEST = resolve(
  REPO_DIR,
  'chains/solana/examples/pc-token/pinocchio/Cargo.toml',
);
const BUILT_SO_PATH = resolve(REPO_DIR, 'target/deploy/pc_token.so');
const HINT_FILE = resolve(WALLET_EXTENSION_ROOT, '.pc-token-deploy/program-id.txt');

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(msg, color = 'reset') {
  console.log(`${COLORS[color] ?? ''}${msg}${COLORS.reset}`);
}
function step(num, msg) {
  log(`\n${COLORS.bold}[${num}]${COLORS.reset} ${COLORS.cyan}${msg}${COLORS.reset}`);
}
function ok(msg) {
  log(`  ✓ ${msg}`, 'green');
}
function warn(msg) {
  log(`  ⚠ ${msg}`, 'yellow');
}
function fail(msg) {
  log(`  ✗ ${msg}`, 'red');
}

function runStreamed(cmd, args, opts = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(cmd, args, {
      stdio: opts.captureStdout ? ['inherit', 'pipe', 'inherit'] : 'inherit',
      shell: false,
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
    });
    let stdout = '';
    if (opts.captureStdout && child.stdout) {
      child.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        stdout += text;
        process.stdout.write(text);
      });
    }
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      if (code === 0) resolvePromise({ stdout });
      else rejectPromise(new Error(`${cmd} ${args.join(' ')} exited ${code}`));
    });
  });
}

function which(cmd) {
  const isWin = process.platform === 'win32';
  const probe = isWin
    ? spawnSync('where', [cmd], { encoding: 'utf8' })
    : spawnSync('which', [cmd], { encoding: 'utf8' });
  if (probe.status === 0 && probe.stdout.trim()) return probe.stdout.trim().split(/\r?\n/)[0];
  return null;
}

async function preflight() {
  step(1, 'preflight checks');

  // cargo
  const cargo = which('cargo');
  if (!cargo) {
    fail('cargo not found on PATH.');
    log('    Install Rust: https://rustup.rs/', 'dim');
    throw new Error('cargo missing');
  }
  ok(`cargo: ${cargo}`);

  // cargo build-sbf (Solana platform tools, ships with `solana` CLI install)
  const buildSbfProbe = spawnSync('cargo', ['build-sbf', '--version'], { encoding: 'utf8' });
  if (buildSbfProbe.status !== 0) {
    fail('cargo build-sbf not available. Install Solana platform tools:');
    log('    sh -c "$(curl -sSfL https://release.solana.com/stable/install)"', 'dim');
    throw new Error('cargo build-sbf missing');
  }
  ok(`cargo build-sbf: ${buildSbfProbe.stdout.trim().split('\n')[0]}`);

  // solana CLI
  const solana = which('solana');
  if (!solana) {
    fail('solana CLI not found on PATH.');
    log('    Install: https://docs.solana.com/cli/install-solana-cli-tools', 'dim');
    throw new Error('solana missing');
  }
  ok(`solana: ${solana}`);

  // git
  const git = which('git');
  if (!git) {
    fail('git not found on PATH.');
    throw new Error('git missing');
  }
  ok(`git: ${git}`);

  // solana network = devnet
  const cfg = spawnSync('solana', ['config', 'get'], { encoding: 'utf8' });
  if (cfg.status !== 0) {
    fail(`solana config get failed: ${cfg.stderr}`);
    throw new Error('solana config error');
  }
  const isDevnet = /https:\/\/api\.devnet\.solana\.com/i.test(cfg.stdout);
  if (!isDevnet) {
    warn('solana CLI is not pointed at devnet. Switching now.');
    const sw = spawnSync('solana', ['config', 'set', '--url', 'https://api.devnet.solana.com'], {
      encoding: 'utf8',
    });
    if (sw.status !== 0) {
      fail(`solana config set failed: ${sw.stderr}`);
      throw new Error('cannot switch to devnet');
    }
    ok('switched to devnet');
  } else {
    ok('solana CLI configured for devnet');
  }

  // keypair balance
  const bal = spawnSync('solana', ['balance'], { encoding: 'utf8' });
  if (bal.status !== 0) {
    fail(`solana balance failed: ${bal.stderr}`);
    log("    If you don't have a deployer keypair yet:", 'dim');
    log('    solana-keygen new', 'dim');
    throw new Error('cannot read keypair balance');
  }
  const balText = bal.stdout.trim();
  const solMatch = balText.match(/([\d.]+)\s*SOL/);
  const sol = solMatch ? parseFloat(solMatch[1]) : 0;
  ok(`deployer balance: ${balText}`);
  if (sol < 3) {
    warn(`balance below 3 SOL - deploy needs ~3-5 SOL for rent.`);
    log('    fund with: solana airdrop 5', 'dim');
    log('    (or visit a devnet faucet)', 'dim');
  }
}

async function cloneOrPull() {
  step(2, 'clone or pull encrypt-pre-alpha');

  if (!existsSync(DEPLOY_WORKSPACE)) {
    mkdirSync(DEPLOY_WORKSPACE, { recursive: true });
  }

  if (!existsSync(REPO_DIR)) {
    log(`  cloning into ${REPO_DIR}...`, 'dim');
    await runStreamed(
      'git',
      ['clone', '--depth', '1', 'https://github.com/dwallet-labs/encrypt-pre-alpha.git', REPO_DIR],
    );
    ok('cloned');
  } else {
    log('  repo already exists - pulling updates', 'dim');
    try {
      await runStreamed('git', ['pull', '--ff-only'], { cwd: REPO_DIR });
      ok('up to date');
    } catch (e) {
      warn(`git pull failed (${e.message}); continuing with existing checkout`);
    }
  }

  if (!existsSync(PINOCCHIO_MANIFEST)) {
    fail(`pinocchio manifest not found at ${PINOCCHIO_MANIFEST}`);
    log('    The upstream layout may have moved. Check', 'dim');
    log('    https://github.com/dwallet-labs/encrypt-pre-alpha/tree/main/chains/solana/examples/pc-token', 'dim');
    throw new Error('pinocchio manifest missing');
  }
  ok(`pinocchio manifest: ${PINOCCHIO_MANIFEST}`);
}

async function build() {
  step(3, 'cargo build-sbf (this can take a few minutes on first run)');
  await runStreamed('cargo', ['build-sbf', '--manifest-path', PINOCCHIO_MANIFEST]);
  if (!existsSync(BUILT_SO_PATH)) {
    fail(`expected build output at ${BUILT_SO_PATH} but it does not exist`);
    throw new Error('build artifact missing');
  }
  ok(`built: ${BUILT_SO_PATH}`);
}

function parseProgramIdFromDeployStdout(text) {
  // `solana program deploy` prints `Program Id: <base58>` on success.
  const match = text.match(/Program\s+Id:\s+([1-9A-HJ-NP-Za-km-z]{32,48})/);
  return match ? match[1] : null;
}

async function deploy() {
  step(4, 'solana program deploy');
  log(`  deploying ${BUILT_SO_PATH}`, 'dim');
  const { stdout } = await runStreamed('solana', ['program', 'deploy', BUILT_SO_PATH], {
    captureStdout: true,
  });
  const programId = parseProgramIdFromDeployStdout(stdout);
  if (!programId) {
    fail('could not parse Program Id from solana program deploy output');
    log(`    raw stdout: ${stdout}`, 'dim');
    throw new Error('deploy parse failed');
  }
  ok(`Program Id: ${COLORS.bold}${programId}${COLORS.reset}`);
  return programId;
}

function writeHint(programId) {
  step(5, 'write hint file + print paste instructions');
  const dir = dirname(HINT_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const body = [
    `# Generated by scripts/setup-pc-token.mjs at ${new Date().toISOString()}`,
    `# Paste this program ID into chromatika side panel → Settings → "private balances (encrypt.xyz pc-token)" → "configure program ID".`,
    '',
    programId,
    '',
  ].join('\n');
  writeFileSync(HINT_FILE, body);
  ok(`hint file written: ${HINT_FILE}`);
}

function printNextSteps(programId) {
  log('\n' + '='.repeat(60), 'cyan');
  log(`${COLORS.bold}PC-Token program deployed to devnet${COLORS.reset}`, 'green');
  log('='.repeat(60), 'cyan');
  log('');
  log(`  ${COLORS.bold}Program Id:${COLORS.reset} ${COLORS.green}${programId}${COLORS.reset}`);
  log('');
  log('  to wire chromatika live:');
  log('  1. open the chromatika side panel');
  log('  2. Settings → "private balances (encrypt.xyz pc-token)"');
  log('  3. paste the Program Id into "configure program ID" → save');
  log('');
  log('  the program ID is also saved at:');
  log(`    ${HINT_FILE}`, 'dim');
  log('');
  log('  full demo runbook: wallet-extension/docs/PC_TOKEN.md', 'dim');
  log('='.repeat(60) + '\n', 'cyan');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    log(`Usage: pnpm setup:pc-token [--skip-deploy] [--help]`);
    log('');
    log('Self-deploys the PC-Token pinocchio program to Solana devnet and prints the program ID');
    log('to paste into chromatika settings. ~5 minutes on first run; ~1 minute after that.');
    log('');
    log('Requires: cargo, cargo build-sbf, solana CLI, git. ~3-5 devnet SOL on the deployer keypair.');
    return;
  }
  const skipDeploy = args.includes('--skip-deploy');

  log(`${COLORS.bold}chromatika PC-Token setup${COLORS.reset}`);
  log(`workspace: ${DEPLOY_WORKSPACE}`, 'dim');

  try {
    await preflight();
    await cloneOrPull();
    await build();
    if (skipDeploy) {
      ok('--skip-deploy set; build-only mode');
      return;
    }
    const programId = await deploy();
    writeHint(programId);
    printNextSteps(programId);
  } catch (e) {
    log(`\n${COLORS.red}${COLORS.bold}setup failed:${COLORS.reset} ${e instanceof Error ? e.message : String(e)}`);
    log('see above for details. fix the underlying issue and re-run pnpm setup:pc-token.', 'dim');
    process.exit(1);
  }
}

void main();
