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
the same pair to `transport.commit`.

## Tron with the full SDK

Tron dApps build their transactions with a TronWeb instance, so `window.tron`
needs one to hand out. Turn on `legacyGlobals: { tronWeb: true }`, give the tron
network a `wire.tronFullHost`, and ship the SDK's browser bundle
(`node_modules/tronweb/dist/TronWeb.js`, read from your own assets) as a
`prelude`, which runs before the preamble:

```tsx
const injected = useMemo(
  () =>
    buildInjectedScript(
      {
        identity: IDENTITY,
        networks: NETWORKS,
        nonce: scriptNonce,
        legacyGlobals: { tronWeb: true },
      },
      { prelude: [tronWebBundleSource] },
    ),
  [scriptNonce, tronWebBundleSource],
);
```

`tronWebBundleSource` is the bundle's text, loaded however your app loads assets.
Nothing is fetched for you, and this package does not depend on `tronweb`. With
the flag on and no bundle shipped, nothing is built and `tronWeb` stays `false`.

This example is typechecked, not run. `react-native.d.ts` is a stand-in for the
real React Native types; delete it in a real app.
