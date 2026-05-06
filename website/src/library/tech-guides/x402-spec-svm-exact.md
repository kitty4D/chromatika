# x402 v2 spec - the SVM `exact` scheme

x402 is an HTTP-native micropayment protocol: server returns `HTTP 402 Payment Required` with a `payment-required` header describing what the client needs to pay. client signs a payment, retries with `payment-signature`. server settles, returns 200 with `payment-response`. spec is at `github.com/x402-foundation/x402`. chromatika implements **only the `exact` scheme on Solana** with **USDC mint**.

## what we implement

- spec target: x402 v2.0 ([github.com/x402-foundation/x402](https://github.com/x402-foundation/x402))
- scheme: `exact` (precise USDC amount per request, no price negotiation)
- chain: Solana
- token: USDC mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (SPL token)
- per-scheme reference: [scheme_exact_svm (upstream spec)](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_svm.md)

## what we don't implement

- EVM `exact` scheme (different address format, different transfer mechanic)
- non-USDC tokens
- non-`exact` schemes (e.g. dynamic pricing, subscription bundles)
- HTTPS-CONNECT 402 flows (only HTTP/HTTPS request 402s)

## the wire shape (request)

```
[client] GET /paid-resource HTTP/1.1
[server] HTTP/1.1 402 Payment Required
         content-type: application/json
         payment-required: <base64 PaymentRequirements>

         {"error":"payment required","scheme":"exact","chain":"solana","amount":"100000",...}

[client decodes payment-required, runs through chromatika x402 dispatcher,
 user approves, chromatika signs, retry...]

[client] GET /paid-resource HTTP/1.1
         payment-signature: <base64 PaymentSignature>
[server] HTTP/1.1 200 OK
         payment-response: <base64 PaymentResponse>
         content-type: application/json

         { ...resource body... }
```

## PaymentRequirements

a base64-encoded JSON envelope with these fields (per `exact` SVM scheme):

```jsonc
{
  "scheme": "exact",
  "chain": "solana",
  "network": "solana-mainnet" | "solana-devnet",
  "amount": "100000",                                    // USDC base units (6 decimals → 100000 = $0.10)
  "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",  // USDC mint
  "payTo": "<base58 destination wallet address>",
  "destinationAta": "<base58 destination ATA, optional>",
  "memo": "<optional UTF-8 string>",
  "facilitator": "<facilitator URL or program id>",
  "deadline": 1700000000,                                // unix seconds
  "nonce": "<base64 16 random bytes>"
}
```

key fields chromatika checks:

- `scheme === "exact"` (reject otherwise)
- `chain === "solana"` (reject otherwise)
- `asset === USDC_MINT` (reject otherwise)
- `amount` is a non-negative integer string in base units
- `payTo` is a valid base58 Solana address
- `deadline` is in the future (otherwise reject with "expired")

## PaymentSignature

what chromatika produces and the client retries with:

```jsonc
{
  "scheme": "exact",
  "chain": "solana",
  "transaction": "<base64 serialized Solana versioned transaction>",
  "signature": "<base64 ed25519 signature on the transaction>",
  "signer": "<base58 signer address>",
  "nonce": "<echoed from PaymentRequirements>",
}
```

the **transaction** is a Solana versioned tx that:

1. transfers `amount` USDC from `signer`'s ATA to `payTo`'s ATA (creating destination ATA if needed)
2. includes a Memo v2 instruction with the nonce + optional memo
3. has the right blockhash + fee payer

the client passes this to the server via `payment-signature` header. the server (or its facilitator) **submits** the transaction on-chain to settle, then returns the resource.

## PaymentResponse

after settlement, server returns:

```jsonc
{
  "scheme": "exact",
  "chain": "solana",
  "txHash": "<base58 transaction signature>",
  "settledAt": 1700000123,
  "amountSettled": "100000",
}
```

chromatika reads this in `recordX402Settlement` to flip the receipt status from `pending` to `settled` with the on-chain hash.

## why this design

x402 is "Stripe for HTTP, no Stripe". instead of:

- API keys (manual issuance, manual rotation, server has to issue + track)
- monthly subscriptions (per-user account creation)
- ad-supported (privacy-hostile, low margin)

x402 lets:

- API providers gate any endpoint on a per-request payment
- API consumers (especially AI agents) pay micropayments per call without prior signup
- the facilitator settles on-chain so neither party needs trust

USDC on Solana is the natural choice: cheap fees (~$0.0001/tx), fast finality (~400ms), stable value (USD-pegged).

## the ed25519 deterministic-sig advantage

because Solana ed25519 is deterministic per RFC 8032, the same inputs (USDC amount, recipient ATA, blockhash, fee payer, memo) **always produce the same signature**. this matters for two reasons:

1. the WalletConnect path (`x402-walletconnect-signer.ts`) where the signature comes from a Seeker / Phantom phone over the WC relay - the ed25519 key never leaves the phone, so determinism makes the wallet's signature predictable / verifiable
2. replay protection comes from `nonce` + `deadline` rather than from "the same tx can't be signed twice"; otherwise determinism would let an attacker re-submit the same tx multiple times. servers MUST validate nonce uniqueness

## chromatika's implementation files

- `src/dapp-interface/x402-fetch-wrapper.ts` - injected `fetch` interceptor on every page
- `src/dapp-interface/x402-dispatch.ts` - background dispatcher (cap check, popup orchestration)
- `src/background/x402/x402-solana-build.ts` - tx construction (versioned tx + ATA derivation + SPL transfer + Memo v2)
- `src/background/x402/x402-solana-signer.ts` - ika MPC signing path
- `src/background/x402/x402-walletconnect-signer.ts` - WC signing path
- `src/background/x402/x402-caps.ts` - per-counterparty + global daily caps
- `src/background/x402/x402-receipts.ts` - 200-most-recent receipt log
- `src/ui/components/X402ApprovalScreen.tsx` - approval popup

## related

- [x402-fetch-interception.md](/library/tech/x402-fetch-interception) - the page-side interception
- [x402-solana-tx-build.md](/library/tech/x402-solana-tx-build) - the tx construction details
- [x402-caps-receipts.md](/library/tech/x402-caps-receipts) - the spending controls + receipt log
