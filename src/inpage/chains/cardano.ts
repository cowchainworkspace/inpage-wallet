import type { Bridge } from "../core/bridge";
import { rpcException } from "../core/bridge";
import type { InjectedConfig } from "../core/config";
import { claimInstall } from "../core/guard";

/** CIP-30 APIError.Refused. */
const REFUSED = -3;

type CardanoNamespace = Record<string, unknown>;

/** The key dApps enumerate under window.cardano, e.g. "examplewallet". */
export function cardanoWalletKey(config: InjectedConfig): string {
  const explicit = config.cardanoWalletKey;
  if (explicit) return explicit;
  return config.identity.name.replace(/[^a-zA-Z0-9]/g, "").toLowerCase() || "wallet";
}

/** CIP-30 wallet on window.cardano. Hex-string native, so payloads pass through. */
export function installCardano(bridge: Bridge, config: InjectedConfig): void {
  if (!claimInstall("cardano")) return;

  const key = cardanoWalletKey(config);
  let enabled = false;

  const api = {
    getNetworkId: () => bridge.request("cardano_getNetworkId") as Promise<number>,
    getUsedAddresses: () => bridge.request("cardano_getUsedAddresses") as Promise<string[]>,
    getUnusedAddresses: () => bridge.request("cardano_getUnusedAddresses") as Promise<string[]>,
    getChangeAddress: () => bridge.request("cardano_getChangeAddress") as Promise<string | null>,
    getRewardAddresses: () => bridge.request("cardano_getRewardAddresses") as Promise<string[]>,
    getBalance: () => bridge.request("cardano_getBalance") as Promise<string>,
    getUtxos: () => bridge.request("cardano_getUtxos") as Promise<string[] | null>,
    getCollateral: () => bridge.request("cardano_getCollateral") as Promise<string[]>,
    signTx: (tx: string, partialSign = false) =>
      bridge.request("cardano_signTx", [{ tx, partialSign }]) as Promise<string>,
    signData: (address: string, payload: string) =>
      bridge.request("cardano_signData", [{ address, payload }]) as Promise<{
        signature: string;
        key: string;
      }>,
    submitTx: (tx: string) => bridge.request("cardano_submitTx", [{ tx }]) as Promise<string>,
  };

  const wallet = {
    apiVersion: "1.0.0",
    name: config.identity.name,
    get icon() {
      return bridge.icon();
    },
    supportedExtensions: [] as unknown[],
    isEnabled: () => bridge.request("cardano_isEnabled") as Promise<boolean>,
    enable: async () => {
      if (enabled) return api;
      const res = (await bridge.request("cardano_enable", [{}])) as { networkId: number } | null;
      if (!res) throw rpcException({ code: REFUSED, message: "User declined" });
      enabled = true;
      return api;
    },
  };

  const announce = (): void => {
    const w = window as Window & { cardano?: CardanoNamespace };
    if (!w.cardano) w.cardano = {};
    w.cardano[key] = wallet;
  };

  bridge.onIcon(announce);
  bridge.onEvent("cardano", (ev) => {
    if (ev.event !== "accountsChanged") return;
    const next = Array.isArray(ev.data) ? ev.data : [];
    if (next.length === 0) enabled = false;
  });

  announce();
}
