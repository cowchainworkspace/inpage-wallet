# inpage-wallet

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
