# how to set the dapp consent mode

chromatika has a **consent mode** that controls how strict the wallet is about non-essential dapp prompts. today this affects the bulk-signing primitives like Solana's `signAllTransactions`.

## prerequisites

- a Chromatika vault is unlocked

## options at a glance

- **compat** (default): relaxed mode. bulk-sign primitives go through with one prompt, matching the behavior most non-EVM dapps expect.
- **strict**: each item in a bulk operation prompts independently (where the underlying primitive supports per-item consent)

## how to view the current consent mode

1. call `getDappConsentMode`
2. response is `'compat'` or `'strict'`

## how to switch consent mode

1. submit `setDappConsentMode` with `mode: 'compat' | 'strict'`
2. takes effect immediately for the next dapp request
3. existing connections keep their permission entries; only the prompting behavior changes

## notes

- compat mode does not auto-approve connections - the dapp connect prompt always runs (see [connect-dapp.md](/library/user/connect-dapp))
- non-EVM connect uses strict consent gates that mirror EVM patterns regardless of this mode (per architecture-final.html); the mode mainly tunes bulk-sign UX
- if a dapp expects a specific behavior and isn't getting it, check the consent mode here before assuming the dapp is broken
