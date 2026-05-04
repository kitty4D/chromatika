# how to use chromatika's phishing protection

chromatika ships with phishing detection that uses Chrome's declarativeNetRequest (dNR) dynamic rules. flagged domains get redirected to a bundled warning page. the rule list is bundled at install time and refreshed daily from the MetaMask `eth-phishing-detect` config.

## prerequisites

- chromatika is installed (no separate vault state needed - phishing rules apply install-wide)
- chrome's dNR engine is operational (it always is, this is not user-tunable)

## options at a glance

- **bundled list** loads on `onInstalled` and `onStartup`
- **daily alarm** refetches the MetaMask remote `config.json` when online
- **rule cap**: 4,900 rules used (under the 5,000 dNR limit) so the wallet has headroom for additions
- **redirect**: flagged domains route to `phishing-warning.html?blocked=DOMAIN`
- **manual check**: `checkPhishing` returns true / false for a domain on demand

## how to check a domain on demand

1. submit `checkPhishing` with `host` (e.g. `example.com`)
2. response is true (flagged) or false (not flagged)
3. used by [connect-dapp.md](/library/user/connect-dapp) connection flows pre-approval

## how to refresh the phishing list manually

1. there's no exposed manual-refresh tRPC procedure today. the daily alarm handles refreshes
2. uninstall + reinstall would re-pull the bundled list at install time

## how to know the rules are working

- visiting a known flagged domain (e.g. test phishing URLs from the MetaMask list) routes you to the warning page
- the warning page has a `?blocked=DOMAIN` query param so you can see which host triggered

## notes

- MV3 cannot use blocking `webRequest`, which is why dNR is the chosen mechanism
- daily refetch only runs when online - if the device is offline at the alarm time, the next refetch is whenever it next fires (24h later) or on next chrome startup
- if a domain is mistakenly flagged, the only fix today is filing upstream with `eth-phishing-detect`. chromatika does not have a per-user allowlist override (tracked future)
- [connect-dapp.md](/library/user/connect-dapp) runs `checkPhishing` before showing the connection approval popup - flagged domains never get a connection prompt
