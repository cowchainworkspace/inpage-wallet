# extension-minimal

A Manifest V3 extension wired to `inpage-wallet` with no UI framework and
`window.confirm` standing in for the approval window.

Three files, one per context:

- `src/inpage.ts` — MAIN world. Announces the providers. Runs in the dApp's own
  JS context, so it has no `chrome.*` access.
- `src/content-script.ts` — ISOLATED world. Relays envelopes between the page and
  the service worker, and resolves the extension icon the MAIN world cannot read.
- `src/service-worker.ts` — the router, the session store, and the decisions.

This example is typechecked, not built: point your own bundler at the three
entries and emit them next to `manifest.json` as `src/*.js`.
