#!/usr/bin/env node
/**
 * setup-sol-vanity.mjs - one-shot setup for the SolVanityCL GPU vanity grinder.
 *
 * runs:
 *   1. preflight (python 3.10-3.13, git, OpenCL ICD probe via clinfo if present)
 *   2. clone or pull WincerChan/SolVanityCL into .sol-vanity-deploy/SolVanityCL/
 *   3. create an isolated venv at .sol-vanity-deploy/SolVanityCL/.venv
 *   4. pip install -r requirements.txt inside that venv
 *   5. python main.py show-device (lists OpenCL devices, smoke-tests pyopencl)
 *   6. print the run command for grinding a vanity Solana keypair
 *
 * dev-team treasury wallet only. NOT a chromatika user vault path. output is a
 * standard Solana keypair JSON (the format `solana-keygen` and `Keypair.fromSecretKey`
 * accept). Hold the keypair in a backend secret store; mirror of the sui-vanity
 * faucet pattern - per chromatika's CLAUDE.md, use this for funding new users
 * during onboarding, especially Solana-base ika dWallet flows.
 *
 * re-runs are safe: clone step does a `git pull --ff-only` if the repo is already
 * present; venv reuses the existing one; `pip install -r requirements.txt`
 * is a no-op when everything is already pinned.
 *
 * usage:
 *   node scripts/setup-sol-vanity.mjs            # full pipeline
 *   node scripts/setup-sol-vanity.mjs --skip-test # skip show-device probe
 *   node scripts/setup-sol-vanity.mjs --help
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WALLET_EXTENSION_ROOT = resolve(__dirname, '..');
const DEPLOY_WORKSPACE = resolve(WALLET_EXTENSION_ROOT, '.sol-vanity-deploy');
const REPO_DIR = resolve(DEPLOY_WORKSPACE, 'SolVanityCL');
const VENV_DIR = resolve(REPO_DIR, '.venv');
const REQUIREMENTS_TXT = resolve(REPO_DIR, 'requirements.txt');
const MAIN_PY = resolve(REPO_DIR, 'main.py');
const REPO_URL = 'https://github.com/WincerChan/SolVanityCL.git';

const isWin = process.platform === 'win32';
const VENV_BIN = isWin ? join(VENV_DIR, 'Scripts') : join(VENV_DIR, 'bin');
const VENV_PYTHON = isWin ? join(VENV_BIN, 'python.exe') : join(VENV_BIN, 'python');
const VENV_PIP = isWin ? join(VENV_BIN, 'pip.exe') : join(VENV_BIN, 'pip');

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
  const probe = isWin
    ? spawnSync('where', [cmd], { encoding: 'utf8' })
    : spawnSync('which', [cmd], { encoding: 'utf8' });
  if (probe.status === 0 && probe.stdout.trim()) return probe.stdout.trim().split(/\r?\n/)[0];
  return null;
}

/**
 * Pick the best Python interpreter available. SolVanityCL's README claims compat
 * with 3.6 through 3.13. Avoid 3.14 by default (RC builds + spotty pyopencl wheel
 * coverage). Order: py launcher with explicit version > python3 > python.
 */
function pickPython() {
  if (isWin) {
    const candidates = ['3.13', '3.12', '3.11', '3.10', '3.9'];
    for (const v of candidates) {
      const probe = spawnSync('py', [`-${v}`, '--version'], { encoding: 'utf8' });
      if (probe.status === 0) {
        const ver = (probe.stdout.trim() || probe.stderr.trim());
        return { cmd: 'py', args: [`-${v}`], version: ver, label: `py -${v}` };
      }
    }
  }
  for (const cmd of ['python3', 'python']) {
    const probe = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
    if (probe.status === 0) {
      const ver = (probe.stdout.trim() || probe.stderr.trim());
      const m = ver.match(/Python\s+(\d+)\.(\d+)/);
      if (m) {
        const major = Number(m[1]);
        const minor = Number(m[2]);
        if (major === 3 && minor >= 6 && minor <= 13) {
          return { cmd, args: [], version: ver, label: cmd };
        }
        if (major === 3 && minor >= 14) {
          warn(`${cmd} reports ${ver} - pyopencl wheels may not be available for 3.14+; will try anyway`);
          return { cmd, args: [], version: ver, label: cmd };
        }
      }
    }
  }
  return null;
}

async function preflight() {
  step(1, 'preflight checks');

  const py = pickPython();
  if (!py) {
    fail('no Python 3.6-3.13 found on PATH.');
    log('    install via https://www.python.org/downloads/ (3.13 recommended)', 'dim');
    throw new Error('python missing');
  }
  ok(`python: ${py.label} (${py.version})`);

  const git = which('git');
  if (!git) {
    fail('git not found on PATH.');
    throw new Error('git missing');
  }
  ok(`git: ${git}`);

  // OpenCL ICD probe is optional — clinfo not always installed on Windows.
  const clinfo = which('clinfo');
  if (clinfo) {
    const probe = spawnSync('clinfo', ['--list'], { encoding: 'utf8' });
    if (probe.status === 0 && probe.stdout.trim()) {
      const lines = probe.stdout.trim().split(/\r?\n/).filter((l) => l.trim());
      ok(`OpenCL ICDs visible: ${lines.length} device line(s) (clinfo)`);
    } else {
      warn('clinfo found but listed no devices - GPU drivers may need updating');
    }
  } else {
    log('  (clinfo not found - skipping OpenCL ICD probe; show-device will tell us)', 'dim');
  }

  return py;
}

async function cloneOrPull() {
  step(2, 'clone or pull WincerChan/SolVanityCL');

  if (!existsSync(DEPLOY_WORKSPACE)) {
    mkdirSync(DEPLOY_WORKSPACE, { recursive: true });
  }

  if (!existsSync(REPO_DIR)) {
    log(`  cloning ${REPO_URL} into ${REPO_DIR}...`, 'dim');
    await runStreamed('git', ['clone', '--depth', '1', REPO_URL, REPO_DIR]);
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

  if (!existsSync(MAIN_PY)) {
    fail(`main.py not found at ${MAIN_PY}`);
    log('    upstream layout may have changed; check', 'dim');
    log(`    ${REPO_URL.replace(/\.git$/, '')}`, 'dim');
    throw new Error('main.py missing');
  }
  if (!existsSync(REQUIREMENTS_TXT)) {
    fail(`requirements.txt not found at ${REQUIREMENTS_TXT}`);
    throw new Error('requirements.txt missing');
  }
  ok(`main.py: ${MAIN_PY}`);
  ok(`requirements.txt: ${REQUIREMENTS_TXT}`);
}

async function makeVenv(py) {
  step(3, 'create or reuse venv');
  if (existsSync(VENV_PYTHON)) {
    ok(`venv already exists: ${VENV_DIR}`);
    return;
  }
  log(`  creating venv at ${VENV_DIR}...`, 'dim');
  await runStreamed(py.cmd, [...py.args, '-m', 'venv', VENV_DIR]);
  if (!existsSync(VENV_PYTHON)) {
    fail(`venv created but ${VENV_PYTHON} missing`);
    throw new Error('venv creation failed');
  }
  ok(`venv created: ${VENV_DIR}`);
}

async function pipInstall() {
  step(4, 'pip install -r requirements.txt (inside venv)');
  // Upgrade pip first - older pip versions sometimes can't resolve pyopencl wheels.
  await runStreamed(VENV_PYTHON, ['-m', 'pip', 'install', '--upgrade', 'pip']);
  await runStreamed(VENV_PIP, ['install', '-r', REQUIREMENTS_TXT]);
  ok('dependencies installed');
}

async function showDevice() {
  step(5, 'python main.py show-device (smoke test)');
  try {
    await runStreamed(VENV_PYTHON, ['main.py', 'show-device'], { cwd: REPO_DIR });
    ok('OpenCL device probe succeeded');
  } catch (e) {
    fail(`show-device failed: ${e.message}`);
    log('    typical fixes:', 'dim');
    log('    - install/update GPU drivers (NVIDIA, AMD, Intel)', 'dim');
    log('    - on Windows, OpenCL ICDs ship with the GPU driver', 'dim');
    log('    - re-run this setup once drivers are in place', 'dim');
    throw e;
  }
}

function printNextSteps() {
  const venvPyDisplay = isWin
    ? '.venv\\Scripts\\python.exe'
    : '.venv/bin/python';
  log('\n' + '='.repeat(70), 'cyan');
  log(`${COLORS.bold}SolVanityCL ready${COLORS.reset}`, 'green');
  log('='.repeat(70), 'cyan');
  log('');
  log(`  workspace: ${COLORS.dim}${REPO_DIR}${COLORS.reset}`);
  log('');
  log(`  ${COLORS.bold}grind a Solana vanity keypair${COLORS.reset} (run from inside the SolVanityCL dir):`);
  log('');
  log(`    cd ${REPO_DIR}`);
  log(`    ${venvPyDisplay} main.py search-pubkey --starts-with chroma`);
  log('');
  log(`  ${COLORS.bold}common flags:${COLORS.reset}`);
  log(`    --starts-with TEXT      prefix to match (case-sensitive by default)`);
  log(`    --ends-with TEXT        suffix to match`);
  log(`    --count N               find N matching keypairs (default 1)`);
  log(`    --output-dir DIR        where to save the .json keypair (default ./)`);
  log(`    --is-case-sensitive false   case-insensitive match`);
  log(`    --iteration-bits 24-28  GPU work-group size (raise on bigger GPUs)`);
  log('');
  log(`  ${COLORS.bold}base58 charset notes:${COLORS.reset} ${COLORS.dim}(58 chars; excludes 0 O I l)${COLORS.reset}`);
  log(`    "chroma" works as-is; "ika" cannot - i is excluded from base58.`);
  log(`    workarounds: "Ika" also blocked (I excluded), but "1ka", "yka",`);
  log(`    or "ika" written as a substring of a longer word ("aika", "Aikab")`);
  log(`    are valid. with case-insensitive match, "chroma" is ~58^6 = 38B`);
  log(`    attempts - GPU does this in ~minutes; CPU would be hours.`);
  log('');
  log(`  ${COLORS.bold}output:${COLORS.reset} a Solana keypair JSON file at <output-dir>/<pubkey>.json`);
  log(`    contents: a 64-byte secret key as a JSON int array (the format`);
  log(`    solana-keygen and @solana/web3.js Keypair.fromSecretKey accept).`);
  log('');
  log(`  ${COLORS.bold}verify:${COLORS.reset}`);
  log(`    solana-keygen pubkey <pubkey>.json`);
  log('');
  log(`  ${COLORS.bold}backend load (TS / @solana/web3.js):${COLORS.reset}`);
  log(`    const raw = JSON.parse(fs.readFileSync('treasury.json', 'utf8'));`);
  log(`    const kp = Keypair.fromSecretKey(Uint8Array.from(raw));`);
  log('');
  log(`  ${COLORS.bold}intended use:${COLORS.reset} dev-team treasury for funding new chromatika users`);
  log(`  during Solana-base ika onboarding (per CLAUDE.md, NOT a user vault path).`);
  log('='.repeat(70) + '\n', 'cyan');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    log('Usage: node scripts/setup-sol-vanity.mjs [--skip-test] [--help]');
    log('');
    log('Clones WincerChan/SolVanityCL into wallet-extension/.sol-vanity-deploy/,');
    log('creates an isolated Python venv, installs requirements, and runs the');
    log('show-device smoke test to confirm OpenCL is wired up. Idempotent.');
    log('');
    log('Requires: Python 3.6-3.13 (3.10-3.13 strongly preferred), git,');
    log('OpenCL drivers (ship with NVIDIA/AMD/Intel GPU drivers).');
    return;
  }
  const skipTest = args.includes('--skip-test');

  log(`${COLORS.bold}chromatika SolVanityCL setup${COLORS.reset}`);
  log(`workspace: ${DEPLOY_WORKSPACE}`, 'dim');

  try {
    const py = await preflight();
    await cloneOrPull();
    await makeVenv(py);
    await pipInstall();
    if (skipTest) {
      ok('--skip-test set; skipping show-device probe');
    } else {
      await showDevice();
    }
    printNextSteps();
  } catch (e) {
    log(
      `\n${COLORS.red}${COLORS.bold}setup failed:${COLORS.reset} ${e instanceof Error ? e.message : String(e)}`,
    );
    log('see above for details. fix the underlying issue and re-run.', 'dim');
    process.exit(1);
  }
}

void main();
