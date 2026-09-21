---
"inpage-wallet": patch
---

`cardano_getRewardAddresses` no longer hardcodes `[]` for every host (reported in #16).
`RouterDeps.cardano.rewardAddresses(session, { origin, network })` lets the host supply
CIP-30 reward (stake) addresses for a session; without it, or without a session, the
method answers `[]` exactly as before. The package still never parses a Cardano address
itself — deriving the reward address from a payment address stays the host's job.
