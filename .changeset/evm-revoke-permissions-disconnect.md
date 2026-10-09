---
"inpage-wallet": patch
---

fix(evm): honour `wallet_revokePermissions` so a dApp's own disconnect clears the host session (#23). wagmi's injected connector disconnects with `wallet_revokePermissions [{ eth_accounts: {} }]`, which the router answered as unsupported, so the page showed "Connect" while the host kept the EVM session. A revoke of `eth_accounts` (or one with missing or malformed params) now clears the origin's EVM session, emits `accountsChanged: []` and answers `null`; other families' sessions on the same origin are kept. A revoke of any other permission answers `null` and changes nothing.
