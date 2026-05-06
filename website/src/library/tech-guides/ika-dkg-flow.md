# ika DKG flow

DKG (distributed key generation) is the protocol step where chromatika and the ika network jointly produce a new dWallet. neither party ever sees the full signing key. at the end, the dWallet exists on-chain (Sui object id or Solana PDA) with a public key both parties have agreed on, and chromatika holds its share inside `UserShareEncryptionKeys`.

## prerequisites

- chromatika vault is unlocked
- the active dWallet Vault is funded with IKA + SUI (Sui base) or SOL (Solana base) above the minimum required by the ika dynamic pricing
- a `UserShareEncryptionKeys` per curve has been derived locally (from the vault's seed source)
- on Solana base: `VITE_SOLANA_IKA_BASE=true`, in-extension fee-payer keypair has SOL for `approve_message` gRPC fees

## the call

```
createDWallet({ curve: 'SECP256K1' | 'ED25519' })
```

dispatches to the right adapter via `getIkaAdapter(session, baseChain)`:

- Sui base: builds a Sui PTB through `IkaTransaction`
- Solana base: drives the protocol via `SolanaIkaGrpcClient` over gRPC

## Sui base DKG (PTB-driven)

```
1. read current ika pricing
   pricing = await getRequiredCoinAmounts(ikaClient)
   // queries coordinatorInner.pricing_and_fee_manager.current.pricing_map
   // returns minimum IKA + SUI amounts plus a 10% buffer

2. build the PTB
   tx = new IkaTransaction()

   // split coins for the call
   [ikaCoin] = tx.splitCoins(IKA_COIN_OBJECT, [pricing.ikaAmount])
   [suiCoin] = tx.splitCoins(SUI_GAS, [pricing.suiAmount])

   // requestDWalletDKG takes &mut Coin<IKA> and &mut Coin<SUI>
   // returns a multi-value tuple - use indexed access (dkgResult[0])
   dkgResult = tx.requestDWalletDKG({
     curve,
     ikaCoin,
     suiCoin,
     userPublicKey: usk.publicKey,
   })

   // CRITICAL: ika coin args are &mut references, not by value
   // the split coins survive the moveCall; they MUST be transferred back to owner
   tx.transferObjects([ikaCoin, suiCoin], owner)

3. simulate first
   - if simulation fails with abort code 1 = insufficient IKA
   - if simulation fails with abort code 2 = insufficient SUI
   - if "Unused result without the drop ability" → forgot the transferObjects in step 2

4. submit the PTB
   - signs with the HD fee-payer keypair (Sui ed25519)
   - Sui RPC broadcasts, returns digest

5. wait for the DKG output event
   - the network publishes events when the DKG round completes
   - chromatika reads events via SuiGraphQLClient (client.core.*)

6. dWallet is now in awaiting_key_holder_signature state
   - encrypted user share lives on-chain
   - continue to ika-accept-share-zerotrust.md
```

## Solana base DKG (gRPC-driven)

```
1. derive needed gRPC parameters
   - dwallet_attestation_bytes from the user share encryption key
   - approve_message signed by the in-extension fee-payer keypair

2. request DKG over gRPC
   await ikaClient.requestDWalletDKG({
     curve,
     userPublicKey,
     dwalletAttestationBytes,
     approveMessage,
   })

3. on success, persist:
   - record.dwalletMeta[].dwalletAttestationBytesB64
   - record.dwalletMeta[].dwalletPublicKeyB64
   - record.dwalletMeta[].baseChain = 'solana'

4. dWallet flips to awaiting_key_holder_signature
5. continue to ika-accept-share-zerotrust.md
```

note: Solana ika base is pre-alpha. all signatures come from a single mock signer; the protocol is not finalized. **never** trust Solana-base DKG output for real value.

## the multi-value return value

`requestDWalletDKG` returns **multiple values** in the PTB result. chromatika reads `dkgResult[0]` (indexed access). compare:

- `requestSign` and `requestReEncryptUserShareFor` return **no values** (void)
- `requestGlobalPresign` returns **a single value with drop ability**, safe to ignore

if you write your own ika PTBs and forget the indexed access, you get type errors during PTB construction.

## dynamic pricing

ika prices ika operations dynamically based on network load. **never hardcode coin split amounts** - always go through `getRequiredCoinAmounts(ikaClient)`. abort codes:

- code 1 = insufficient IKA (the price you supplied was less than the current `pricing_map.ikaAmount`)
- code 2 = insufficient SUI (same but for SUI)

these abort during simulation if your split is too low. retry with a fresh `getRequiredCoinAmounts` quote.

## where the user share lives after DKG

- **Sui base**: encrypted on-chain in an `EncryptedUserSecretKeyShare` object, owned by the user's encryption-key address. transferable via re-encryption (see [ika-re-encrypt-transfer.md](/library/tech/ika-re-encrypt-transfer))
- **Solana base**: in a Solana program account; same logical role but Solana account model

chromatika **does not** locally hold the unencrypted user share. it derives `UserShareEncryptionKeys` from the seed at unlock and uses those keys to encrypt / decrypt the on-chain share material as needed.

## what doesn't work

- **DKG without funding**: the PTB simulation aborts. fund the vault first
- **DKG with mismatched curve / `userPublicKey`**: the network rejects. ensure the USK passed matches the curve you're requesting
- **DKG on a locked wallet**: tRPC procedure fails with "wallet locked"; unlock first

## library

- `@ika.xyz/sdk` `IkaTransaction`, `IkaClient`, `requestDWalletDKG`
- `@ika.xyz/pre-alpha-solana-client` `SolanaIkaGrpcClient`
- `@mysten/sui` for PTB construction (used by `IkaTransaction`)
- internal: `wallet-extension/src/background/ika/dwallet-lifecycle.ts` for the orchestration
- internal: `wallet-extension/src/background/ika/pricing.ts` `getRequiredCoinAmounts`
- internal: `wallet-extension/src/background/ika/ika-adapter.ts` for `getIkaAdapter` dispatch
