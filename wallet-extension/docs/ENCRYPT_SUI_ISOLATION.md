# Encrypt.xyz vs Sui ika-base isolation (checklist)

Encrypt is **Solana program + gRPC** only in Chromatika. These rules keep **Sui ika-base** vault behavior unchanged.

- [ ] Encrypt gRPC, protobuf wire, and lab mutations run only when `activeVaultBaseChain === 'solana'` (`assertEncryptSolanaIkaBase` / `isEncryptAllowedForSession`).
- [ ] No Encrypt imports on default Sui hot paths (unlock, Sui balance GraphQL, Sui dapp PTBs, ika Sui presign refill) unless explicitly reviewed.
- [ ] Solana activity Encrypt labels use **Solana RPC** only (`getParsedTransaction`); **do not** change `getSuiActivity`.
- [ ] Bridge telemetry Encrypt tagging applies to **`solana_signTransaction` / `solana_signAllTransactions`** wire inspection only.
- [ ] tRPC Encrypt procedures reject on non-Solana ika-base (router guard or service `labConnection`).
- [ ] UI: Encrypt lab controls render only for **unlocked** vaults with `balances.ikaBase === 'solana'` and lab ika mode Solana.

When adding a new Encrypt surface, re-check the list above.
