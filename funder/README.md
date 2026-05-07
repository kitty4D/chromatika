# chromatika team funder

Cloudflare Worker that drips a small amount of mainnet **SUI + IKA** to a freshly-onboarded chromatika user's Sui address so they can create their first 2 dWallets without buying tokens first. mainnet-only, per-address one-shot, daily + optional lifetime caps for anti-abuse.

## what it does

`POST /fund` with `{ "recipientAddress": "0x..." }` and a bearer token →

1. validates address shape + checks Durable Object for "already funded ever" + daily/lifetime caps
2. builds one Sui PTB:
   - `tx.splitCoins(tx.gas, [FUNDING_SUI])` → split SUI from gas coin
   - `tx.splitCoins(tx.object(funderIkaCoin), [FUNDING_IKA])` → split IKA from team's largest IKA coin
   - `tx.transferObjects([ikaSplit, suiSplit], recipient)` → transfer both
3. signs with the team Ed25519 keypair from `FUNDER_SUI_PRIVKEY`, executes via `SuiGraphQLClient`
4. records the funding in the Durable Object so repeat calls return 429
5. returns `{ digest, ikaSent, suiSent }`

Endpoints:

| method | path                   | auth                       | purpose                                                                |
|--------|------------------------|----------------------------|------------------------------------------------------------------------|
| GET    | `/healthz`             | none                       | health probe (returns `chromatika-team-funder ok\n`)                   |
| POST   | `/fund`                | `FUNDER_BEARER_TOKEN`      | fund a recipient. 200 / 401 / 400 / 429 / 502                          |
| DELETE | `/address/<addr>`      | `ADMIN_BEARER_TOKEN`       | clear a single address's lifetime dedupe (admin only)                  |

## first-time setup

```bash
cd funder
pnpm install
cp .dev.vars.example .dev.vars
# edit .dev.vars with FUNDER_SUI_PRIVKEY + FUNDER_BEARER_TOKEN
pnpm dev   # local Worker on http://localhost:8787
```

verify locally with curl:
```bash
curl -X POST http://localhost:8787/fund \
  -H 'Authorization: Bearer dev-token-replace-me' \
  -H 'Content-Type: application/json' \
  -d '{"recipientAddress":"0xYOUR_TEST_ADDRESS"}'
```

a successful run returns `{"digest":"...","ikaSent":"...","suiSent":"..."}`. look up the digest on `https://suiscan.xyz/mainnet/tx/<digest>` to confirm both `Coin<IKA>` and `Coin<SUI>` arrived.

## production deploy

```bash
# 1. set production secrets (one-time)
pnpm wrangler secret put FUNDER_SUI_PRIVKEY
pnpm wrangler secret put FUNDER_BEARER_TOKEN
# optional:
pnpm wrangler secret put LIFETIME_CAP
pnpm wrangler secret put ADMIN_BEARER_TOKEN

# 2. deploy to staging first
pnpm deploy:staging

# 3. once staging passes smoke testing on a fresh chromatika install, promote to prod
pnpm deploy

# 4. tail logs during the first wave of users
pnpm tail
```

set the same `FUNDER_BEARER_TOKEN` value as `VITE_FUNDER_TOKEN` in the chromatika build, and `VITE_FUNDER_URL` to the prod hostname (e.g. `https://fund.chromatika.xyz`).

## funding amounts (must be calibrated before first deploy)

`src/config.ts` hardcodes per-session SUI + IKA amounts and the scope multiplier. The fallback values are the same as `@ika.xyz/sdk`'s empty-pricing-map fallback (10_000_000 each). **Before first deploy, run a one-time read of mainnet pricing and bump the constants:**

```bash
# inside the wallet-extension package, where `@ika.xyz/sdk` is installed:
cd ../wallet-extension
pnpm exec tsx -e "
import { IkaClient } from '@ika.xyz/sdk';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
const client = new IkaClient({ suiClient: new SuiGraphQLClient({ url: 'https://sui-mainnet.mystenlabs.com/graphql' }) /* + ika config */ });
// ...replicate getRequiredCoinAmounts and print
"
```

then update `funder/src/config.ts`:
- `PER_SESSION_SUI = max(observed_mainnet_sui_amount, current_fallback)`
- `PER_SESSION_IKA = max(observed_mainnet_ika_amount, current_fallback)`
- date-stamp the comment block above the constants

revisit quarterly — on-chain pricing can be governance-updated.

## anti-abuse layers

1. **bearer token** — bundled in chromatika builds, so essentially public. NOT relied on as the primary defense.
2. **per-address one-shot** (Durable Object) — same address can never be funded twice. clearable via admin `DELETE /address/<addr>`.
3. **`DAILY_CAP`** — env var, default 25. Worker rejects with 429 when the rolling per-day count hits the cap. raise via `wrangler secret put DAILY_CAP` after observing real usage. resets at UTC midnight.
4. **`LIFETIME_CAP`** (optional) — hard ceiling on cumulative fundings. matches the funder wallet's expected initial top-up so a leaked bearer cannot drain past the funded amount.

if abuse happens despite layers 2-4, graduate to per-install signed tokens issued by a separate signup endpoint. that's a v2 problem.

## clearing an address (admin)

```bash
curl -X DELETE 'https://fund.chromatika.xyz/address/0xRECIPIENT' \
  -H 'Authorization: Bearer <ADMIN_BEARER_TOKEN>'
```

returns `{"cleared":true}`. the recipient can be funded again on the next request.

## monitoring

`pnpm tail` streams structured log lines per request. watch for:
- `funded ok` — happy path, includes digest + recipient
- `rate-limit hit reason=...` — 429 with reason (`already_funded` | `daily_cap` | `lifetime_cap`)
- `sui exec failed` — 502 with the underlying error

balance check: poll the funder address on `https://suiscan.xyz/mainnet/account/<addr>` periodically. if SUI or IKA falls below 2-day projected spend, top up. (a separate cron Worker that pages on this is a v2 nice-to-have.)
