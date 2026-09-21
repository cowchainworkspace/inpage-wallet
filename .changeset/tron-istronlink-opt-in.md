---
"inpage-wallet": patch
---

Add `legacyGlobals.isTronLink` (reported in #11), off by default. Reown AppKit's
Tron adapter has no TIP-6963 path and only lists a wallet when
`window.tron?.isTronLink === true || window.tronLink?.ready === true`, which is
false before connect — so AppKit never showed this wallet at all. With the flag
on, `window.tron` and the TIP-6963 announced provider carry `isTronLink: true`;
with it off the property is absent, not `false`. It touches nothing else:
`window.tronLink` never gets the marker, `tronLink.ready` and
`window.tron.tronWeb` still stay `false` until the origin is authorized. AppKit
has no way to read `identity.name`, so a dApp that needs this flag lists the
wallet under the adapter's own name, "TronLink".
