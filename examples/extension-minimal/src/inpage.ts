import { createInjectedWallet } from "inpage-wallet/inpage";
import { postMessageTransport } from "inpage-wallet/transports/post-message";

import { IDENTITY, NETWORKS } from "../wallet";

// MAIN world: no chrome.* here. The content script sends the icon over later.
createInjectedWallet(postMessageTransport(), {
  identity: IDENTITY,
  networks: NETWORKS,
});
