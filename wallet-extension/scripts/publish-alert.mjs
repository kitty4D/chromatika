#!/usr/bin/env node
/**
 * publish-alert.mjs - sign chromatika safety-broadcast alerts.
 *
 * usage:
 *   node scripts/publish-alert.mjs --gen-key
 *     -> emit a fresh ED25519 keypair (privkey b64 + pubkey b64). save the privkey somewhere
 *        safe (1password, hardware wallet) and paste the pubkey into BUNDLED_PUBLISHERS.
 *
 *   node scripts/publish-alert.mjs --gen-dev-key
 *     -> derive the deterministic dev publisher keypair from the seed
 *        `chromatika-dev-publisher-v0`. matches PLACEHOLDER_DEV_PUBLISHER_PUBKEY_B64 baked
 *        into the extension. anyone can sign dev alerts with this; do NOT use for production.
 *
 *   node scripts/publish-alert.mjs sign --priv <b64> --in <unsigned.json> --out <signed.json> [--panic-targets <id1>,<id2>,...]
 *     -> sign an unsigned alert envelope. reads the unsigned JSON, computes canonical bytes
 *        (key-sorted JSON), signs with ED25519, writes the signed envelope. when
 *        --panic-targets is set, splices the comma-separated 0x-prefixed Sui PolicyVault
 *        object ids into `panicTargets` BEFORE signing (so the canonical JSON matches the
 *        signed bytes).
 *
 *   node scripts/publish-alert.mjs feed --in <signed-array.json> --out <feed.json>
 *     -> wrap an array of signed alerts in the AlertsFeedResponse envelope chromatika expects.
 *
 *   node scripts/publish-alert.mjs sample --priv <b64> --out <sample-feed.json>
 *     -> generate a 3-alert sample feed (1 critical, 1 warning, 1 info) for local demos.
 *        timestamps default to now; expiries default to +7 days.
 *
 *   node scripts/publish-alert.mjs sample-panic --priv <b64> --out <sample-panic-feed.json> --panic-targets <id1>,<id2>,...
 *     -> generate a single-alert "auto-panic" feed with `panicTargets` populated. when
 *        chromatika polls this feed and the active vault's PolicyVault object id matches,
 *        the safety-alerts SW handler auto-builds + signs a panic PTB. used for the
 *        end-to-end runbook in docs/SAFETY_ALERTS.md.
 *
 * canonical signing format MUST match `canonicalJsonStringify` in
 * `src/background/alerts/alerts-types.ts`. see comment there for the rules.
 */

import { writeFileSync, readFileSync } from 'node:fs';
import { argv, exit } from 'node:process';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import * as ed25519 from '@noble/ed25519';
import { hashes as edHashes } from '@noble/ed25519';

// noble-ed25519 v3 sync APIs require an injected SHA512 implementation.
edHashes.sha512 = sha512;

function toB64(bytes) {
  return Buffer.from(bytes).toString('base64');
}
function fromB64(b64) {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

function canonicalJsonStringify(value) {
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON cannot encode non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'bigint') {
    throw new Error('canonical JSON cannot encode bigint');
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalJsonStringify(v)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const parts = [];
    for (const k of keys) {
      const v = value[k];
      if (v === undefined) continue;
      parts.push(JSON.stringify(k) + ':' + canonicalJsonStringify(v));
    }
    return '{' + parts.join(',') + '}';
  }
  throw new Error(`canonical JSON cannot encode ${typeof value}`);
}

function parseArgs(args) {
  const out = {};
  let cmd = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!cmd && !a.startsWith('--')) {
      cmd = a;
      continue;
    }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next == null || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return { cmd, ...out };
}

async function genKey() {
  const priv = ed25519.utils.randomSecretKey();
  const pub = await ed25519.getPublicKey(priv);
  console.log('// pubkey (base64) - paste into BUNDLED_PUBLISHERS in alerts-publishers.ts:');
  console.log(toB64(pub));
  console.log('');
  console.log('// privkey (base64) - keep secret, used only for signing alerts:');
  console.log(toB64(priv));
}

async function genDevKey() {
  // derive a deterministic 32-byte seed from a public string. HKDF-SHA256 over the seed gives a
  // valid ED25519 secret key. anyone can rederive this; that's the point - it's a test key.
  const seed = new TextEncoder().encode('chromatika-dev-publisher-v0');
  const ikm = sha256(seed);
  const priv = hkdf(sha256, ikm, new Uint8Array(0), new TextEncoder().encode('chromatika.dev-publisher.v0'), 32);
  const pub = await ed25519.getPublicKey(priv);
  console.log('// deterministic dev publisher keypair (matches PLACEHOLDER_DEV_PUBLISHER_PUBKEY_B64):');
  console.log('// pubkey (base64):');
  console.log(toB64(pub));
  console.log('');
  console.log('// privkey (base64):');
  console.log(toB64(priv));
}

async function signAlert(priv, unsigned) {
  if (unsigned.v !== 1) throw new Error('only v: 1 is supported');
  const canon = canonicalJsonStringify(unsigned);
  const msg = new TextEncoder().encode(canon);
  const sig = await ed25519.sign(msg, priv);
  return { ...unsigned, signatureB64: toB64(sig) };
}

/**
 * parse a comma-separated `--panic-targets` flag into an array of validated 0x-prefixed
 * 32-byte hex Sui object ids. empty / undefined input -> null (so caller knows to skip
 * splicing). throws on malformed entries to fail loud rather than silently produce an
 * unverifiable alert.
 */
function parsePanicTargets(raw) {
  if (raw == null || raw === true || raw === '') return null;
  const ids = String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const id of ids) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(id)) {
      throw new Error(
        `--panic-targets entry "${id}" is not a 0x-prefixed 32-byte hex Sui object id`,
      );
    }
  }
  return ids;
}

async function cmdSign(opts) {
  if (!opts.priv) throw new Error('--priv <b64> required');
  if (!opts.in) throw new Error('--in <unsigned.json> required');
  if (!opts.out) throw new Error('--out <signed.json> required');
  const priv = fromB64(opts.priv);
  const unsigned = JSON.parse(readFileSync(opts.in, 'utf8'));
  // splice --panic-targets BEFORE signing so the canonical JSON the signature covers
  // includes the panicTargets field. (canonical sort is alphabetical so the field's exact
  // position in the byte stream is determined by the serializer, not insertion order.)
  const targets = parsePanicTargets(opts['panic-targets']);
  if (targets) unsigned.panicTargets = targets;
  const signed = await signAlert(priv, unsigned);
  writeFileSync(opts.out, JSON.stringify(signed, null, 2));
  console.log(
    `signed alert -> ${opts.out}${targets ? ` (panicTargets: ${targets.length})` : ''}`,
  );
}

async function cmdFeed(opts) {
  if (!opts.in) throw new Error('--in <signed-array.json> required');
  if (!opts.out) throw new Error('--out <feed.json> required');
  const alerts = JSON.parse(readFileSync(opts.in, 'utf8'));
  const feed = {
    v: 1,
    generatedAtMs: Date.now(),
    alerts,
  };
  writeFileSync(opts.out, JSON.stringify(feed, null, 2));
  console.log(`feed -> ${opts.out} (${alerts.length} alerts)`);
}

async function cmdSample(opts) {
  if (!opts.priv) throw new Error('--priv <b64> required');
  if (!opts.out) throw new Error('--out <sample-feed.json> required');
  const priv = fromB64(opts.priv);
  const pub = await ed25519.getPublicKey(priv);
  const pubB64 = toB64(pub);
  const now = Date.now();
  const sevenDays = 7 * 24 * 60 * 60 * 1000;

  const samples = [
    {
      v: 1,
      id: `demo-critical-${now}`,
      severity: 'critical',
      timestampMs: now,
      expiresAtMs: now + sevenDays,
      affectedDomains: ['drainer-uniswapv4.app', 'fake-uniswap.io'],
      affectedChains: ['evm'],
      titleShort: 'phishing uniswap clone draining USDC',
      bodyLong:
        'Two domains are running an exact uniswap v4 clone with a malicious approval contract. ' +
        'Connecting your wallet and confirming the "swap" prompts setApprovalForAll for USDC to ' +
        '0x4242deadbeef... which then sweeps balances. ' +
        'If you signed an approval to that contract in the last 24h, revoke immediately.',
      publisherKeyB64: pubB64,
    },
    {
      v: 1,
      id: `demo-warning-${now}`,
      severity: 'warning',
      timestampMs: now,
      expiresAtMs: now + sevenDays,
      affectedDomains: ['shady-mintsite.xyz'],
      affectedChains: ['solana'],
      titleShort: 'sketchy NFT mint site flagged by community',
      bodyLong:
        'Multiple users report this site triggers a versioned tx that includes a hidden ' +
        'token-account close + ATA drain instruction alongside the mint. Treat as suspicious.',
      publisherKeyB64: pubB64,
    },
    {
      v: 1,
      id: `demo-info-${now}`,
      severity: 'info',
      timestampMs: now,
      expiresAtMs: now + sevenDays,
      affectedDomains: [],
      titleShort: 'reminder: revoke unused token approvals',
      bodyLong:
        'Periodically review token approvals on revoke.cash or similar tools. Old infinite ' +
        'approvals to dead protocols are a common compromise vector.',
      publisherKeyB64: pubB64,
    },
  ];
  const signed = [];
  for (const s of samples) {
    signed.push(await signAlert(priv, s));
  }
  const feed = { v: 1, generatedAtMs: now, alerts: signed };
  writeFileSync(opts.out, JSON.stringify(feed, null, 2));
  console.log(`sample feed -> ${opts.out} (${signed.length} alerts: 1 critical, 1 warning, 1 info)`);
}

async function cmdSamplePanic(opts) {
  if (!opts.priv) throw new Error('--priv <b64> required');
  if (!opts.out) throw new Error('--out <sample-panic-feed.json> required');
  const targets = parsePanicTargets(opts['panic-targets']);
  if (!targets || targets.length === 0) {
    throw new Error(
      '--panic-targets <id1>,<id2>,... required (provide one or more PolicyVault object ids)',
    );
  }
  const priv = fromB64(opts.priv);
  const pub = await ed25519.getPublicKey(priv);
  const pubB64 = toB64(pub);
  const now = Date.now();
  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  const unsigned = {
    v: 1,
    id: `demo-panic-${now}`,
    severity: 'critical',
    timestampMs: now,
    expiresAtMs: now + sevenDays,
    affectedDomains: [],
    affectedChains: ['evm', 'sui', 'solana'],
    titleShort: 'auto-panic: chromatika-team detected active drain pattern',
    bodyLong:
      'A drain pattern targeting policy-vault dWallets was detected in the wild. ' +
      'chromatika-team is publishing this alert with panicTargets populated for the ' +
      'affected vaults. When your chromatika instance verifies this alert and the active ' +
      'vault id matches, the on-chain panic flag will flip automatically. Unfreeze takes ' +
      'effect after the configured delay; until then the MPC network refuses ALL signing.',
    publisherKeyB64: pubB64,
    panicTargets: targets,
  };
  const signed = await signAlert(priv, unsigned);
  const feed = { v: 1, generatedAtMs: now, alerts: [signed] };
  writeFileSync(opts.out, JSON.stringify(feed, null, 2));
  console.log(
    `sample-panic feed -> ${opts.out} (1 alert, panicTargets: ${targets.length})`,
  );
}

async function main() {
  const opts = parseArgs(argv.slice(2));
  if (opts['gen-key']) return genKey();
  if (opts['gen-dev-key']) return genDevKey();
  if (opts.cmd === 'sign') return cmdSign(opts);
  if (opts.cmd === 'feed') return cmdFeed(opts);
  if (opts.cmd === 'sample') return cmdSample(opts);
  if (opts.cmd === 'sample-panic') return cmdSamplePanic(opts);
  console.log('usage:');
  console.log('  node scripts/publish-alert.mjs --gen-key');
  console.log('  node scripts/publish-alert.mjs --gen-dev-key');
  console.log('  node scripts/publish-alert.mjs sign --priv <b64> --in <unsigned.json> --out <signed.json> [--panic-targets <id1>,<id2>,...]');
  console.log('  node scripts/publish-alert.mjs feed --in <signed-array.json> --out <feed.json>');
  console.log('  node scripts/publish-alert.mjs sample --priv <b64> --out <sample-feed.json>');
  console.log('  node scripts/publish-alert.mjs sample-panic --priv <b64> --out <sample-panic-feed.json> --panic-targets <id1>,<id2>,...');
  exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  exit(1);
});
