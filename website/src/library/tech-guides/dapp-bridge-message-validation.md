# dapp bridge message validation

the chromatika dapp bridge spans three JS contexts: **page world** (where dapp code runs and our injected provider lives), **content-script isolated world** (where our content script runs), and **background service worker** (where everything signs). messages flow via `window.postMessage` (page ↔ content-script) and `chrome.runtime.sendMessage` / port (content-script ↔ background). every hop has validation to prevent spoofing.

## the threat model

without validation:
- a malicious iframe could `postMessage` claiming to be the parent origin, get its tx approved as if it came from the parent
- a sibling frame could intercept messages between the dapp and our content script
- a content script of another extension could in theory race to register a similar provider
- a compromised page could try to bypass approval by directly `postMessage`-ing the content script

## the page → content-script hop

page-script wraps `window.ethereum.request(...)`:
```ts
function request(args) {
  return new Promise((resolve, reject) => {
    const requestId = randomId();
    pending.set(requestId, { resolve, reject });

    window.postMessage({
      type: 'chromatika_dapp_request',
      method: args.method,
      params: args.params,
      requestId,
    }, window.location.origin);    // explicit targetOrigin
  });
}

window.addEventListener('message', (event) => {
  // VALIDATION 1: must come from the same window
  if (event.source !== window) return;

  // VALIDATION 2: must have our message type
  if (event.data?.type !== 'chromatika_dapp_response') return;

  // VALIDATION 3: must have a known requestId
  const entry = pending.get(event.data.requestId);
  if (!entry) return;
  pending.delete(event.data.requestId);

  if (event.data.error) entry.reject(event.data.error);
  else entry.resolve(event.data.result);
});
```

three checks:
- `event.source === window` (it came from our own window, not a sibling iframe)
- `event.data.type` matches our expected message type
- `event.data.requestId` was issued by us (i.e. we sent the matching request)

## the content-script side

content script listens for `window` postMessages too:
```ts
window.addEventListener('message', async (event) => {
  // VALIDATION 1: must come from the same window
  if (event.source !== window) return;

  // VALIDATION 2: must be a request type we handle
  if (event.data?.type !== 'chromatika_dapp_request') return;

  // VALIDATION 3: validate origin matches the page's origin
  if (event.origin !== window.location.origin) return;

  // forward to background
  const result = await chrome.runtime.sendMessage({
    type: 'dapp_request',
    origin: event.origin,        // attached by content-script, not from page-supplied data
    method: event.data.method,
    params: event.data.params,
    requestId: event.data.requestId,
  });

  // post response back to page world
  window.postMessage({
    type: 'chromatika_dapp_response',
    requestId: event.data.requestId,
    result: result.result,
    error: result.error,
  }, window.location.origin);
});
```

key points:
- `event.origin` is the **content-script's** view of the page origin, not something the page can spoof
- `origin` is attached to the message **by the content script** before sending to background, so background can trust it
- forwarding back uses an explicit `targetOrigin` so the message can't leak to cross-origin frames

## the content-script → background hop

`chrome.runtime.sendMessage` carries a `sender` object that chrome attaches:
```ts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // sender.tab.url is the page url; sender.origin is the page origin
  // these are CHROME-ATTACHED, not from the message payload - trustworthy

  // VALIDATION 4: cross-check that message.origin matches sender.origin
  const senderOrigin = new URL(sender.tab.url).origin;
  if (message.origin !== senderOrigin) {
    sendResponse({ error: 'origin mismatch' });
    return true;
  }

  // dispatch to handler
  handleDappRequest(senderOrigin, message.method, message.params)
    .then(result => sendResponse({ result }))
    .catch(error => sendResponse({ error }));

  return true;   // async response
});
```

chromium's `MessageSender` includes `tab.url` (the URL of the tab that sent the message) and `origin` (chromium-derived). these are **not page-influenced** - chrome populates them based on which tab actually sent. so even if the content-script's message claims `origin: 'attacker.com'`, `sender.origin` reveals the real page.

## iframes and embedded contexts

an iframe at `https://embed.example.com` running inside `https://parent.example.com` sees:
- `window.location.origin === 'https://embed.example.com'`
- content-script for that frame validates against `embed.example.com`
- chrome reports `sender.tab.url` of the parent tab BUT `sender.frameId` distinguishes the frame
- chromatika treats each frame's origin as its own origin for permissions

so a connection request from `embed.example.com` does NOT inherit `parent.example.com`'s permissions. each frame asks for its own connection.

## the `event.source === window` gotcha

inside an iframe, `window` is the iframe's window. `event.source === window` confirms the message came from the iframe's own document, not from the parent. this prevents a parent from injecting messages into the iframe's listener via `iframe.contentWindow.postMessage(...)` claiming to be the iframe.

(actually `iframe.contentWindow.postMessage` would arrive with `event.source` pointing at the parent, not the iframe's window. so the check correctly rejects.)

## what could go wrong

- **content-script not loaded yet**: page-script's request hangs until the content-script attaches. timeout with retry (or a visible "wallet not ready" error)
- **content-script crashed**: `chrome.runtime.sendMessage` returns `{ error: 'No matching listener' }` or similar. page-script surfaces a wallet error
- **cross-origin frames trying to read each other's messages**: `postMessage` is same-origin by default; `targetOrigin: '*'` would broadcast, but we always specify `window.location.origin`
- **rogue extension intercepting messages**: extensions don't have access to other extensions' content-script messages. our content-script's `chrome.runtime.sendMessage` goes to **chromatika's** background only

## library

- browser native `window.postMessage`, `window.addEventListener('message', ...)`
- `chrome.runtime.sendMessage`, `chrome.runtime.onMessage` for cross-context bridge
- internal: `wallet-extension/src/content-script/dapp-bridge-listener.ts` content-script side
- internal: `wallet-extension/src/dapp-interface/inject.ts` page-script side
- internal: `wallet-extension/src/background/dapp-bridge.ts` background dispatcher

## related

- [eip-1193-and-6963.md](/library/tech/eip-1193-and-6963) - the EVM provider this bridge serves
- [wallet-standard-sui-and-solana.md](/library/tech/wallet-standard-sui-and-solana) - non-EVM equivalent
- [eip-3085-3326.md](/library/tech/eip-3085-3326) - chain management subset
- [phishing-protection.md](/library/user/phishing-protection) (user-guides) - dNR-level URL filtering on top of this bridge
