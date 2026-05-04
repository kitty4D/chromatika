# how to send native BTC

transfer BTC from your active SECP256K1 dWallet's P2WPKH (segwit bech32) address to another Bitcoin address. chromatika supports segwit and taproot addresses on the receiving side and uses presign material from the SECP256K1 ECDSA pool.

## prerequisites

- a Chromatika vault is unlocked
- the active dWallet has SECP256K1 (see [create-dwallet.md](/library/user/create-dwallet))
- the active Bitcoin network (mainnet / testnet) is set
- the dWallet's P2WPKH address has enough BTC to cover `amount + fee`
- the SECP256K1_ECDSA presign pool has at least one entry (see [presign-pool.md](/library/user/presign-pool))

## options at a glance

- **network**: mainnet or testnet (signet is also configurable in custom networks per the registry)
- **amount**: BTC in human-readable units (sats handled internally)
- **recipient**: any valid Bitcoin address (P2WPKH, P2TR, legacy)

## how to send

1. read your P2WPKH + P2TR addresses with `getBtcAddresses` (passing the desired `network`)
2. submit `sendBtcNative` with: `to`, `amountBtc`
3. background builds a UTXO transaction (bitcoinjs-lib), signs via ika MPC + SECP256K1_ECDSA presign, broadcasts via the configured Esplora endpoint
4. tx id returns once accepted by the mempool

## how to switch networks

1. call `setActiveBitcoinNetwork` with the `networkId`
2. submit `sendBtcNative` - it uses the active network's Esplora client

## notes

- chromatika's Bitcoin send uses bitcoinjs-lib for tx building; signing comes from ika MPC. P2TR (taproot) sending uses the SECP256K1_TAPROOT presign pool; P2WPKH uses SECP256K1_ECDSA
- dWallet-based BTC ops on Solana base are gated today (`assertNotSolanaBaseForSecpSigning`); BTC sends require Sui-base
- Ledger Bitcoin signing exists as a hardware account path (PSBT via `hw-app-btc@10.x`); Trezor BTC PSBT is currently unsupported
- if you see "insufficient signature material" on a send, check the presign pool counts and refill (see [presign-pool.md](/library/user/presign-pool))
