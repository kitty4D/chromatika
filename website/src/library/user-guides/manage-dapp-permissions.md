# how to manage dapp permissions

list the dapps that have a connection to chromatika, see what dWallets they have access to, switch which dWallet they see, or revoke their connection entirely.

## prerequisites

- a Chromatika vault is unlocked
- one or more dapps have completed a connection (see [connect-dapp.md](/library/user/connect-dapp))

## options at a glance

- **list permissions**: see all connected origins
- **revoke**: drop a specific origin's permission
- **switch active address per origin**: change which dWallet the dapp can see (handled implicitly via `setActiveDwallet`; the dapp gets the new address via account-changed events)
- **debug**: view the recent dapp request log for diagnostics

## how to list connected dapps

1. call `getDappPermissions`
2. response is a list of `{ origin, selectedAddress, selectedDwalletId, scopes, ... }` per connection, scoped per curve

## how to revoke a dapp's permission

1. submit `revokeDappPermission` with `origin`
2. the bridge broadcasts disconnect events to the page, drops the entry from `chromatika_dapp_permissions_v1`
3. any pending tx / sign requests from that origin are rejected immediately

## how to switch which dWallet a dapp sees

1. setting the active dWallet for a curve via `setActiveDwallet` re-emits the account-changed event to all connected origins
2. for finer-grained per-origin selection, revoke + reconnect (since approval at connect time is the canonical per-origin choice today)

## how to debug recent dapp requests

1. call `dappBridgeDebug`
2. response is the last 50 telemetry entries (request method, origin, timing, outcome)
3. useful when a dapp's flow is silently failing

## how to query the active tab's dapp connection state

1. call `vaultHeaderDappContext` to get the active browser tab + connection status (one of: connected, not connected, no origin)
2. used by surfaces that show "this dapp is connected" hints

## notes

- the bridge tracks origin + `event.source` validation in the content script - a dapp cannot fake messages for another origin
- if the wallet is locked, all dapp requests reject with a "wallet locked" error until unlock
- the architecture allows a future per-origin scope flag (e.g. `accounts only` vs `accounts + sendTx`); today scopes are inferred from the standards' default surfaces
