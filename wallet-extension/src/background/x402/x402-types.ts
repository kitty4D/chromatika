/**
 * x402 v2 wire types.
 *
 * aligned with the spec at github.com/x402-foundation/x402 (skill ref:
 * `skills/x402-everything/references/headers-and-payloads.md`). v1 of the chromatika integration
 * targets:
 *   - Solana only (`network: "solana:..."`)
 *   - `exact` scheme only
 *   - USDC only (`asset: <usdc mint>`); other SPL tokens land later
 *
 * the three v2 headers all carry base64-encoded JSON. helpers here encode/decode but never
 * sign: signing lives in `x402-solana-signer.ts` (next slice) and gates on a popup approval.
 */

export const X402_VERSION = '2.0' as const;

export const X402_HEADER_PAYMENT_REQUIRED = 'payment-required' as const;
export const X402_HEADER_PAYMENT_SIGNATURE = 'payment-signature' as const;
export const X402_HEADER_PAYMENT_RESPONSE = 'payment-response' as const;

export const X402_SOLANA_USDC_MINT_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
// Solana mainnet CAIP-2 (genesis hash short form per CAIP-2). Devnet uses a different id.
export const X402_SOLANA_MAINNET_CAIP2 = 'solana:5eykt4UsFzeyGoCDNW2CFsvHvfJBqJ3zQcsKqt486dx';

export type X402Scheme = 'exact';
export type X402Chain = 'solana' | 'evm';

export type PaymentRequirements = {
  x402Version: string;
  scheme: X402Scheme | string;
  /** CAIP-2 (e.g. 'solana:5eykt...', 'eip155:8453') */
  network: string;
  /** amount in the asset's smallest unit, as a string to avoid JS number precision loss. */
  maxAmountRequired: string;
  /** SPL mint address on Solana, ERC-20 contract on EVM, or chain-native asset id. */
  asset: string;
  /** recipient wallet address (Solana base58 or EVM 0x...). */
  payTo: string;
  resource: string;

  description?: string;
  mimeType?: string;
  outputSchema?: unknown;
  extra?: unknown;
  expiresAt?: number;
};

/** EVM exact-scheme inner payload (EIP-3009 transferWithAuthorization). unused in v1; here so
 * future EVM support drops in without re-shaping the envelope. */
export type EvmExactPayload = {
  signature: string;
  authorization: {
    from: string;
    to: string;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: string;
  };
};

/**
 * Solana exact-scheme inner payload. per the upstream spec
 * (`github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_svm.md`), the
 * payload carries a single field: a base64-encoded, partially-signed Solana versioned
 * transaction. the transaction contains:
 *   - `feePayer` from `PaymentRequirements.extra.feePayer` (facilitator wallet)
 *   - one SPL Token `transfer` instruction (or `transferChecked`) where:
 *       - source = ATA(client owner, mint)
 *       - destination = ATA(payTo, mint)  -- mandated by spec
 *       - owner = client wallet pubkey
 *       - amount = `PaymentRequirements.maxAmountRequired`
 *   - one Memo instruction containing `extra.memo` if present, otherwise a random ≥16-byte
 *     hex-encoded nonce
 *   - a recent blockhash (the facilitator may replace before broadcast in some impls)
 * the client signs over the full serialized message with their wallet's Ed25519 keypair, then
 * partial-sign-serializes the tx so the facilitator's `feePayer` slot stays unsigned.
 *
 * note: the older skill ref doc described a struct with `from / to / amount / mint /
 * validAfter / validBefore / nonce / feePayer` fields directly. that shape is stale relative
 * to the current upstream spec; it represents an earlier draft. we follow upstream.
 */
export type SolanaExactPayload = {
  /** base64 of the partially-signed serialized Solana versioned transaction. */
  transaction: string;
};

export type PaymentPayload = {
  x402Version: string;
  scheme: X402Scheme | string;
  network: string;
  payload: SolanaExactPayload | EvmExactPayload | unknown;
};

export type PaymentResponse = {
  success: boolean;
  /** on-chain tx hash / signature when settled, null on failure. */
  transaction: string | null;
  network: string;
  /** echoes `from`. */
  payer: string;
  errorReason?: string;
};

/* ---- helpers (no signing) ---- */

export function isSolanaCaip2(network: string): boolean {
  return network.startsWith('solana:');
}

export function isEvmCaip2(network: string): boolean {
  return network.startsWith('eip155:');
}

/** browser-safe base64 encode of a JSON-serializable value. */
export function encodeBase64Json(obj: unknown): string {
  const json = JSON.stringify(obj);
  // btoa works on latin-1 strings; encode utf-8 bytes via TextEncoder first to be safe.
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** browser-safe base64 decode + JSON parse. returns null on any failure. */
export function decodeBase64Json<T = unknown>(b64: string): T | null {
  try {
    const bin = atob(b64.trim());
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const json = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

/** pull `host` out of a resource URL or a CAIP-2 reference. lowercased; `null` on parse failure. */
export function sellerHostFromResource(resource: string): string | null {
  try {
    return new URL(resource).host.toLowerCase();
  } catch {
    return null;
  }
}
