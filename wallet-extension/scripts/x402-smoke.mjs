#!/usr/bin/env node
/**
 * x402 wire-format smoke test.
 *
 * validates that chromatika's expected x402 wire format (PAYMENT-REQUIRED ->
 * PAYMENT-SIGNATURE -> PAYMENT-RESPONSE) round-trips against a real public x402
 * facilitator/endpoint. this script does NOT drive chromatika's signer (that's
 * browser-side; needs Playwright). it exercises the SHAPE of the protocol from
 * outside, so we can catch upstream wire-format drift before the real wallet
 * flow trips on devnet.
 *
 * what it checks:
 *   1. GET <protected URL> -> expects HTTP 402 + Payment-Required header
 *   2. decodes the base64 header -> JSON PaymentRequirements
 *   3. verifies the requirements shape matches what chromatika's `x402-dispatch.ts` expects:
 *      `scheme: 'exact'`, `network: 'solana-devnet' | 'solana'`, `payTo` is a base58 pubkey,
 *      `asset` is a base58 SPL mint, `maxAmountRequired` is a positive decimal string
 *   4. reports pass/fail with the parsed requirements for visual inspection
 *
 * what it does NOT do:
 *   - sign the payment (chromatika's signer is browser-side)
 *   - retry with PAYMENT-SIGNATURE (would need a funded keypair + the actual signing flow)
 *   - assert PAYMENT-RESPONSE settlement digest (depends on facilitator)
 *
 * for the full end-to-end demo, follow the manual runbook in `wallet-extension/docs/X402_SMOKE.md`
 * (load extension -> hit the URL in the browser -> watch the popup -> confirm settlement).
 *
 * usage:
 *   pnpm smoke:x402                           # default: x402.org demo endpoint
 *   pnpm smoke:x402 --url <protected URL>     # custom endpoint
 *   pnpm smoke:x402 --json                    # emit machine-readable JSON instead of pretty
 */

import process from 'node:process';

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

const DEFAULT_URL = 'https://x402.org/protected';
// headers we accept (case-insensitive). x402 spec uses `payment-required`; some implementations
// also surface `Payment-Required` or `X-Payment-Required`. try them in order.
const HEADER_CANDIDATES = ['payment-required', 'x-payment-required', 'x-402-payment-required'];

function log(msg, color = 'reset') {
  console.log(`${COLORS[color] ?? ''}${msg}${COLORS.reset}`);
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

function parseArgs(argv) {
  const out = { url: DEFAULT_URL, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') out.url = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function decodeB64Json(b64) {
  const text = Buffer.from(b64, 'base64').toString('utf8');
  return JSON.parse(text);
}

function isBase58(s) {
  return typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,48}$/.test(s);
}

function shapeCheck(req) {
  const issues = [];
  const exp = (cond, msg) => {
    if (!cond) issues.push(msg);
  };
  exp(req && typeof req === 'object', 'requirements must be an object');
  exp(req?.scheme === 'exact', `scheme must be "exact", got ${JSON.stringify(req?.scheme)}`);
  exp(
    typeof req?.network === 'string' && /solana(-devnet|-mainnet)?/.test(req.network),
    `network must be "solana"/"solana-devnet"/"solana-mainnet", got ${JSON.stringify(req?.network)}`,
  );
  exp(isBase58(req?.payTo ?? ''), `payTo must be base58 solana pubkey, got ${JSON.stringify(req?.payTo)}`);
  exp(isBase58(req?.asset ?? ''), `asset must be base58 SPL mint, got ${JSON.stringify(req?.asset)}`);
  exp(
    typeof req?.maxAmountRequired === 'string' && /^\d+$/.test(req.maxAmountRequired) && BigInt(req.maxAmountRequired) > 0n,
    `maxAmountRequired must be a positive decimal string, got ${JSON.stringify(req?.maxAmountRequired)}`,
  );
  return issues;
}

async function run({ url, json }) {
  const res = await fetch(url, { method: 'GET', redirect: 'manual' }).catch((e) => {
    throw new Error(`fetch ${url} failed: ${e.message}`);
  });

  const status = res.status;
  let headerVal = null;
  let headerName = null;
  for (const cand of HEADER_CANDIDATES) {
    const v = res.headers.get(cand);
    if (v) {
      headerVal = v;
      headerName = cand;
      break;
    }
  }

  if (status !== 402) {
    return {
      ok: false,
      stage: 'http-status',
      detail: `expected HTTP 402, got ${status}`,
      url,
    };
  }
  if (!headerVal) {
    return {
      ok: false,
      stage: 'header-missing',
      detail: `no payment-required header in response (checked: ${HEADER_CANDIDATES.join(', ')})`,
      url,
      headersSeen: [...res.headers.keys()],
    };
  }

  let requirements;
  try {
    requirements = decodeB64Json(headerVal);
  } catch (e) {
    return {
      ok: false,
      stage: 'header-decode',
      detail: `header is not base64 JSON: ${e.message}`,
      url,
      headerVal,
    };
  }

  const issues = shapeCheck(requirements);
  if (issues.length > 0) {
    return {
      ok: false,
      stage: 'shape-mismatch',
      detail: `requirements shape diverges from chromatika's expectations`,
      issues,
      requirements,
      url,
    };
  }

  if (json) {
    return { ok: true, stage: 'shape-ok', url, headerName, requirements };
  }
  return { ok: true, stage: 'shape-ok', url, headerName, requirements };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    log('Usage: pnpm smoke:x402 [--url <protected URL>] [--json]');
    log('');
    log('Validates the wire format of a public x402 endpoint against chromatika\'s expectations.');
    log('Does NOT drive chromatika\'s signer; for the full browser flow see docs/X402_SMOKE.md.');
    return;
  }

  if (opts.json) {
    const result = await run(opts);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exit(1);
    return;
  }

  log(`${COLORS.bold}x402 wire smoke${COLORS.reset}`);
  log(`url: ${opts.url}`, 'dim');
  log('');

  let result;
  try {
    result = await run(opts);
  } catch (e) {
    fail(e.message);
    process.exit(1);
  }

  if (result.ok) {
    ok(`HTTP 402 received with ${COLORS.bold}${result.headerName}${COLORS.reset} header`);
    ok('header decoded as base64 JSON');
    ok('requirements shape matches chromatika expectations');
    log('');
    log(`${COLORS.bold}requirements${COLORS.reset}:`, 'cyan');
    log(JSON.stringify(result.requirements, null, 2));
    log('');
    log('next step: load chromatika in chrome, navigate to the protected URL in another tab,', 'dim');
    log('approve the popup, and confirm the receipt lands in Payments page (settlement digest).', 'dim');
  } else {
    fail(`stage: ${result.stage}`);
    log(`  detail: ${result.detail}`);
    if (result.issues) {
      log('');
      log('  shape issues:', 'yellow');
      for (const i of result.issues) log(`    - ${i}`);
    }
    if (result.requirements) {
      log('');
      log('  decoded requirements (for inspection):', 'dim');
      log(JSON.stringify(result.requirements, null, 2));
    }
    if (result.headerVal) {
      log(`  raw header value: ${result.headerVal.slice(0, 200)}${result.headerVal.length > 200 ? '…' : ''}`, 'dim');
    }
    if (result.headersSeen) {
      log(`  headers in response: ${result.headersSeen.join(', ')}`, 'dim');
    }
    process.exit(1);
  }
}

void main();
