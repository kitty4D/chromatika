# how to find more accounts (post-unlock activity scan + dwallet inventory)

scan your active vault's identity for activity, balances, and dwallet caps you may have on chain that aren't bound to a local sibling vault yet. the entry lives in **settings → "find more accounts"** and is the post-unlock counterpart to the import-time advanced scan.

## what the panel does

three things, depending on the active vault kind:

1. **dwallet inventory + orphan detection** — for any vault kind that owns ika dwallets, lists every owned cap on chain owned by your identity, annotated with the local sibling vault that owns it (or marked **orphan** when no local vault references it)
2. **activity / balance scan** — probes your identity address(es) across Sui mainnet + Solana mainnet + Solana devnet by default; super-pro mode opens EVM L2s, Bitcoin, Aptos, DeSo, Cosmos chains, Polkadot/Kusama
3. **inline sibling-add** — for passkey / hardware / waap / lazor active vaults, one-click "add sibling vault →" mounts the appropriate setup flow inline (no separate page); chromatika auto-picks the next bip44-style ika encryption index

## prerequisites

- wallet is unlocked
- active vault has an identity that supports scanning (anything except `importedKey` / `dwalletAnchored`, which are single-account by design)

## how to scan an HD vault's other accounts

1. open settings → "find more accounts"
2. (HD active vault) you'll see two input fields:
   - **recovery phrase** — paste the phrase used to create this vault. only held in memory for the scan; never persisted
   - **password** — chromatika password (for encrypting the new sibling vaults)
3. (optional) expand "super-pro: scan more chains" inside scan results to opt into evm L2s / btc / aptos / cosmos / polkadot
4. click "scan now"
5. results table shows each bip44 account index with addresses + balances + dwallet count
6. check the accounts you want to import as additional vaults
7. click "import N selected" — runs `importVaultsBatch`, persists one new HD vault record per picked index (each gets its own `accountIndex`)

## how to scan a passkey / seeker / waap / lazor identity

1. open settings → "find more accounts"
2. you'll see a one-line summary of the active vault's identity (e.g. "find more accounts on this passkey identity")
3. click "scan now" — chromatika queries the identity's fixed address (passkey: Sui SIP-9 address; seeker / lazor: Solana pubkey; waap: Sui address) across the default + opted-in chains
4. results show balance + activity per chain, plus the **dwallet inventory** subsection if any caps exist on chain

the dwallet inventory subsection has an amber border + "X orphans" badge when caps > matched-siblings. each cap row shows:
- `{dwalletId-shortened} · {curve} · {status}` — basic chain data
- one of:
  - `· {sibling label} (idx N)` — cap is bound to a known local vault
  - `· orphan` (amber) — cap exists on chain at your identity but no local vault references it

## how to add a sibling vault (bind an orphan)

1. for a passkey / hardware / waap / lazor active vault, click **"add sibling vault →"** in the panel
2. the inline `WalletSetupFlow` mounts in the panel section with `mode='addVault'` and the appropriate setup step preselected (passkey → PasskeyStep, hardware → SeekerStep, etc.)
3. complete the per-method auth dance (re-tap Touch ID / re-pair Seeker / re-login waap / re-portal Lazor)
4. background `add{Hardware,Waap,Lazor,Passkey}Vault` auto-detects the matching identity in your existing payload and picks `max(existingIndices) + 1` for the new sibling's ika encryption index
5. on completion the panel returns to its default state with a green confirmation banner; the active vault is now the new sibling
6. if the chain had an orphan dwallet at the index you just bound, it's now matched — re-running the scan shows the orphan count dropped

## scan result table — reading the rows

- **header**: "checked N {account slot|identity}{s} across M chain{s} in T seconds. K have activity (J suggested)."
- **active rows** (with the purple highlight border): default slot OR rows with non-zero activity / balance / dwallet count
- **empty rows**: hidden behind a "show N empty slots" expander
- **per-row details**: address(es), balance per chain (when non-zero), tx count when probe surfaced one, dwallet count
- **suggested**: rows chromatika auto-checks for the user. the default slot (account 0) is always suggested even if empty; everything with activity is also suggested

## super-pro chain picker

inside the scan results view, expand "super-pro: scan more chains (N available)". checkboxes for:

- **EVM long-tail**: zkSync, Linea, Scroll, Blast, Mantle, Unichain, IoTeX, Bitlayer, Abstract, HyperEVM, MegaETH, ApeChain, Soneium, Tempo (chromatika's main `BUILTIN_EVM` already covers Ethereum, Base, Arbitrum, Optimism, Polygon, BSC, Avalanche, Monad, Ink — those scan via the default-chain set)
- **Bitcoin**: mainnet + signet
- **Aptos**: mainnet + testnet
- **DeSo**: mainnet + testnet
- **Cosmos-SDK chains**: Cosmos Hub, Osmosis, Juno, Stargaze, Akash, Stride, Sei
- **Polkadot / Kusama**: via Subscan REST. note: chromatika derives ed25519 + slip-10 — addresses won't match polkadot.js / Talisman / Nova which default to sr25519 + substrate-native derivation

each opt-in adds one RPC call per candidate. typical scan with all super-pro chains: ~4-8 seconds extra.

## notes

- **lazor placeholder PDA caveat**: vaults onboarded with chromatika v1 (where the lazor smart-wallet PDA was a passkey-pubkey placeholder) get a yellow setup-time note in the scan results saying "lazor smart-wallet PDA not yet resolved; solana probes skipped." the fix is to clear extension storage + re-onboard with the v2 lazor flow that resolves the canonical PDA via `LazorkitClient.getSmartWalletByCredentialHash`
- **scan secrets handling**: HD scan needs the phrase typed into the panel; it's held in component state only and dropped on unmount. password is held the same way. neither persists to chrome.storage
- **rate limits**: the public Subscan tier (Polkadot / Kusama) and DeSo node are rate-limited. running the scan repeatedly may surface "subscan 429" warnings — those are non-fatal and the rest of the result still renders
- **dev mode**: chromatika's dev harness has a `?syntheticInventory=<orphans>:<matched>` URL flag (gated on `import.meta.env.DEV`) for exercising the orphan-detection UI without seeding real vaults. used by the e2e specs only