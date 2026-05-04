# how to connect a dapp

dapps reach chromatika through page-injected providers (EIP-1193 / EIP-6963 for EVM, Wallet Standard for Sui + Solana, `window.bitcoin`, `window.aptos`). when a dapp asks to connect (`eth_requestAccounts`, Wallet Standard `connect`, etc.), chromatika queues the request and opens an approval popup so you can pick which dWallet(s) the dapp can see.

## prerequisites

- a Chromatika vault is unlocked
- you've decided which dWallet you want to expose to the dapp - the connection scopes to a specific dWallet per curve, not the whole vault
- the dapp's origin is not phishing-flagged (`checkPhishing` runs first; see [phishing-protection.md](/library/user/phishing-protection))

## options at a glance

- **per-origin dWallet selection**: pick a SECP256K1 dWallet (for EVM) and / or an ED25519 dWallet (for Sui / Solana / Aptos)
- **standards supported**: EIP-1193, EIP-6963 (multi-injected discovery), EIP-3085 (`wallet_addEthereumChain`), EIP-3326 (`wallet_switchEthereumChain`), Wallet Standard for Sui + Solana, `window.bitcoin`, `window.aptos`
- **outcome**: approve (with dWallet choice), reject, or close (treated as reject)

## how to fetch the pending connection request

1. when a dapp calls a connect-style method, the wallet enqueues the request and opens the dapp-approval popup
2. popup calls `getDappApprovalRequest` with the request id
3. response contains: requesting origin, requested method, the dWallet choice options (which curves the dapp needs)

## how to approve a connection

1. submit `approveDappConnection` with: id, `approved: true`, and the dWallet ids you want exposed:
   - `secpDwalletId` for EVM-style methods
   - `ed25519DwalletId` for Solana / Sui / Aptos-style methods
   - either or both depending on the method - some dapps only need one curve
2. background records the permission in `chromatika_dapp_permissions_v1`, returns the resolved account list to the dapp through the bridge

## how to reject a connection

1. submit `rejectDappConnection` with id and `reason` string
2. dapp receives a JSON-RPC error 4001 (or the equivalent for non-EVM standards)

## how to view what consent options the request has

`getDappApprovalRequest` returns the candidate dWallets the user can pick from per curve - if you only have one ED25519 dWallet, that's the only choice the popup shows for non-EVM methods

## notes

- chromatika never auto-approves connections in the default settings. compat mode (see [dapp-consent-mode.md](/library/user/dapp-consent-mode)) relaxes some prompts but never connections
- the dapp permission is **per origin**, **per curve** - same origin can have a SECP and an ED25519 dWallet selected, but only one of each
- non-EVM connect uses **strict** consent gates that mirror EVM patterns where implemented (per architecture-final.html)
- Sui personal-message signing through the connected origin uses the ika SHA512 path, not Mysten's BLAKE2b - some dapps may not verify until Mysten-intent BLAKE2b parity ships (see [sign-messages.md](/library/user/sign-messages) notes)
