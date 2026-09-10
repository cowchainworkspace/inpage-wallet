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

The package ships ESM and CommonJS side by side, so every subpath resolves under
both `import` and `require`. **Jest needs no configuration for it** — no
`moduleNameMapper` pointing into `dist`, and no
`testEnvironmentOptions.customExportConditions`, which would change resolution
for every other package in the suite. `sideEffects: false` still holds, so
bundlers tree-shake the ESM build as before.

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

**Build the transaction you sign from the summary, never the raw request.**
Never pass `payload`/`raw` for `eth_sendTransaction` / `eth_signTransaction` to
a signer — build it from the summary's typed fields instead, so an unmodelled
key is harmless by construction. `ignoredFields` lists every key of the request
the model does not cover, for an optional "advanced details" section; it is
informational only. Throw rather than open a sheet when `authorizationList` is
non-empty, `hasBlobPayload` is true, or `accessList` is non-empty and you do not
render/support it: a 7702 authorization hands the whole account to a contract,
and a field that changes what is signed but is not shown is one the user did
not agree to.

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

**A dropped message is not a slow one.** `createRnHostTransport` takes an
optional `onDrop(reason, detail)` — `"no-commit"`, `"nonce-mismatch"`,
`"origin-mismatch"`, `"oversized"` or `"malformed"`, with `{ origin?, size? }`
and never the nonce — called for every envelope it refuses, in both directions.
Without it, and outside `NODE_ENV === "production"`, the transport warns once
per reason per committed document instead, so a page that has gone mute is
visible rather than looking slow.

```ts
const transport = createRnHostTransport({
  inject: (s) => ref.current?.injectJavaScript(s),
  onDrop: (reason, detail) => log.warn("wallet bridge dropped a message", reason, detail),
});
```

**A new nonce needs a new document.** The nonce belongs to the document that was
injected with it, so minting one without reloading the WebView strands the page:
every envelope it posts is dropped as `nonce-mismatch`, and every response is
built for a nonce the page does not hold. React Fast Refresh is where this bites
in development — remounting the component that owns the nonce keeps the loaded
page — so rebuild the injected script and reload the WebView together, or keep
the nonce out of the remounted state.

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
or reaches `ui.addChain` if you provide one — and a chain accepted there is
scoped to the origin that asked, capped at 16, so one page cannot add a network
of its choosing to every other page's registry. `router.registerNetwork(def)`
adds one globally when you want that.

## Supported chains

| family    | standard                              | page surface |
| --------- | ------------------------------------- | ------------ |
| `evm`     | EIP-1193 announced over EIP-6963      | `eip6963:announceProvider`; `window.ethereum` only if `legacyGlobals.ethereum` |
| `solana`  | Wallet Standard                       | `wallet-standard:register-wallet` |
| `cardano` | CIP-30                                | `window.cardano.<key>` |
| `tron`    | TronLink, announced over TIP-6963     | `TIP6963:announceProvider`; `window.tron` and `window.tronLink` |
| `xrp`     | Crossmark-style API and XLS-72d       | `window.crossmark` and the register event |
| `btc`     | Bitcoin Wallet Standard               | `wallet-standard:register-wallet` |

Tron's current surface is `window.tron`, announced over TIP-6963 exactly as the
EVM provider is announced over EIP-6963: `request`, `on` / `removeListener`, and
a `tronWeb` getter that stays `false` until the user authorizes. The
authorization method TronLink documents is `eth_requestAccounts`; it is
translated to `tron_requestAccounts` on the page — no `eth_*` name is ever
forwarded to the host — and answers with the address array. `window.tronLink`
stays for legacy dApps, with `ready` and its `{ code, message }` answer to
`tron_requestAccounts`. Any method that is not `tron_*` answers `4200`.

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

## Host side

**`policy.canReuseSession`** decides, per connect, whether an existing session
answers silently or the router opens `ui.connect` again. It is consulted only
when a session with accounts already exists; `silentReconnect` is the default
it falls back to when the hook is absent.

```ts
policy: {
  // The extension pins a session to the workspace active when it was created;
  // a connect from a page while a different workspace is active must re-prompt.
  canReuseSession: (session, req) => session.walletId === activeWorkspaceId(),
}
```

Returning `false` does not throw the session away: `ui.connect` receives it as
`req.existing`, so the confirmation UI can preselect or show the previous
wallet. If the user picks the same wallet again, resolve with
`{ accounts, reuse: true }` and the router keeps the existing session — same
id, same `createdAt`, only `lastUsedAt` bumped — instead of writing a new one.
A silent reconnect (`{ silent: true }` in the request params) still never opens
UI, even when the hook returns `false`.

**Solana and BTC connects must bring a public key.** `ui.connect` resolves with
a `ConnectDecision`; for `family: "solana"` and `family: "btc"` the page builds
transactions from `account.publicKey`, so `publicKey: number[]` is required
there. `ConnectDecisionFor<"solana">` is the decision type for one family, and
the router rejects a decision without a non-empty key with `-32603`
("Wallet did not provide a public key for solana") before it writes a session —
rather than announcing a zero-length key, which surfaces much later as
`unknown signer` from `@solana/web3.js`, naming the wrong key.

```ts
async function connect(req: ConnectRequest): Promise<ConnectDecision | null> {
  const account = await pick(req);
  return req.family === "solana" || req.family === "btc"
    ? { accounts: [account.address], publicKey: [...account.publicKey] }
    : { accounts: [account.address] };
}
```

**`RpcRequest`** carries `origin` and `session` (the session the router already
looked up for that origin and family, or `null`). A CIP-30 per-account read —
`cardano_getBalance`, `cardano_getUtxos`, `cardano_getCollateral` — sends no
params of its own, so this is how `rpc` knows which account to query.

## What this package will never contain

Wallet identity, RPC endpoints, API keys, host URLs, signing code, or key
material. The package stops at the sign callback.

## Protocol

`docs/protocol.md` is the wire format as prose, versioned with the package, so a
host written in Swift or Kotlin can implement the host side without reading
TypeScript.

## Verifying your own bundles

A host that rebuilds the injected side — bundling the package's chain entries
into its own standalone files, the way a browser extension does for Firefox or
Safari — can prove the result still speaks the protocol with
`inpage-wallet/conformance`:

```ts
import { checkInpageBundle } from "inpage-wallet/conformance";
import { JSDOM } from "jsdom";

const dom = new JSDOM("", { url: "https://example.test", runScripts: "dangerously" });
const report = await checkInpageBundle(
  await readFile("dist/evm.iife.js", "utf8"),
  { identity: IDENTITY, families: ["evm"] },
  { window: dom.window },
);
// report.ok, report.checks: [{ name, family?, ok, detail? }]
```

It evaluates the built source in the window you supply — jsdom, happy-dom, or a
real browser — and checks discovery, the `ready` handshake, one request
round-trip and one event per family, and that evaluating the same source twice
does not install anything a second time. It throws only when the source itself
is broken; every other problem comes back as a failing check, never a throw.

The package adds no dependency for this: bring your own DOM. The bundled CLI
does the same thing from the command line, importing `jsdom` from your own
project (`pnpm add -D jsdom`) if it isn't already a dependency:

```sh
npx inpage-wallet-check dist/evm.iife.js \
  --name "Example Wallet" --rdns com.example.wallet --uuid <uuid> \
  --families evm,solana [--channel c] [--cardano-key k]
```

It prints the report and exits `1` when any check fails.

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
system at runtime. It is generated and git-ignored. The generated file records a
content hash of the sources it was built from, so it refreshes when they change
and not when an mtime moves; `pnpm build` regenerates unconditionally, and CI
checks that two consecutive regenerations are byte-identical and that building
leaves the tree clean.

## License

MIT
