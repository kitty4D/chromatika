# additional notes

## solana mobile wallet adapter: remote QR on seeker vs production wallets

while building chromatika’s solana-base hardware path (seeker / phone via remote MWA and the public reflector), **the remote association QR flow appears broken for every production wallet tested on a solana seeker**. scanning `solana-wallet:/v1/associate/remote?...` opens the wallet activity briefly (or leaves a spinner that never finishes), but **the phone never opens a websocket to the reflector**. on the desktop side the dapp session typically sees one frame (`REFLECTOR_ID`) and **never receives `APP_PING`**, then times out around 90 seconds. the same dapp, spec, and reflector **pair cleanly with `fakewallet` built from the mobile-wallet-adapter repo** (`./gradlew :fakewallet:installV1Debug`), which strongly suggests the regression lives in shipped wallet binaries, not in chromatika’s integrator code.

**tracked upstream:** [issue #1484: Remote MWA QR flow silently fails on all prod Seeker wallets, but works on fakewallet flavor v1](https://github.com/solana-mobile/mobile-wallet-adapter/issues/1484)

the report reproduces against **both** `development.reflector.solanamobile.com` and **custom reflectors** (same class of failure), and across phantom, solflare, jupiter, backpack, and the seeker native wallet. extra findings called out in that thread worth fixing in the ecosystem:

- **`RemoteAssociationUri.createScenario` drops `associationProtocolVersions`:** the remote path never forwards the parsed `&v=v1` hint into `RemoteWebSocketServerScenario`, so remote flows can stick to `LEGACY` and send `HELLO_RSP` without session properties even when the URL advertises v1. the local URI path reportedly propagates this correctly; the remote variant is called out as about a one-line fix.
- **reflector frame size:** spec language around a 4 kb cap is tight for real authorize payloads once `wallet_icon` and per-account icons ship as inline base64 data URLs (example sizes in the issue land nearer **15 kb** for fakewallet-style responses). either the spec needs to move, or icons need to move out of the authorize response.

chromatika’s docs already warn that **self-hosted reflectors can look fine in infra while phones never complete pairing**; this seeker + prod-wallet matrix is the concrete bug report behind that pain.

## agent skills: solana pre-alpha (ika + encrypt), x402, web3 wallets

**published package repo (install via `npx skills`, drift audits, test suite):**

[github.com/kitty4D/ika-and-encrypt-solana-prealpha-skills](https://github.com/kitty4D/ika-and-encrypt-solana-prealpha-skills)

that repository is an **unofficial** bundle aimed at ai agents working on dwallet labs solana **pre-alpha** stacks. highlights from the project:

| piece | what it is |
| --- | --- |
| `skills/ika-solana-prealpha/` | ika dWallet signing, gRPC, solana pre-alpha program surfaces, audit + drift rules |
| `skills/encrypt-solana-prealpha/` | encrypt fhe graphs, gRPC, `execute_graph` paths separate from ika signing |
| `README-X402.md` | vendor-neutral x402 / pay-per-call / agent commerce notes |
| `CHANGELOG-*.md`, `EVAL-*.md` | human-readable skill change logs and eval hooks |
| audit scripts | `node skills/.../scripts/audit-*.mjs --root=/path/to/app` with staleness gates and a **skill-vs-codebase drift catalog** (`references/drift-rules.mjs`) |
| tests | ~186 fast node tests covering structure, citations, drift engine behavior, and routing probes |

example install lines from upstream:

```bash
npx skills add https://github.com/kitty4D/ika-and-encrypt-solana-prealpha-skills/tree/main/skills/ika-solana-prealpha
npx skills add https://github.com/kitty4D/ika-and-encrypt-solana-prealpha-skills/tree/main/skills/encrypt-solana-prealpha
```

**in this monorepo**, chromatika continues to ship first-class cursor skills including:

- **`web3-wallet-dev`**: `skills/web3-wallet-dev/SKILL.md` (multi-chain extension wallet architecture, ika flows, signing)
- **`x402-everything`**: `skills/x402-everything/SKILL.md` (general x402 protocol evaluation: pay-per-call, facilitator choice, scheme limits, agent patterns)

treat the **github skills package** as the portable, tested bundle for ika + encrypt solana pre-alpha.
