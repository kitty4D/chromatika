# how to use chromatika safety alerts

chromatika polls a signed feed every 5 minutes for in-the-wild attack reports (phishing sites, drainer contracts, scam dapps). verified alerts surface as in-app banners, chrome notifications (for critical), and chrome's URL-blocking layer (for critical with affected domains). all alerts are ed25519-signed by an allow-listed publisher; unsigned or wrong-publisher feeds are dropped.

## prerequisites

- chromatika is installed
- chrome's notifications permission was granted on install (manifest declares `notifications`)
- network access to `https://chromatika.dev/safety-alerts.json` (or the user-set custom feed URL) every 5 min

## options at a glance

- **severity filter** at the source: alerts are tagged `critical`, `warning`, or `info`. critical alerts produce all three surfaces (banner + notification + URL block); warning produces banner + notification; info produces banner only
- **mute**: silence chrome notifications and the in-app banner without disabling URL blocking
- **opt-out**: stop the poller entirely. URL-blocking rules clear on TTL expiry. you'll still see expired alerts in history
- **custom feed URL**: override the default with a custom URL (advanced; useful for testing or self-hosted feeds)
- **alert history**: every verified alert ever seen, regardless of dismiss / expire status, capped at 200
- **dev injection** (developer build only): paste a signed alert JSON to test the rendering / action pipeline locally

## how to view active alerts

1. active alerts (non-dismissed, non-expired) show as a banner near the top of the wallet, color-coded by severity
2. expand the banner to see the long-form body (markdown, capped at 4000 chars), affected domains, and the alert publisher
3. dismiss to remove from the banner; the alert stays in history with a "dismissed" tag

## how to mute alerts

1. mute toggle silences chrome notifications + the in-app banner
2. URL-blocking dNR rules **stay active** when muted - mute means "stop yelling," not "ignore threats"
3. unmute restores both surfaces

## how to opt out entirely

1. opt-out flag stops the 5-min poller
2. existing dNR rules clear on their per-rule TTL alarm (each rule has its own expiry timer)
3. alert history remains readable; you just stop fetching new alerts
4. unsetting opt-out resumes polling immediately + runs an immediate poll to catch up

## how to set a custom feed URL

1. in the alerts settings, paste a custom feed URL
2. saves trigger an immediate poll against the new URL
3. useful for: self-hosted feeds during development, alternative trusted publishers, testing
4. clearing the field reverts to the default (`https://chromatika.dev/safety-alerts.json` or `VITE_ALERTS_FEED_URL` if set at build time)

## how to view alert history

1. expand the alert history section in settings to see every verified alert, sorted by timestamp (newest first)
2. each entry shows: severity icon, title, affected domains, body preview, dismissed flag, publisher pubkey label
3. capped at 200 most recent entries (FIFO eviction)

## how to manually refresh

1. click the refresh button in the alerts settings to force an immediate poll
2. status indicator shows last-poll timestamp + any error from the most recent attempt

## how to view the publisher allowlist

1. expand the publisher allowlist section in settings (advanced)
2. read-only viewer of the bundled `BUNDLED_PUBLISHERS` (pubkey base64 + label)
3. pre-launch: this is a single placeholder dev key. production will replace with a real chromatika-team pubkey

## how to inject a signed alert (developer build only)

1. visible only when `import.meta.env.DEV` is true (developer build)
2. paste a signed alert JSON envelope
3. the wallet runs it through the same `verifySignedAlert` pipeline as a feed-fetched alert (signature check, time-bounds check, allowlist check). a malformed dev alert can't bypass verification
4. used for: testing notification + dNR rendering during local demos when the feed isn't reachable

## how alerts route from the feed to your wallet

at a glance:
1. every 5 minutes, the poller fetches the signed feed JSON
2. each alert in the feed is independently verified (ed25519 signature, publisher allowlist, time bounds)
3. dropped alerts are logged but don't poison the rest of the batch
4. new (not seen before) alerts trigger:
   - banner display (all severities)
   - chrome notification (critical + warning, unless muted)
   - dNR redirect rule for each affected domain (critical only) - typing a flagged URL routes to the warning page
5. dismiss / opt-out / mute affect surface visibility but don't bypass verification

## notes

- the feed is anonymous HTTP GET. the wallet doesn't send your address, chain id, or any identifying state. ISP / DNS resolvers can see you're polling chromatika.dev every 5 min, but not what's in your wallet
- the alerts subsystem is **separate** from the existing `eth-phishing-detect` MetaMask blocklist (which has its own daily refresh and ~3500 bundled domains). both layers compose: eth-phishing-detect rules use IDs 1-4900; chromatika alerts rules use IDs 10000-19999. no collision
- `info`-severity alerts only show as in-app banners. they don't trigger notifications or URL blocks. typical use: educational reminders, soft informational nudges
- if a critical alert lists a domain you legitimately use (false positive), report it. there's no in-wallet allowlist override today; the only fix is upstream feed correction. tracked future
- alert IDs are content-stable: the same alert (same id) won't double-trigger notifications even if it appears in multiple feed fetches
