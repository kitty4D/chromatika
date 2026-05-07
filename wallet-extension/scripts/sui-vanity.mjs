#!/usr/bin/env node
/**
 * sui-vanity.mjs - grind a vanity Sui ed25519 keypair.
 *
 * dev-side team treasury wallet. NOT for chromatika user vault import. holds no
 * chromatika state. multi-threaded via worker_threads. outputs to stdout only -
 * capture the suiprivkey1... yourself before the terminal scrollback dies.
 *
 * usage:
 *   pnpm exec node scripts/sui-vanity.mjs <pattern> [--suffix] [--workers N] [--quiet]
 *
 *   <pattern>    hex chars; leading 0x stripped; case-insensitive
 *   --suffix     match trailing nibbles instead of leading
 *   --workers N  default = os.cpus().length
 *   --quiet      suppress progress lines (stderr)
 */

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { cpus } from 'node:os';
import process from 'node:process';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

const __filename = fileURLToPath(import.meta.url);

if (isMainThread) {
  await main();
} else {
  workerLoop();
}

// ---------- main thread ----------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  const { pattern, mode, workers: workerCount, quiet } = args;

  if (!quiet) {
    const expected = Math.pow(16, pattern.length);
    console.error(
      `grinding ${pattern.length}-nibble ${mode} '${pattern}' across ${workerCount} workers`,
    );
    console.error(`expected ~${expected.toLocaleString()} attempts (16^${pattern.length})`);
    console.error('');
  }

  const startedAtMs = Date.now();
  // Shared counter slots (one Int32 per worker). Workers use Atomics.add per attempt;
  // main reads the live values whenever it needs the total. Atomic adds on aligned
  // 32-bit writes are ~1ns, dwarfed by per-attempt keygen cost, so this is free.
  const countsSab = new SharedArrayBuffer(workerCount * Int32Array.BYTES_PER_ELEMENT);
  const counts = new Int32Array(countsSab);
  const readTotal = () => {
    let total = 0;
    for (let i = 0; i < workerCount; i++) total += Atomics.load(counts, i);
    return total;
  };
  const workers = [];
  let resolved = false;
  let progressTimer = null;

  const finish = (result) => {
    if (resolved) return;
    resolved = true;
    for (const w of workers) w.terminate().catch(() => {});
    if (progressTimer) clearInterval(progressTimer);
    process.stderr.write('\n');
    if (!result) {
      console.error('terminated without a match');
      process.exit(1);
    }
    const totalAttempts = readTotal();
    const elapsedMs = Date.now() - startedAtMs;
    const rate = totalAttempts / (elapsedMs / 1000);
    console.log('match found:');
    console.log(`  address:     ${result.address}`);
    console.log(`  suiprivkey:  ${result.secretKey}`);
    console.log(`  attempts:    ${totalAttempts.toLocaleString()}`);
    console.log(`  elapsed:     ${(elapsedMs / 1000).toFixed(2)}s`);
    console.log(`  rate:        ${Math.round(rate).toLocaleString()} addr/s`);
    process.exit(0);
  };

  process.on('SIGINT', () => {
    console.error('\nSIGINT, terminating workers...');
    finish(null);
  });

  if (!quiet) {
    progressTimer = setInterval(() => {
      const totalAttempts = readTotal();
      const elapsedMs = Date.now() - startedAtMs;
      const rate = totalAttempts / (elapsedMs / 1000);
      const expected = Math.pow(16, pattern.length);
      const etaSec = rate > 0 ? Math.max(0, (expected - totalAttempts) / rate) : 0;
      process.stderr.write(
        `\r${totalAttempts.toLocaleString()} attempts | ${Math.round(rate).toLocaleString()} addr/s | eta ~${formatDuration(etaSec)}     `,
      );
    }, 1000);
  }

  for (let i = 0; i < workerCount; i++) {
    const w = new Worker(__filename, {
      workerData: { workerId: i, pattern, mode, countsSab },
    });
    workers.push(w);
    w.on('message', (msg) => {
      if (msg.type === 'match') finish(msg);
    });
    w.on('error', (err) => {
      console.error(`\nworker ${i} error: ${err.message}`);
    });
  }
}

function parseArgs(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    return { help: true };
  }
  let pattern = null;
  let mode = 'prefix';
  let workers = cpus().length;
  let quiet = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--suffix') mode = 'suffix';
    else if (a === '--prefix') mode = 'prefix';
    else if (a === '--quiet' || a === '-q') quiet = true;
    else if (a === '--workers' || a === '-w') {
      const raw = argv[++i];
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 1 || n > 64) {
        die(`--workers must be an integer in [1, 64], got '${raw}'`);
      }
      workers = n;
    } else if (a.startsWith('--')) {
      die(`unknown flag: ${a}`);
    } else if (pattern === null) {
      pattern = a;
    } else {
      die(`unexpected positional arg: ${a}`);
    }
  }

  if (pattern === null) die('pattern is required (e.g. "cafe")');
  if (pattern.startsWith('0x') || pattern.startsWith('0X')) pattern = pattern.slice(2);
  pattern = pattern.toLowerCase();
  if (pattern.length === 0) die('pattern is empty after stripping 0x');
  if (!/^[0-9a-f]+$/.test(pattern)) {
    die(`pattern must be hex chars [0-9a-f]; got '${pattern}'`);
  }
  if (pattern.length > 12) {
    die(`pattern too long (${pattern.length} nibbles); 16^${pattern.length} is impractical`);
  }
  return { pattern, mode, workers, quiet };
}

function die(msg) {
  console.error(`error: ${msg}`);
  console.error('run with --help for usage');
  process.exit(2);
}

function printHelp() {
  console.log('sui-vanity - grind a Sui ed25519 vanity address');
  console.log('');
  console.log('usage:');
  console.log('  pnpm exec node scripts/sui-vanity.mjs <pattern> [--suffix] [--workers N] [--quiet]');
  console.log('');
  console.log('args:');
  console.log('  <pattern>          hex chars; leading 0x stripped; case-insensitive');
  console.log('');
  console.log('flags:');
  console.log('  --suffix           match trailing nibbles instead of leading');
  console.log('  --workers N, -w N  number of grind workers (default = cpu count)');
  console.log('  --quiet, -q        suppress progress lines');
  console.log('  --help, -h         show this help');
  console.log('');
  console.log('examples:');
  console.log('  pnpm exec node scripts/sui-vanity.mjs ab');
  console.log('  pnpm exec node scripts/sui-vanity.mjs cafe --workers 4');
  console.log('  pnpm exec node scripts/sui-vanity.mjs feed --suffix');
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '?';
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

// ---------- worker thread ----------

function workerLoop() {
  const { workerId, pattern, mode, countsSab } = workerData;
  const isPrefix = mode === 'prefix';
  const counts = new Int32Array(countsSab);

  for (;;) {
    const kp = Ed25519Keypair.generate();
    const address = kp.toSuiAddress();
    const body = address.slice(2); // strip leading 0x
    Atomics.add(counts, workerId, 1);
    const matches = isPrefix ? body.startsWith(pattern) : body.endsWith(pattern);
    if (matches) {
      parentPort.postMessage({
        type: 'match',
        workerId,
        address,
        secretKey: kp.getSecretKey(),
      });
      return;
    }
  }
}
