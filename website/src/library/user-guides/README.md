# chromatika user guides

high-level "how to" reference for every feature in chromatika. each guide lists prerequisites + steps + every available option for that feature, no UI references.

these pages are published on the chromatika site alongside the extension; they are aimed at testers, devs, and AI agents who need to know "what the wallet can do and what conditions / inputs each operation requires" without reading the source.

chromatika is **pre-release** - storage and crypto are dev-only, and Solana ika base is a pre-alpha mock signer. labels and disclaimers in each guide reflect that.

## vault & authentication

- [create a vault](/library/user/create-vault) - first-time setup with a fresh BIP39 mnemonic
- [import a vault from a mnemonic](/library/user/import-vault-mnemonic) - restore from existing BIP39 phrase
- [import a vault from a private key](/library/user/import-vault-private-key) - sui bech32 or solana 64-byte secret
- [unlock and lock](/library/user/unlock-and-lock) - password / passkey / hardware / recovery unlock + autolock + manual lock
- [passkey-backed vault](/library/user/passkey-vault) - WebAuthn + PRF register / sign / recover
- [WAAP-backed vault](/library/user/waap-vault) - @human.tech email / phone / social login
- [Lazor-backed solana vault](/library/user/lazor-vault) - solana smart-wallet passkey
- [hardware-only vault](/library/user/hardware-vault) - Solana MWA / Seeker as primary identity
- [manage multiple vaults](/library/user/manage-vaults) - list, add sibling, switch, rename, remove, cross-chain reuse
- [BIP39 recovery words](/library/user/recovery-words) - using the recovery branch to unlock passkey / WAAP / Lazor envelopes

## dWallet management

- [create a dWallet](/library/user/create-dwallet) - DKG per curve + zero-trust accept-share
- [manage dWallets](/library/user/manage-dwallets) - discover, set active, names, ordering, address book, register encryption key
- [transfer a dWallet](/library/user/transfer-dwallet) - initiate, parse digest, accept inbound transfer
- [presign pool](/library/user/presign-pool) - query and refill the three presign pools

## hardware wallets

- [Ledger](/library/user/ledger) - WebHID pair + EVM / Sui / Solana / Bitcoin signing
- [Trezor](/library/user/trezor) - account discovery + EVM / Solana signing (no BTC PSBT, no Sui)
- [Solana MWA local](/library/user/seeker-local) - Android same-device Mobile Wallet Adapter
- [Solana MWA remote](/library/user/seeker-remote) - desktop ↔ phone QR-paired remote MWA
- [WalletConnect](/library/user/walletconnect) - WC remote signer (notably for the x402 Solana path)

## sending & signing

- [send EVM](/library/user/send-evm) - native + ERC20 + contract calls from the wallet UI
- [send SUI](/library/user/send-sui) - native SUI from the HD fee-payer
- [send Solana](/library/user/send-solana) - native SOL from the ED25519 dWallet
- [send Bitcoin](/library/user/send-bitcoin) - native BTC from the SECP256K1 dWallet's P2WPKH address
- [approve a dapp transaction](/library/user/approve-dapp-tx) - reviewing dapp `eth_sendTransaction` requests
- [sign messages across chains](/library/user/sign-messages) - personal_sign / typed-data / Sui / Solana / Aptos / BTC

## dapp bridge

- [connect a dapp](/library/user/connect-dapp) - approving connection requests with per-curve dWallet selection
- [manage dapp permissions](/library/user/manage-dapp-permissions) - list, revoke, switch active address per origin
- [dapp consent mode](/library/user/dapp-consent-mode) - compat vs strict
- [phishing protection](/library/user/phishing-protection) - dNR rules + manual checks

## networks

- [manage active networks](/library/user/manage-networks) - per-chain switching, vault vs dWallet tier, EVM RPC health, ika base mode
- [add custom networks](/library/user/add-custom-network) - manual EVM + Chainlist search + remove

## settings

- [app settings](/library/user/app-settings) - advanced mode, help hints, theme, explorer preferences
- [media safety mode](/library/user/media-safety-mode) - NFT / Ordinal image filtering
- [price source priority](/library/user/price-source-priority) - reorder the price waterfall

## agent surface, swap, x402

- [agent surface (MCP)](/library/user/agent-surface-mcp) - enable, port, token, approve sign, native messaging host
- [SUI → IKA swap](/library/user/sui-ika-swap) - Aftermath router quote + execute
- [x402 HTTP payments](/library/user/x402-payments) - approve fetch-intercepted USDC payments, caps, receipts

## safety + activity

- [safety alerts](/library/user/safety-alerts) - mute / opt-out / view history / set custom feed for the signed-alert subsystem
- [encrypted activity notes](/library/user/activity-notes) - per-tx encrypted notes via the encrypt.xyz pre-alpha backend

## assets, kiosks, staking

- [browse NFTs](/library/user/browse-nfts) - per chain (Sui, EVM, Solana, Aptos, Bitcoin Ordinals)
- [Sui Kiosks](/library/user/sui-kiosks) - listing kiosks and items
- [activity and portfolio](/library/user/view-activity-and-portfolio) - tx history, balances, addresses
- [Ika staking](/library/user/ika-staking) - validators, stake, withdraw

## ika ops

- [ika fee-payer (Solana base)](/library/user/ika-fee-management) - mode, top-up, drain, status

## encryption

- [encrypted dWallet labels](/library/user/encrypted-dwallet-labels) - per-dWallet on-chain label (Solana base, pre-alpha)
- [encryption lab](/library/user/encryption-lab) - encrypted-input creation + ciphertext reads (Solana base, dev / lab)
