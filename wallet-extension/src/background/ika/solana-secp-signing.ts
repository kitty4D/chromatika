/**
 * ika Solana base: EVM / BTC mock path uses `approve_message` (Secp256k1 scheme) + gRPC `Sign`
 * with `ApprovalProof::Solana` (see `signing.ts` + `solana-grpc-client.ts`).
 * set to false only if you need to hard-block secp signing on Sol ika base again.
 *
 * see `wallet-extension/docs/SOLANA_IKA_LIMITS.md` and `skills/ika-solana-prealpha/references/grpc-api.md`.
 */
export const IKA_SOLANA_SECP_SIGNING_IMPLEMENTED = true;
