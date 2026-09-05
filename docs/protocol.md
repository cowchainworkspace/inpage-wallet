# inpage-wallet protocol

Version 1 — channel `inpage-wallet-v1`.

This document is the contract between the two sides of the boundary. A host
written in TypeScript imports the router and never needs it; a host written in
Swift, Kotlin, or Rust implements this instead.

The protocol version lives in the channel string. A page and a host only ever
speak to each other when they were built from the same major version, so a
breaking change bumps the major and moves the channel suffix with it. Saved dApp
connections are keyed on wallet identity, which the package does not own, so a
protocol bump never invalidates one.

## Boundary

```
dApp page                            host
  provider.request()  ──envelope──▶  router.handle()
                      ◀──envelope──  { result } | { error }
```

The page holds a thin provider that forwards calls. Session state, key material,
and every user decision live on the host side. Correlation is by request id,
generated in the page and echoed back.

## Origin attribution

**Origin is never read from the page.** The host stamps it: from
`location.origin` in an extension's isolated world, or from the committed
navigation in a WebView. While a navigation to a different origin is in flight
the origin is null and requests arriving in that window are dropped.

In an extension the isolated world sees the frame it runs in, and a document
with no usable origin — a sandboxed iframe, `data:`, `file:`, plain `http:`, all
of which report `"null"` or something no session can be keyed on — is not
relayed at all. The worker must attribute by `sender.origin`, `sender.tab.id`
and `sender.frameId`, which the browser stamps, rather than by anything in the
message, and must answer with that `frameId`: the same origin can be open in
several tabs, and an iframe is not its parent.

**React Native needs more, and the nonce is not optional there.** On Android
`ReactNativeWebView.postMessage` is exposed to *every* frame in the WebView,
while the injected script runs main-frame only. A cross-origin iframe can
therefore hand-roll an envelope and the host would attribute it to the top-level
origin. The defence is a per-document nonce:

- The host mints one nonce per document and builds the injected script with it.
  The preamble keeps it in its closure and never writes it into
  `window.__inpageWalletConfig`, so no page script can read it back.
- Every page-to-host envelope carries it as `n`. The host drops any envelope
  whose `n` does not match the nonce it committed alongside the current origin —
  including every envelope before a nonce is committed.
- Host-to-page delivery carries it too: `__inpageWalletReceive(env, nonce)`
  ignores a call whose nonce is not the one this document was injected with, so
  a response minted for a previous document reaches nothing.

Origin and nonce are committed together, never separately. A host that has one
without the other has no attribution and must drop the message.

Payloads longer than 1,000,000 characters are dropped before parsing.

## Envelope

Every message is a JSON object carrying a channel and a direction.

```ts
type Envelope = { channel: string; direction: "page-to-host" | "host-to-page" } & Body;
```

A receiver drops anything whose `channel` is not its own and whose `direction` is
not the one it expects, and then validates every field of the body — a `kind`
alone says nothing about the rest. `id` is a non-empty string of at most 128
characters, `method` a string of at most 128, `params` absent or an array,
`families` an array of known families, `error.code` a number, and `event` one of
the three names below. A body that does not check out is not a malformed
request; it is not a request at all.

Classification is total: a method that is not a string is `unsupported`, never a
throw. A method name echoed back in an error is truncated to 64 characters.

### page-to-host

| kind      | fields                                            | meaning |
| --------- | ------------------------------------------------- | ------- |
| `ready`   | `families: ChainFamily[]`                         | The page installed providers and is listening. The host answers with `init`. |
| `request` | `id: string`, `method: string`, `params?: any[]`  | One `provider.request()`. |

Both also carry `n: string` on React Native — the per-document nonce described
above. Other transports leave it absent.

`id` is a `crypto.randomUUID()` where available, otherwise
`r-<timestamp>-<random>`. It is opaque to the host.

### host-to-page

| kind       | fields                                                     | meaning |
| ---------- | ---------------------------------------------------------- | ------- |
| `init`     | `icon: string`                                              | The wallet icon as a data URI. **An empty string is ignored** so the placeholder is never blanked out. |
| `response` | `id: string`, `result?: any`, `error?: { code, message }`   | The answer to one `request`. Exactly one of `result` / `error`. |
| `event`    | `family: ChainFamily`, `event: string`, `data: any`         | A provider event, scoped to one family. |

Event names are `accountsChanged`, `chainChanged`, and `disconnect`. A provider
ignores events addressed to another family, so several chains can share an origin.

### Bytes

Binary payloads cross as **plain number arrays**, never `Uint8Array` or `Buffer`:
the envelope must survive `JSON.stringify`. Cardano (hex), XRPL (JSON) and BTC
(base64 PSBTs) are already string-native and pass through unchanged.

## Families

A family is one dApp-facing provider standard. The host registers networks; the
families present in that list decide which providers are injected.

**Provider identity means nothing to the router.** Which injected object a page
called — the EIP-1193 provider, the Wallet Standard wallet, `window.cardano.x` —
never crosses the boundary. Any of them can send any family's method, and the
router decides the family from the method name alone. The boundary is the
per-family session: a page connected for `evm` and not for `solana` gets `4100`
on `solana_signMessage` however it asked.

| family    | standard                 | page surface                        |
| --------- | ------------------------ | ----------------------------------- |
| `evm`     | EIP-1193 / EIP-6963      | `eip6963:announceProvider`, optionally `window.ethereum` |
| `solana`  | Wallet Standard          | `wallet-standard:register-wallet`   |
| `cardano` | CIP-30                   | `window.cardano.<key>`              |
| `tron`    | TronLink                 | `window.tronLink` (+ `window.tronWeb` in the `tron-full` entry) |
| `xrp`     | Crossmark-style + XLS-72d | `window.crossmark` and `wallet-standard:register-wallet` |
| `btc`     | Bitcoin Wallet Standard  | `wallet-standard:register-wallet`   |

A network is `{ id, family, name, wire }`. `id` is the host's own. `wire` maps it
to what each standard needs: `evmChainId` (hex), `walletStandardChain`,
`cardanoNetworkId`, `caip2`.

## Methods

Classification decides the route. `classify(method)` returns one of `readOnly`,
`readRpc`, `submit`, `connect`, `disconnect`, `switch`, `sign`, `unsupported`.
The family comes from the method prefix (`solana_`, `cardano_`, `tron_`, `xrpl_`, `btc_`);
un-prefixed methods are EVM.

### readOnly — answered from the session, never a prompt

`eth_chainId`, `net_version`, `eth_accounts`, `wallet_getPermissions`,
`cardano_isEnabled`, `cardano_getNetworkId`, `cardano_getUsedAddresses`,
`cardano_getUnusedAddresses`, `cardano_getChangeAddress`,
`cardano_getRewardAddresses`, `tron_accounts`, `xrpl_accounts`, `btc_accounts`.

With no session these answer with the family's default network and an empty
account list. dApps poll them on every page load; a prompt here is a bug.

### readRpc — proxied to the host's node client

An allow-list, never a passthrough: an unlisted method must not become a way to
drive an arbitrary node through the wallet.

`eth_blockNumber`, `eth_call`, `eth_estimateGas`, `eth_gasPrice`,
`eth_getBalance`, `eth_getBlockByNumber`, `eth_getCode`, `eth_getLogs`,
`eth_getStorageAt`, `eth_getTransactionByHash`, `eth_getTransactionCount`,
`eth_getTransactionReceipt`, `eth_maxPriorityFeePerGas`, `cardano_getBalance`,
`cardano_getUtxos`, `cardano_getCollateral`.

Reads require a session. An origin that never connected gets `4100`: an
allow-listed read still spends the host's node quota and confirms to the page
that a wallet is here. `policy.readRpcRequiresSession: false` opts out.

The host can replace the list or refuse reads entirely. A refused read is
`unsupported`, not an error.

### submit — broadcasts a signed transaction

`cardano_submitTx`. Not a read: it spends. It requires a session, it is not
reachable through the read allow-list, and it goes to `ui.submit` when the host
supplies one so the broadcast can be gated or logged. Without that callback it
falls through to the host's node client, still only with a session.

### connect

`eth_requestAccounts`, `wallet_requestPermissions`, `solana_connect`,
`cardano_enable`, `tron_requestAccounts`, `xrpl_requestAccounts`,
`btc_requestAccounts`.

An origin that already has a session is answered immediately. A request carrying
`{ silent: true }` and no session answers `null` and never opens UI — that is how
an eager reconnect on page load stays silent. Concurrent connects for one origin
and family are coalesced into a single prompt.

Results per family:

| family    | result |
| --------- | ------ |
| `evm`     | `string[]` |
| `solana`  | `{ address, publicKey: number[] }` or `null` |
| `cardano` | `{ networkId: 0 \| 1 }` |
| `tron`    | `{ address }` or `null` |
| `xrp`     | `{ address }` or `null` |
| `btc`     | `{ address, publicKey: number[], addressType }` or `null` |

### disconnect

`solana_disconnect`, `cardano_disconnect`, `tron_disconnect`,
`xrpl_disconnect`, `btc_disconnect`. Clears the session, emits
`accountsChanged: []`, answers `null`.

### switch

`wallet_switchEthereumChain`, `wallet_addEthereumChain`. An origin with no EVM
session answers `4902` with no UI: there is nothing to switch. Otherwise the
requested hex chain id is looked up in the host's registry plus whatever that
origin has already added. A chain that is not registered answers `4902`, unless
the host supplies an add-chain callback that returns a network to register.

**A chain added this way belongs to the origin that asked**, not to the router,
and at most 16 of them: otherwise one page could talk a user into adding a chain
whose RPC and explorer it chose and every other page would then be able to switch
to it. `router.registerNetwork(def)` is how a host promotes one to global. A
switch that changes the session's network emits `chainChanged` with the new hex
id.

### sign

`personal_sign`, `eth_sign`, `eth_signTypedData`, `eth_signTypedData_v3`,
`eth_signTypedData_v4`, `eth_sendTransaction`, `eth_signTransaction`,
`solana_signTransaction`, `solana_signMessage`, `solana_signAndSendTransaction`,
`cardano_signTx`, `cardano_signData`, `tron_signTransaction`,
`tron_signMessage`, `xrpl_signTransaction`, `xrpl_signMessage`, `btc_signPsbt`,
`btc_signMessage`.

Signing requires a session; without one the answer is `4100`. What the host
returns is passed back to the page unchanged.

**The account is a claim, not a fact.** Wherever a sign request names one —
`personal_sign` `params[1]`, `eth_sign` `params[0]`, the typed-data address,
`tx.from`, `account` or `address` on a params object — the page chose it. The
router rejects it with `4100` ("Account is not in this session") before any UI
when it is not one of the session's accounts. EVM addresses compare
case-insensitively; every other family's compare exactly.

**Sign `payload`, never `raw`.** Every sign request carries `payload`: the one
value the parsed model was built from. `raw` is the params as they arrived and is
diagnostic only. A page can send two plausible candidates — `[drainPermit,
benignLogin]` for typed data — and a host that re-derives its own payload from
`raw` renders one and signs the other. Typed data that cannot be parsed answers
`-32602` and no sheet opens; a missing or mistyped required param answers
`-32602` rather than reaching the UI as an empty string or an empty byte array.

**Build the signed transaction from the summary, never the raw object.**
`eth_sendTransaction` and `eth_signTransaction` are parsed into a summary that
models presence rather than dropping it: `from`, `to`, `value`, `data`,
`chainId`, `gas` (aliasing ethers v5's `gasLimit`), `gasPrice`, `maxFeePerGas`,
`maxPriorityFeePerGas`, `nonce`, `type`, `authorizationList` (EIP-7702),
`accessList` (EIP-2930), `blobVersionedHashes` / `maxFeePerBlobGas` /
`hasBlobPayload` (EIP-4844), and `ignoredFields` — every key of the request the
model does not cover. A host must build the transaction it signs from these
typed fields and must never pass `payload` or `raw` for `eth_sendTransaction` /
`eth_signTransaction` to a signer: with that rule, a field the model does not
cover is harmless by construction. `ignoredFields` is informational — safe to
ignore, useful for an "advanced details" section. A host must refuse to render
only when `authorizationList` is non-empty, `hasBlobPayload` is true, or
`accessList` is non-empty, unless it renders and supports that feature: a 7702
authorization hands the whole account to a contract, blob bytes cannot be
rendered without decoding them, and an access list changes gas accounting the
sheet did not show.

Wire shapes worth stating:

| method | params | result |
| ------ | ------ | ------ |
| `solana_signTransaction` | `[{ tx: number[], account }]` | `{ signedTx: number[] }` |
| `solana_signAndSendTransaction` | `[{ tx: number[], account }]` | `{ signature: number[] }` |
| `solana_signMessage` | `[{ message: number[], account }]` | `{ signedMessage: number[], signature: number[] }` |
| `cardano_signTx` | `[{ tx, partialSign }]` | signed tx hex |
| `cardano_signData` | `[{ address, payload }]` | `{ signature, key }` |
| `xrpl_signTransaction` | `[{ tx_json, submit }]` | `{ tx_blob?, hash?, … }` |
| `btc_signPsbt` | `[{ psbt }]` (base64) | signed PSBT, base64 |

## Error codes

| code     | meaning |
| -------- | ------- |
| `4001`   | User rejected the request. Also what a timed-out prompt answers. |
| `4100`   | Unauthorized — no session for this origin and family. |
| `4200`   | Unsupported method, or a family the host did not register. |
| `4900`   | Disconnected. |
| `4902`   | Unrecognized chain id. |
| `-32005` | Request limit exceeded — too many prompts or requests in flight for this origin. |
| `-32602` | Invalid request. |
| `-32603` | Internal error, including a node failure behind `readRpc`. |

The router never throws to its caller: every outcome is `{ result }` or
`{ error }`. Anything a UI callback throws is mapped to an error, keeping a
`code` the callback set. Cardano's `enable()` rejects with the CIP-30 refusal
code `-3` instead, because that is what CIP-30 dApps catch.

## Limits

One origin may have one prompt open at a time — sign, switch, addChain, submit —
and 256 requests of any kind in flight. Both are policy
(`maxConcurrentPrompts`, `maxInFlightPerOrigin`). Overflow answers `-32005`
before anything is allocated: a page that fires a thousand signs must not cost a
thousand timers and modals to refuse. Connect is coalesced into a single prompt
per origin and family, so it is never counted.

## Timeouts and cancellation

Every request is tracked from the moment it arrives. It is answered when the host
decides, when the policy timeout elapses (`4001`), or when the host cancels it —
a closed tab, a disconnect, a session revoked on another device. A page is never
left waiting on a promise nobody will settle.

Each request the host's UI receives carries an `AbortSignal`, aborted at that
same moment, so the host can close the modal it opened. A decision that arrives
after the abort is discarded: no session is written, no network is registered,
no event is emitted.
