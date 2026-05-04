/**
 * buffer-polyfill.ts
 *
 * @ledgerhq/devices (hid-framing.js), bitcoinjs-lib, and @solana/web3.js 1.x
 * all reference `Buffer` as a Node global. browsers don't have it.
 * import this file at the very top of every entry point so the global exists
 * before any dependency code runs.
 */
import { Buffer } from 'buffer';

if (typeof globalThis.Buffer === 'undefined') {
  (globalThis as any).Buffer = Buffer;
}

if (typeof (globalThis as any).process === 'undefined') {
  (globalThis as any).process = {
    env: { NODE_ENV: 'production' },
    browser: true,
    version: 'v18.0.0',
    versions: {},
    platform: 'browser',
    nextTick: (cb: () => void) => setTimeout(cb, 0),
    stdout: { write: () => {} },
    stderr: { write: () => {} },
  };
}
