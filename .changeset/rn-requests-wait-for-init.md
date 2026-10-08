---
"inpage-wallet": patch
---

React Native: a page reached by a cross-origin navigation no longer loses its first
wallet calls. The host drops everything a document posts before it has committed
that document's origin, which on a WebView only happens when the load finishes. A
dApp that asks for its session early (Raydium's silent `standard:connect`, an
`eth_accounts` on load) got no answer and gave up, while a refresh, where the
origin is already committed, worked.

- **Page side:** over React Native, requests are held until the host's first
  `init` and then sent in order. `ready` is not held. The extension path is
  unchanged.
- **Host side:** `createRnHostTransport({ icon })` sends `init` to every newly
  committed document and answers every accepted `ready` with it, which releases
  what the page held. Pass `icon`: a host without it must answer `ready` itself,
  and a page reached cross-origin still waits until it is reloaded.

The host's checks are unchanged: nothing is accepted before commit. A request is
sent again only by the document that holds it, so the previous document still
cannot speak for the next one's origin.
