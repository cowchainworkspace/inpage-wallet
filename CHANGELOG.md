# inpage-wallet

## 0.0.4

### Patch Changes

- Tron reaches modern dApps (reported in #7):
  
  - **The tron family is announced for multi-wallet discovery.** It dispatches
    `TIP6963:announceProvider` with a frozen
    `{ info: { uuid, name, icon, rdns }, provider }` detail built from
    `config.identity`, re-announcing on `TIP6963:requestProvider` and whenever the
    host delivers its icon — the same shape the evm family has always had over
    EIP-6963. Before this, a dApp following TronLink's current guidance saw nothing
    at all.
  - **`window.tron` is the provider.** `request`, `on` / `removeListener`, and a
    `tronWeb` getter that is `false` until the origin is authorized. It is defined
    only when no other wallet has claimed the key, and the announced provider is
    that same object. `window.tronLink` is unchanged for legacy dApps, including
    the `{ code, message }` answer to `tron_requestAccounts` and its `ready` flag.
  - **The page translates the authorization method.** The host classifies a method
    by its prefix, so `eth_requestAccounts` becomes a `tron_requestAccounts`
    request and answers with the documented address array, and `eth_accounts`
    becomes `tron_accounts`. No other non-`tron_` method is forwarded — those
    answer `4200` — which also closes the path by which the legacy bridge could
    send an `eth_*` name to the evm family. `accountsChanged`, `chainChanged` and
    `disconnect` from the host reach `window.tron` listeners, and a non-empty
    `accountsChanged` is taken as the authorized account.
  - **`legacyGlobals.tronWeb` does something.** With the flag on, the injected
    `tron` bundle builds a TronWeb instance from a `TronWeb` constructor already on
    the page, pointed at the new host-owned `wire.tronFullHost`, wraps its signing
    calls the way `inpage/tron-full` wraps a host-supplied instance, and exposes it
    on `window.tronWeb`, `window.tronLink.tronWeb` and — after authorization —
    `window.tron.tronWeb`. With no constructor or no `tronFullHost`, nothing is
    built and a single dev-only warning explains why. The package still hardcodes
    no node URL and depends on no SDK.
  - **`buildInjectedScript(config, { prelude })`** prepends raw scripts, each in
    its own block, before the preamble — how a WebView host ships the TronWeb
    browser bundle from its own assets. See "Tron: full SDK in a WebView".
  - **Conformance covers the new surface.** `checkInpageBundle` requires the
    announce event with the configured identity, requires the announced provider to
    be `window.tron`, and drives one `eth_requestAccounts` through it, asserting the
    host is asked for `tron_requestAccounts` and that legacy `ready` flips.

## 0.0.3

### Patch Changes

- Fixes for hosts that register more than one chain family, and for CommonJS
  resolvers (reported in #4):
  
  - **Concatenated family bundles no longer clobber each other.** esbuild's
    target lowering hoisted its object-spread helpers above rollup's IIFE
    wrapper, so two bundles in one document shared them and every family but the
    last posted envelopes with no `channel`, `direction`, `kind` or `method`,
    which the host drops. Each `dist/inpage/<chain>.iife.js` is now wrapped so it
    is genuinely self-contained, and `buildInjectedScript` wraps each bundle
    again. Multi-family conformance over all six families, in both orders, is now
    a permanent test case.
  - **The Wallet Standard sign methods are variadic.** Solana
    `signTransaction`, `signAndSendTransaction` and `signMessage`, and the BTC
    `signTransaction` and `signMessage`, took a single input and returned a
    one-element array, silently discarding batched inputs. Each now issues one
    request per input, in order, and returns one output per input; the first
    failure rejects the whole call.
  - **Solana and BTC connects require a public key.** `ConnectDecisionFor<F>`
    resolves to a decision type where `publicKey: number[]` is required for those
    families, and the router rejects a decision without a non-empty key with
    `-32603` (`Wallet did not provide a public key for <family>`) before writing a
    session. The page treats a connect result with no key as a failed connect
    rather than announcing a zero-length one.
  - **Dropped WebView messages are observable.** `createRnHostTransport` accepts
    `onDrop(reason, detail)` — `no-commit`, `nonce-mismatch`, `origin-mismatch`,
    `oversized`, `malformed` — called on every drop in `receive` and `deliver`,
    never carrying the nonce. Without it, and outside
    `NODE_ENV === "production"`, it warns once per reason per committed document.
  - **CommonJS resolvers can load the package.** Every subpath now declares a
    `require` condition backed by real CJS output, so Jest resolves
    `inpage-wallet/host` and friends with no `moduleNameMapper` and no
    `customExportConditions`. `sideEffects: false` is unchanged.

## 0.0.2

### Patch Changes

- 2b065d8: Add `policy.canReuseSession` so a host can refuse a silent connect reuse per
  request (with the existing session attached to `ui.connect`, and an optional
  `{ reuse: true }` on the decision to keep it), add `origin` and `session` to
  `RpcRequest` so a read RPC knows which account it is for, and add a conformance
  tool (`inpage-wallet/conformance` and the `inpage-wallet-check` CLI) for hosts
  that rebuild the injected bundles themselves.
