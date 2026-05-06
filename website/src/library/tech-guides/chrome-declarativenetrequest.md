# `chrome.declarativeNetRequest` (dNR)

chromatika uses chrome's declarativeNetRequest (dNR) API for phishing protection. dNR lets extensions register URL-matching rules that chrome enforces at the network layer - block, redirect, modify headers, etc. - without the extension's JS being involved per-request. mandatory for MV3 since blocking `webRequest` was removed.

## why dNR (and not webRequest)

MV2 extensions could intercept network requests via `chrome.webRequest.onBeforeRequest` with a blocking listener that decides per-request whether to allow / redirect / cancel. chrome MV3 removed blocking webRequest for content scripts and most extension contexts, citing security + perf concerns.

dNR is the replacement: declare static / dynamic rules; chrome's network stack matches and acts. extension JS isn't woken per-request - the rules just live in chrome's matching engine.

trade-offs:

- **pro**: faster (no JS hop per request)
- **pro**: SW can stay asleep
- **con**: less flexible (no custom logic per-request)
- **con**: rule count limits (chrome caps at 5000 dynamic rules)

for chromatika's phishing use case, the trade-offs are net-positive: matching ~3500 known-bad domains against navigation requests is exactly what dNR is designed for.

## the rule shape

```ts
const rule = {
  id: 1, // unique within the rule set
  priority: 1, // higher = wins ties
  action: {
    type: "redirect",
    redirect: {
      regexSubstitution:
        chrome.runtime.getURL("phishing-warning.html") + "?blocked=phishing-domain.com",
    },
  },
  condition: {
    urlFilter: "||phishing-domain.com^", // match any subdomain + path
    resourceTypes: ["main_frame"], // only navigation requests
  },
};
```

`urlFilter` syntax is similar to AdBlock's:

- `||` matches the start of a hostname
- `^` matches a separator (path slash, query mark, end of url)
- `*` is a wildcard
- `|...|` matches the whole url

`resourceTypes` filters by what kind of request: `main_frame` (top-level navigation), `sub_frame` (iframes), `xmlhttprequest`, `image`, `script`, etc.

`action.type` can be:

- `block` - cancel the request
- `redirect` - reroute to a new URL
- `modifyHeaders` - add / remove / modify request or response headers
- `allow` - explicit allow (overrides higher-priority blocks)
- `allowAllRequests` - whitelist a tab

chromatika uses `redirect` so users see the warning page rather than a generic "site blocked" browser error.

## the dynamic vs static rule split

- **static rules**: declared in `manifest.json` under `"rule_resources"`. compiled at install time. chromatika doesn't use static rules
- **dynamic rules**: added via `chrome.declarativeNetRequest.updateDynamicRules` at runtime. survives SW unloads but is mutable. chromatika uses dynamic rules for phishing

dynamic limit: 5000 rules. chromatika caps at 4900 to leave headroom.

## the update API

```ts
// add new rules + remove old
await chrome.declarativeNetRequest.updateDynamicRules({
  addRules: [rule1, rule2, ...],
  removeRuleIds: [oldId1, oldId2, ...],
});

// query existing rules
const existing = await chrome.declarativeNetRequest.getDynamicRules();
```

chromatika's phishing sync (see [eth-phishing-detect.md](/library/tech/eth-phishing-detect)):

1. fetches the latest phishing config.json
2. computes new rule set (4900 highest-priority entries)
3. computes diff: new ids to add, old ids to remove
4. one `updateDynamicRules` call to apply

atomic: either all rules update or none do.

## the manifest declaration

`manifest.json`:

```jsonc
{
  "permissions": [
    "declarativeNetRequest",
    "declarativeNetRequestWithHostAccess", // lets us redirect across hosts
  ],
  "host_permissions": ["<all_urls>"], // dNR needs broad host permission for cross-host redirects
}
```

without `host_permissions: ["<all_urls>"]`, dNR can only match within the extension's own host (which would be useless for phishing protection that targets arbitrary domains).

## the redirect destination

```
chrome-extension://<chromatika-id>/phishing-warning.html?blocked=evil-domain.com
```

`chrome.runtime.getURL('phishing-warning.html')` returns the extension-scoped URL. the `?blocked=` query lets the warning page show which domain triggered.

`web_accessible_resources` in the manifest must include `phishing-warning.html` so dNR can redirect there:

```jsonc
"web_accessible_resources": [{
  "resources": ["phishing-warning.html"],
  "matches": ["<all_urls>"]
}]
```

## the rule cap (4900 vs 5000)

chrome's hard limit is 5000. chromatika uses 4900 to leave 100 rules of headroom for:

- future user-driven allowlist (override flagged domains the user knows are safe)
- typo-squat detection rules (per-pattern matchers)
- emergency rules (e.g. a critical zero-day campaign needs immediate blocking)

## what dNR doesn't catch

- requests that bypass chrome's network stack entirely (rare; mostly extension-to-extension messaging)
- DNS-over-HTTPS to non-chrome resolvers (chrome handles DoH internally where applicable)
- non-HTTP protocols (`chrome:`, `about:`, `file:` etc. aren't typical phishing vectors)
- subresources of allowed pages (the dapp itself loads scripts from CDNs; we don't block those even if the dapp is suspicious)

phishing protection is a **navigation** filter, not a deep-content filter.

## library

- browser native `chrome.declarativeNetRequest`, `chrome.declarativeNetRequest.updateDynamicRules`
- internal: `wallet-extension/src/background/phishing.ts` for the rule-build orchestration

## related

- [eth-phishing-detect.md](/library/tech/eth-phishing-detect) - the upstream data source
- [phishing-protection.md](/library/user/phishing-protection) (user-guides) - the user-facing surface
