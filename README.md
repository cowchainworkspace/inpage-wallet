# inpage-wallet

Headless, brand-neutral wallet injection and request routing for dApp pages.

One package that injects wallet providers into a web page, carries their requests
to a host over a pluggable transport, and routes them there. Any wallet app or
browser extension consumes it with its own brand, its own networks, its own UI,
its own storage, and its own signers.

- **No UI.** The router hands every user decision to a callback you supply.
- **No signing.** `ui.sign` receives a parsed request and returns whatever the
  chain expects. Where the signature comes from — a local key, a vault iframe, an
  MPC service, a hardware device — is invisible to the package.
- **No runtime dependencies.** No chain SDKs, no WalletConnect, no React. The
  Wallet Standard constants are inlined.
- **No build-time config.** Identity, networks, and channel arrive at runtime.

## Install

```sh
pnpm add inpage-wallet
```

Node 24, pnpm 10. `tronweb` is an optional peer dependency, needed only by the
`inpage/tron-full` entry.

## Quickstart: browser extension

Three contexts, three files. See `examples/extension-minimal` for the whole thing.

```ts
// MAIN world — runs in the dApp's own JS context
import { createInjectedWallet } from "inpage-wallet/inpage";
import { postMessageTransport } from "inpage-wallet/transports/post-message";

createInjectedWallet(postMessageTransport(), { identity: IDENTITY, networks: NETWORKS });
```

```ts
// ISOLATED world — relays between the page and the service worker
import { createContentScriptRelay } from "inpage-wallet/transports/extension-content-script";

createContentScriptRelay({
  sendToWorker: (message) => void chrome.runtime.sendMessage(message),
  onWorkerMessage: (handler) => {
    const listener = (m: unknown) => void handler(m as never);
    chrome.runtime.onMessage.addListener(listener);
    return () => {};
  },
  resolveIcon,
});
```

```ts
// service worker — the router
import { createDappRouter, layeredSessionStore } from "inpage-wallet/host";

const router = createDappRouter({
  networks: NETWORKS,
  sessions: layeredSessionStore({ local: chromeStorageSessions, remote: api.dappSessions }),
  ui: {
    // req.signal aborts when the tab closes, the session is revoked, or the
    // policy timeout fires: wire it to close the window.
    connect: (req) => openConfirmationWindow("connect", req, req.signal),
    sign: (req) => openConfirmationWindow("sign", req, req.signal),
  },
  rpc: evmRpc,
  emit: (origin, event) => broadcastToTabs(origin, event),
  policy: { requestTimeoutMs: 180_000 },
});
```

Every UI callback receives `req.signal`. It aborts when the request is answered
without the user — a closed tab, a disconnect, the policy timeout — so wire it to
close the modal. Whatever a modal resolves after that point is discarded: no
session is written, no event is emitted.

**Refuse what your sheet cannot show.** The EVM transaction summary carries
`unknownFields` — every key of the request the model does not cover — and
`authorizationList` for EIP-7702. Throw rather than open a sheet when either is
non-empty and you do not render it: a 7702 authorization hands the whole account
to a contract, and an unrendered field is one the user did not agree to.

## Quickstart: React Native WebView

`buildInjectedScript` returns the whole injected script as a string — a preamble
that captures `ReactNativeWebView.postMessage` before page scripts run, plus one
bundle per family you registered. See `examples/rn-webview`.

```tsx
import { buildInjectedScript } from "inpage-wallet/script";
import { createRnHostTransport } from "inpage-wallet/transports/rn-webview";
import { createDappRouter, createNonce, nextCommittedNavigation } from "inpage-wallet/host";

// One nonce per document, so the script is rebuilt per navigation — never memoised once.
const injected = buildInjectedScript({ identity: IDENTITY, networks: NETWORKS, nonce });
const transport = createRnHostTransport({ inject: (s) => ref.current?.injectJavaScript(s) });

<WebView
  injectedJavaScriptForMainFrameOnly           // the default; leave it on
  injectedJavaScriptBeforeContentLoaded={injected}
  onMessage={(e) => transport.receive(committed.current?.origin ?? null, e.nativeEvent.data)}
  onNavigationStateChange={(nav) => {
    committed.current = nextCommittedNavigation(committed.current, nav, nonce);
    transport.commit(committed.current);
  }}
/>;
```

Origin comes from the committed navigation, never from anything the page says
about itself. `nextCommittedNavigation` returns null while a navigation to a
different site is in flight, so one site's injected script cannot inherit
another's session.

**The nonce is required on React Native, not optional.** On Android
`ReactNativeWebView.postMessage` is exposed to every frame in the WebView, while
the injected script runs main-frame only — so without it a cross-origin iframe
can hand-roll an envelope and have the host attribute it to the top-level
origin. The preamble keeps the nonce in its closure, out of the page-readable
config, and stamps it on every envelope; the transport drops anything that does
not carry the nonce committed alongside the current origin, including everything
before `transport.commit` is called. `commit` is also what binds delivery: a
response for an origin the WebView is no longer showing is never injected, and a
delivery script built for a previous document is ignored by the page. See
`examples/rn-webview` for the whole loop.

## Identity

```ts
const IDENTITY = {
  name: "Example Wallet",
  rdns: "com.example.wallet",
  uuid: "6f9d3c1e-0a2b-4c8d-9e1f-2a3b4c5d6e7f",
  icon: "data:image/png;base64,…", // optional; a neutral placeholder is used until set
};
```

**`rdns` and `uuid` are permanent.** dApps — wagmi, RainbowKit, Web3Modal — key a
user's saved "last connected wallet" on them. Generate the uuid once and never
regenerate it: changing either silently breaks every saved connection and forces
users to reconnect everywhere. Use the same values across every surface of your
wallet so they resolve to one wallet, not several.

The package ships no identity. It lives in your app and arrives as config.

## Networks are yours to name

The package knows six families, one per provider standard it can speak. It knows
no networks. You register yours, with the same ids your backend uses, and the
package maps them to what each standard expects on the wire.

```ts
const NETWORKS: NetworkDef[] = [
  { id: "1", family: "evm", name: "Ethereum", wire: { evmChainId: "0x1", caip2: "eip155:1" } },
  { id: "11155111", family: "evm", name: "Sepolia", wire: { evmChainId: "0xaa36a7" } },
  { id: "sol_main", family: "solana", name: "Solana", wire: { walletStandardChain: "solana:mainnet" } },
];
```

Which families appear in that list decides which providers get injected. A
`wallet_switchEthereumChain` for a chain you have not registered answers `4902`,
or reaches `ui.addChain` if you provide one.

## Supported chains

| family    | standard                              | page surface |
| --------- | ------------------------------------- | ------------ |
| `evm`     | EIP-1193 announced over EIP-6963      | `eip6963:announceProvider`; `window.ethereum` only if `legacyGlobals.ethereum` |
| `solana`  | Wallet Standard                       | `wallet-standard:register-wallet` |
| `cardano` | CIP-30                                | `window.cardano.<key>` |
| `tron`    | TronLink                              | `window.tronLink` |
| `xrp`     | Crossmark-style API and XLS-72d       | `window.crossmark` and the register event |
| `btc`     | Bitcoin Wallet Standard               | `wallet-standard:register-wallet` |

`inpage-wallet/inpage/tron-full` additionally puts a real TronWeb instance on
`window.tronWeb` for dApps that drive the SDK. You construct the instance with
your own fullnode and hand it in; the package overrides only the signing methods.
It is a separate entry so nobody pays for TronWeb by accident.

## Sessions

The store is async so it can be backed by an API. `layeredSessionStore` puts a
synchronous local cache in front of your backend and writes through: reads never
wait on the network, and a backend that is down still leaves the wallet usable.

```ts
const sessions = layeredSessionStore({
  local: mmkvSessions,
  remote: {
    upsert: (s) => api.post("/dapp-sessions", s).then((r) => r.id),
    remove: (s) => api.delete(`/dapp-sessions/${s.id}`),
    list: () => api.get("/dapp-sessions"),
  },
});

// On login or a push notification: retry the writes the backend refused, push
// what it never received, drop what it no longer has.
const cleared = await sessions.reconcile();
```

The router subscribes to the store, so a session revoked on another device
reaches the page as a `disconnect` event. The backend never receives key
material, request params, or signatures — those pass through `ui.sign` only.

## Policy

Every decision the router can make without asking is overridable.

```ts
policy: {
  readRpc: "allowlist",        // "none", or a ReadonlySet of your own
  readRpcRequiresSession: true, // an unconnected origin gets 4100, not your node
  silentReconnect: true,       // answer connect from an existing session with no UI
  requestTimeoutMs: 120_000,   // then the request answers 4001
  supportedEvmChainIds: undefined, // hex set; default is every registered EVM network
  maxConcurrentPrompts: 1,     // sheets one origin can have open; overflow is -32005
  maxInFlightPerOrigin: 256,   // requests of any kind one origin can have waiting
}
```

## What this package will never contain

Wallet identity, RPC endpoints, API keys, host URLs, signing code, or key
material. The package stops at the sign callback.

## Protocol

`docs/protocol.md` is the wire format as prose, versioned with the package, so a
host written in Swift or Kotlin can implement the host side without reading
TypeScript.

## Development

```sh
pnpm install
pnpm typecheck     # tsc over src, test, and the examples
pnpm test          # vitest: node for the host, jsdom for the injected providers
pnpm build         # per-chain IIFE bundles, then ESM + .d.ts
pnpm size          # size-limit against the per-chain budgets
```

`scripts/bundle-inpage.mjs` builds one self-contained IIFE per chain and embeds
them in `src/script/bundles.generated.ts`, so `buildInjectedScript` needs no file
system at runtime. It is generated, git-ignored, and refreshed automatically.

## License

MIT
