# Ledger Sui app — versions and practical limits (Chromatika)

This doc is for **operators and devs** debugging `enqueueHardwareSign` → `LedgerSigner` → `@ledgerhq/hw-app-sui`. It is **not** a substitute for Ledger or Mysten release notes.

## npm stack in this repo

| package | role |
|--------|------|
| [`@ledgerhq/hw-app-sui`](https://www.npmjs.com/package/@ledgerhq/hw-app-sui) | thin wrapper re-exporting Mysten’s app |
| [`@mysten/ledgerjs-hw-app-sui`](https://www.npmjs.com/package/@mysten/ledgerjs-hw-app-sui) | actual APDU + chunking implementation |

Pinned versions live in root `wallet-extension/package.json` (bump those lines when updating this section).

## Minimum Sui app version (from Mysten source)

`@mysten/ledgerjs-hw-app-sui` defines a constant **`MIN_VERSION = "1.2.2"`** used when certain **clear-signing / PKI** paths run (e.g. trusted-name flows that call `checkAppVersion` with `throwOnOutdated: true`). Chromatika’s current path calls `signTransaction` with **serialized transaction bytes** only; you should still **treat 1.2.2+ as the floor** for parity with the library and fewer “unsupported instruction” surprises.

**Source of truth:** search `MIN_VERSION` in the installed `@mysten/ledgerjs-hw-app-sui` package after a version bump.

## How the host sends transaction bytes

The Mysten app **does not** send the full raw txn in one APDU. `sendChunks` uses **`chunkSize = 180`** bytes, hashes chunks with **SHA-256** in a linked structure, then runs a **block protocol** with the device. So “max transaction size” is **not** a single documented constant in this layer; it is bounded by **device memory**, **firmware**, **app version**, and **Ledger transport limits**.

## Practical limits vs ika PTBs

- **Large PTBs** (many commands, big `TransactionData` BCS) are the first things to fail on-device or time out in WebHID.
- **TBD:** Ledger does not publish a simple “max BCS bytes” number that matches every firmware. If signing fails:
  1. Update **Ledger firmware** and the **Sui** app via Ledger Live.
  2. Confirm app version is **≥** the Mysten `MIN_VERSION` above (and prefer the latest Sui app).
  3. Retry with a **smaller** PTB (split moves, fewer inputs) to see if failure is size-related.
  4. Compare with the same PTB signed with a **local** fee payer (simulation vs hardware) to isolate device vs builder issues.

## References

- Mysten package: [npm `@mysten/ledgerjs-hw-app-sui`](https://www.npmjs.com/package/@mysten/ledgerjs-hw-app-sui)
- Ledger wrapper: [npm `@ledgerhq/hw-app-sui`](https://www.npmjs.com/package/@ledgerhq/hw-app-sui)
- Chromatika wiring: `wallet-extension/src/ui/hardware/LedgerSigner.tsx`, `wallet-extension/src/background/sui/execute-transaction.ts`
