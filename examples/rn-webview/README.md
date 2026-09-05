# rn-webview

A React Native WebView wired to `inpage-wallet`, with `Alert` standing in for the
connect and sign sheets.

The three pieces that matter:

- `buildInjectedScript(config)` returns the whole injected script — preamble plus
  one bundle per family — for `injectedJavaScriptBeforeContentLoaded`.
- `createRnHostTransport({ inject })` parses `onMessage` payloads and turns
  outgoing envelopes into `injectJavaScript` calls.
- `nextCommittedNavigation` keeps the origin honest: it goes null while a
  navigation to a different site is in flight, so one site's script cannot speak
  for another, and it carries the per-document nonce alongside the origin.

The nonce is what separates the main frame from the iframes inside it. On Android
`ReactNativeWebView.postMessage` reaches every frame while the injected script
runs main-frame only, so an iframe can hand-roll an envelope; only the stamp the
preamble adds tells the two apart. Rebuild the script on each navigation and hand
the same nonce to `transport.setNonce`.

This example is typechecked, not run. `react-native.d.ts` is a stand-in for the
real React Native types; delete it in a real app.
