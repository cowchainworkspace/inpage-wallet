---
"inpage-wallet": patch
---

Add `policy.canReuseSession` so a host can refuse a silent connect reuse per
request (with the existing session attached to `ui.connect`, and an optional
`{ reuse: true }` on the decision to keep it), add `origin` and `session` to
`RpcRequest` so a read RPC knows which account it is for, and add a conformance
tool (`inpage-wallet/conformance` and the `inpage-wallet-check` CLI) for hosts
that rebuild the injected bundles themselves.
