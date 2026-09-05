import { familiesOf } from "../protocol/networks";
import { createBridge, type Bridge } from "./core/bridge";
import { initialIcon, type InjectedConfig } from "./core/config";
import type { PageTransport } from "./core/transport";
import { installCardano } from "./chains/cardano";
import { installEvm } from "./chains/evm";
import { installSolana } from "./chains/solana";
import { installTron } from "./chains/tron";
import { installXrp } from "./chains/xrp";
import { installXrpStandard } from "./chains/xrp-standard";

export { createBridge, newRequestId, rpcException, type Bridge } from "./core/bridge";
export { FALLBACK_ICON, initialIcon, type InjectedConfig, type WalletIdentity } from "./core/config";
export { claimInstall, resetInstalls } from "./core/guard";
export type { HostTransport, PageTransport } from "./core/transport";

export function bridgeFor(transport: PageTransport, config: InjectedConfig): Bridge {
  return createBridge(
    transport,
    config.channel === undefined
      ? { fallbackIcon: initialIcon(config) }
      : { channel: config.channel, fallbackIcon: initialIcon(config) },
  );
}

/**
 * Installs one provider per family present in `config.networks`. Every provider
 * shares a single bridge, so one `ready` and one pending map serve the page.
 */
export function createInjectedWallet(transport: PageTransport, config: InjectedConfig): void {
  const families = familiesOf(config.networks);
  if (families.length === 0) return;

  const bridge = bridgeFor(transport, config);

  for (const family of families) {
    switch (family) {
      case "evm":
        installEvm(bridge, config);
        break;
      case "solana":
        installSolana(bridge, config);
        break;
      case "cardano":
        installCardano(bridge, config);
        break;
      case "tron":
        installTron(bridge, config);
        break;
      case "xrp":
        installXrp(bridge, config);
        installXrpStandard(bridge, config);
        break;
      default:
        break;
    }
  }

  bridge.sendReady(families);
}
