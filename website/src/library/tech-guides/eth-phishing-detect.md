# MetaMask `eth-phishing-detect` integration

chromatika ships with phishing protection that uses Chrome's declarativeNetRequest (dNR) dynamic rules. flagged domains get redirected to a bundled warning page. the rule list is bundled at install time and refreshed daily from MetaMask's `eth-phishing-detect` repo.

## what the dependency provides

`eth-phishing-detect` is an npm package + a remote `config.json` of known phishing / malicious domains. chromatika uses both:

- bundled package for the install-time list (always available even offline)
- daily fetch of the remote `config.json` for fresh updates

remote URL: `https://raw.githubusercontent.com/MetaMask/eth-phishing-detect/main/src/config.json`

## the data shape

```jsonc
{
  "version": 2,
  "tolerance": 2,
  "fuzzylist": [],                  // domains to fuzzy-match against (typo-squat detection)
  "whitelist": [],                  // explicit allowlist (overrides blocklist)
  "blacklist": [
    "phishing-domain-1.com",
    "phishing-domain-2.com",
    // ...
  ]
}
```

chromatika uses `blacklist` (and increasingly `fuzzylist` for typo-squat detection where dNR allows pattern matching) to build dNR rules.

## the dNR sync flow

```ts
// on install / startup
async function syncPhishingRules() {
  // 1. load bundled list
  const bundled = await import('eth-phishing-detect/src/config.json');

  // 2. try to fetch remote (skip if offline)
  let remote = bundled;
  try {
    const resp = await fetch(REMOTE_PHISHING_URL);
    if (resp.ok) remote = await resp.json();
  } catch (e) {
    // offline; keep bundled
  }

  // 3. build dNR rules (capped at 4900 to leave headroom under chrome's 5000 limit)
  const rules = remote.blacklist.slice(0, 4900).map((domain, idx) => ({
    id: idx + 1,
    priority: 1,
    action: {
      type: 'redirect',
      redirect: {
        regexSubstitution: `${chrome.runtime.getURL('phishing-warning.html')}?blocked=${domain}`,
      },
    },
    condition: {
      urlFilter: `||${domain}^`,                     // matches any path on the domain
      resourceTypes: ['main_frame'],
    },
  }));

  // 4. update dNR
  await chrome.declarativeNetRequest.updateDynamicRules({
    addRules: rules,
    removeRuleIds: previousRuleIds,
  });

  await chrome.storage.local.set({ phishing_last_sync_ms: Date.now() });
}

// schedule daily refresh
chrome.alarms.create('chromatika-phishing-refresh', { periodInMinutes: 24 * 60 });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'chromatika-phishing-refresh') void syncPhishingRules();
});
```

key points:
- bundled list runs first (works offline)
- remote refresh on install / startup / daily alarm
- 4900 cap leaves chrome's 100-rule headroom for future features (e.g. user allowlist)
- `urlFilter: ||${domain}^` matches the domain at any subdomain depth, any path

## the redirect destination

flagged domains route to `phishing-warning.html` bundled with the extension:
```
chrome-extension://<id>/phishing-warning.html?blocked=phishing-domain.com
```

the warning page reads `?blocked=` and displays "this domain (phishing-domain.com) is flagged as phishing. proceed at your own risk." plus a "go back" button. there's no override-and-proceed flow today (could add behind a "type the domain to confirm" pattern; tracked).

## manual domain check

for non-navigation contexts (e.g. checking whether a dapp connect request comes from a flagged domain):

```ts
async function checkPhishing({ host }): Promise<boolean> {
  const list = await getCachedPhishingList();
  return list.blacklist.includes(host) || matchFuzzy(host, list.fuzzylist);
}
```

[connect-dapp.md](/library/user/connect-dapp) (user-guides) calls this **before** showing the connection approval popup. flagged domains never get a chance to prompt.

## cache + storage

- `chromatika_phishing_cache_v1` (chrome.storage.local): the most recent fetched config + sync timestamp
- bundled fallback: `import('eth-phishing-detect/src/config.json')` direct dependency

## the dNR limit

chrome's `declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_RULES` is 5000. we use 4900 to leave headroom. if `eth-phishing-detect` ever pushes past 4900 entries (it's been growing slowly, currently ~3500), chromatika will start truncating. priorities:
1. exact-match blacklist first (most directly malicious)
2. fuzzy-match patterns next (typo-squats)

## the `@onsol/tldparser` companion

`@onsol/tldparser` is a small dep used for TLD parsing in phishing heuristics ("does this domain look like it's trying to impersonate a legit one"). lightweight wrapper around the public-suffix list.

## library

- `eth-phishing-detect` for the bundled list + remote URL (just the config.json; we don't import their JS validators since we're using dNR for matching)
- `@onsol/tldparser` for TLD heuristics
- `chrome.declarativeNetRequest`, `chrome.alarms`, `chrome.storage.local`
- internal: `wallet-extension/src/background/phishing.ts` for the sync logic
- internal: `wallet-extension/src/phishing-warning.html` for the warning page

## related

- [chrome-declarativenetrequest.md](/library/tech/chrome-declarativenetrequest) - the dNR primitive
- [phishing-protection.md](/library/user/phishing-protection) (user-guides) - the user-facing surface
- [connect-dapp.md](/library/user/connect-dapp) (user-guides) - where `checkPhishing` gates connections
