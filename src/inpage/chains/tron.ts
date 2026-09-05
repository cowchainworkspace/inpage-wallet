import type { Bridge } from "../core/bridge";
import type { InjectedConfig } from "../core/config";
import { claimInstall } from "../core/guard";

export type TronLinkBridge = {
  ready: boolean;
  request(args: { method: string; params?: unknown }): Promise<unknown>;
};

/** TronLink dApps subscribe to these through window 'message' events. */
function dispatchTronMessage(action: string, data: unknown): void {
  window.postMessage({ message: { action, data }, isTronLink: true }, window.location.origin);
}

/**
 * Thin TronLink-compatible bridge on window.tronLink. It does not define
 * window.tronWeb: a dApp that drives the SDK directly needs the tron-full entry,
 * which costs a TronWeb dependency nobody should pay for by accident.
 */
export function installTron(bridge: Bridge, _config: InjectedConfig): TronLinkBridge | null {
  if (!claimInstall("tron")) return null;

  let connectedAddress = "";

  const tronLink: TronLinkBridge = {
    ready: false,
    async request(args) {
      if (!args || typeof args.method !== "string") {
        return { code: 4001, message: "Invalid request" };
      }
      if (args.method === "tron_requestAccounts") {
        const res = (await bridge.request("tron_requestAccounts", [{}])) as {
          address: string;
        } | null;
        if (!res) return { code: 4001, message: "User rejected" };
        connectedAddress = res.address;
        tronLink.ready = true;
        dispatchTronMessage("setAccount", { address: connectedAddress });
        dispatchTronMessage("connect", connectedAddress);
        dispatchTronMessage("accountsChanged", { address: connectedAddress });
        return { code: 200, message: "ok" };
      }
      return bridge.request(args.method, args.params as unknown[] | undefined);
    },
  };

  const announce = (): void => {
    (window as Window & { tronLink?: unknown }).tronLink = tronLink;
  };

  bridge.onEvent("tron", (ev) => {
    if (ev.event !== "accountsChanged") return;
    const next = Array.isArray(ev.data) ? ev.data : [];
    if (next.length > 0) return;
    connectedAddress = "";
    tronLink.ready = false;
    dispatchTronMessage("disconnect", {});
    dispatchTronMessage("accountsChanged", { address: "" });
  });

  announce();
  return tronLink;
}
