import type { Bridge } from "../core/bridge";
import type { InjectedConfig } from "../core/config";
import { claimInstall } from "../core/guard";

/**
 * The part of a TronWeb instance this module touches. The package never
 * constructs one and never knows a fullnode URL: the host builds the instance
 * with its own RPC host and hands it in.
 */
export type TronWebLike = {
  setAddress(address: string): void;
  trx: Record<string, unknown>;
  [key: string]: unknown;
};

export type TronFullDeps = {
  /** A TronWeb instance, already pointed at the host's fullnode. */
  tronWeb: TronWebLike;
};

export type TronLinkFull = {
  ready: boolean;
  tronWeb: TronWebLike;
  request(args: { method: string; params?: unknown }): Promise<unknown>;
};

function dispatchTronMessage(action: string, data: unknown): void {
  window.postMessage({ message: { action, data }, isTronLink: true }, window.location.origin);
}

/**
 * TronLink with a real TronWeb SDK on window.tronWeb. Tron dApps drive the SDK
 * directly (`transactionBuilder.*`, `contract().at`), so reads run against the
 * host's node and only the signing methods are redirected across the bridge.
 *
 * Separate entry on purpose: it costs the TronWeb dependency, and the thin
 * `tron` bridge costs nothing.
 */
export function installTronFull(
  bridge: Bridge,
  _config: InjectedConfig,
  deps: TronFullDeps,
): TronLinkFull | null {
  if (!claimInstall("tron")) return null;

  const { tronWeb } = deps;
  const readyFlag = tronWeb as { ready?: boolean };
  readyFlag.ready = false;

  const trx = tronWeb.trx as unknown as {
    sign(transaction: unknown): Promise<unknown>;
    signMessageV2(message: string): Promise<string>;
    multiSign(transaction: unknown): Promise<unknown>;
  };
  trx.sign = (transaction) => bridge.request("tron_signTransaction", [{ transaction }]);
  trx.signMessageV2 = (message) =>
    bridge.request("tron_signMessage", [{ message }]) as Promise<string>;
  trx.multiSign = (transaction) => bridge.request("tron_signTransaction", [{ transaction }]);

  const tronLink: TronLinkFull = {
    ready: false,
    tronWeb,
    async request(args) {
      if (!args || typeof args.method !== "string") {
        return { code: 4001, message: "Invalid request" };
      }
      if (args.method === "tron_requestAccounts") {
        const res = (await bridge.request("tron_requestAccounts", [{}])) as {
          address: string;
        } | null;
        if (!res) return { code: 4001, message: "User rejected" };
        tronWeb.setAddress(res.address);
        readyFlag.ready = true;
        tronLink.ready = true;
        dispatchTronMessage("setAccount", { address: res.address });
        dispatchTronMessage("connect", res.address);
        dispatchTronMessage("accountsChanged", { address: res.address });
        return { code: 200, message: "ok" };
      }
      return bridge.request(args.method, args.params as unknown[] | undefined);
    },
  };

  const announce = (): void => {
    const w = window as Window & { tronWeb?: unknown; tronLink?: unknown };
    w.tronWeb = tronWeb;
    w.tronLink = tronLink;
  };

  bridge.onEvent("tron", (ev) => {
    if (ev.event !== "accountsChanged") return;
    const next = Array.isArray(ev.data) ? ev.data : [];
    if (next.length > 0) return;
    readyFlag.ready = false;
    tronLink.ready = false;
    dispatchTronMessage("disconnect", {});
    dispatchTronMessage("accountsChanged", { address: "" });
  });

  announce();
  return tronLink;
}
