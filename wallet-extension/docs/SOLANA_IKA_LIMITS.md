# ika Solana base — product limits (beta)

Chromatika can use **ika Solana pre-alpha** as the ika base chain for a vault. This path is **devnet + mock signer** only.

## capability matrix (Sui base vs Solana base)

| surface | Sui ika base | Solana ika base |
|--------|--------------|-----------------|
| ika `IkaClient` + Sui PTBs (DKG, presign, sign, ika coins) | yes | no (adapter throws on Sui-only reads) |
| dWallet account read (synthetic `ZeroTrustDWallet`) | Sui objects | Solana account via RPC when `solanaConnection` set |
| `getOwnedDWalletCaps` | yes | stub empty list |
| EVM / BTC secp256k1 signing (mock pre-alpha) | yes (Sui PTBs) | yes (`approve_message` Secp scheme + gRPC `Sign` + `solanaIkaGrpc` presigns) |
| Solana dapp ed25519 message path | sha512 ika path via Sui fee stack when configured | gRPC `solanaIkaGrpc` when session unlocked |
| Ledger Sui fee PTBs | yes (local key or `ledgerFeePayerEd25519PublicKeyB64` + Ledger popup) | n/a (fee payer is Solana keypair) |
| Encrypt.xyz (FHE pre-alpha Solana program + gRPC) | **no** (stay off Sui GraphQL and Sui Encrypt hot paths) | **yes** when ika base is Solana (`encrypt-*` modules, lab, optional activity labels) |

## Encrypt.xyz (Solana pre-alpha) vs ika MPC

**Encrypt** here means the **Encrypt.xyz Solana pre-alpha** stack (on-chain program + gRPC `CreateInput` / `ReadCiphertext`, executor, graphs). It is **not** ika dWallet MPC signing; pre-alpha disclaimers on [docs.encrypt.xyz](https://docs.encrypt.xyz/) apply (no production confidentiality guarantees).

**Sui ika-base vaults:** Chromatika does **not** run Encrypt gRPC or Encrypt lab RPC helpers on the default Sui path. Encrypt stays behind `activeVaultBaseChain === 'solana'` guards so **Sui GraphQL balance reads and ika Sui PTBs stay unchanged**. See `docs/ENCRYPT_SUI_ISOLATION.md` for the checklist.

## secp256k1 (EVM, Bitcoin) on ika Solana base

**Pre-alpha mock only** (Solana ika base produces signatures from a single mock signer, not real MPC; do not submit real-value transactions): Chromatika wires Solana `approve_message` with `signature_scheme = Secp256k1` plus gRPC `Sign` (`Keccak256` for EVM-style preimages, `DoubleSHA256` for Bitcoin envelopes / BIP143 preimages) and `PresignForDWallet` for ECDSA. Toggle: `IKA_SOLANA_SECP_SIGNING_IMPLEMENTED` in `solana-secp-signing.ts`.

Solana **ed25519** message signing for dapps stays the separate gRPC path in `signing.ts` (`requestSignEd25519Message`).

## production readiness

Real MPC / final fee economics are still Sui-ika PTB territory for many flows; Solana secp here tracks ika’s **pre-alpha** book (`skills/ika-solana-prealpha/references/grpc-api.md`, `references/instructions.md`). **Taproot** presign refill on Solana is not prioritized in UI signing paths yet.
