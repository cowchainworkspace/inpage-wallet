# rn-webview

A React Native WebView wired to `inpage-wallet`, with `Alert` standing in for the
connect and sign sheets.

The three pieces that matter:

- `buildInjectedScript(config)` returns the whole injected script — preamble plus
  one bundle per family — for `injectedJavaScriptBeforeContentLoaded`.
- `createRnHostTransport({ inject })` parses `onMessage` payloads and turns
  outgoing envelopes into `injectJavaScript` calls.
- `nextCommittedOrigin` keeps the origin honest: it goes null while a navigation
  to a different site is in flight, so one site's script cannot speak for another.

This example is typechecked, not run. `react-native.d.ts` is a stand-in for the
real React Native types; delete it in a real app.
