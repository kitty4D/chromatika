// chromatika stub for @ledgerhq/live-network. the real package's main module eagerly calls
// `require('https')` at top level, which crashes in MV3 service workers. we don't actually
// call any of its functions - it's pulled in transitively by Mysten's Sui Ledger wrapper
// services (`@ledgerhq/ledger-trust-service`, `@ledgerhq/ledger-cal-service`) which we also
// don't invoke from chromatika code. see `wallet-extension/docs/STATUS.md` for the full
// trace and `wallet-extension/CLAUDE.md` for the overrides wiring.

/**
 * default export of @ledgerhq/live-network is `newImplementation` - a factory that builds
 * an axios-shaped network instance for Ledger backend HTTP calls. calling it at runtime
 * triggers a clear error so we know if a future upstream bump starts exercising this path.
 *
 * @param {...any} _args
 * @returns {never}
 */
export default function newImplementation(..._args) {
  throw new Error(
    'chromatika-ledger-live-network-stub: live-network was called - this code path is supposed to be dead in chromatika. ' +
      'A dependency is exercising a Ledger backend HTTP call that the wallet does not need. ' +
      'See wallet-extension/CLAUDE.md and stubs/ledger-live-network/index.mjs to widen the stub.',
  );
}
