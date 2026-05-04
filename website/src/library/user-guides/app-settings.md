# how to configure chromatika app settings

control the cosmetic and ergonomic toggles that don't fit elsewhere - advanced mode, help hints, theme, explorer URL templates, and a couple of personal-touch knobs.

## prerequisites

- a Chromatika vault is unlocked

## options at a glance

- **advanced mode**: toggle expert surfaces (e.g. raw fee-payer addresses, debug fields)
- **help hints**: education / onboarding overlays
- **appearance**: light or dark theme
- **explorer preferences**: which explorer URL template to use per chain (Sui, Solana - per-chain choice + custom template)
- **rocket-seat cosmetics** (if you've discovered them): pilot head, passenger head, animation toggle

## how to toggle advanced mode

1. read with `getAdvancedMode`
2. set with `setAdvancedMode` (boolean)
3. when on, surfaces that show fee-payer addresses, raw payloads, and debug-only state become visible

## how to toggle help hints

1. read with `getUiHelpHints`
2. set with `setUiHelpHints` (boolean)
3. when on, education overlays surface on common screens; turn off if you've memorized the wallet

## how to set theme

1. read with `getAppearance`
2. set with `setAppearance` (`'light' | 'dark'`)
3. takes effect immediately; persisted to chrome.storage

## how to set explorer preferences

1. read with `getExplorerPreferences`
2. set with `setExplorerPreferences`. shape:
   - sui: `{ preset: 'suiscan' | 'suivision' | 'custom', customTemplate?: string }`
   - solana: `{ preset: 'solscan' | 'solanaExplorer' | 'orb' | 'custom', customTemplate?: string }`
3. custom templates use placeholders like `{address}`, `{txDigest}` per the renderer
4. these flow into `ExplorerValueRow` / `explorer-href.ts` so any read-only address / digest in the UI links to the right explorer

## notes

- per the project rule: every read-only UI surface that prints a wallet-facing chain address, dWallet / Cap object id, or on-chain transaction digest should use `ExplorerValueRow` (or a thin wrapper). the explorer preferences here drive those links
- advanced mode does not change behavior - it surfaces information. all signing flows are identical regardless
- help hints are persisted per install, not per vault
