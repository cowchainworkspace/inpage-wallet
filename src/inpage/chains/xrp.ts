import { RPC_UNSUPPORTED_METHOD, RPC_USER_REJECTED } from "../../protocol/errors";
import type { Bridge } from "../core/bridge";
import { rpcException } from "../core/bridge";
import type { InjectedConfig } from "../core/config";
import { claimInstall } from "../core/guard";

type Listener = (data: unknown) => void;
type TxJson = Record<string, unknown>;

export type XrpProvider = {
  signIn(): Promise<{ address: string }>;
  getAddress(): Promise<string>;
  sign(txJson: TxJson): Promise<{ tx_blob: string; hash: string }>;
  signAndSubmit(txJson: TxJson): Promise<unknown>;
  signMessage(message: string): Promise<string>;
  signOut(): Promise<null>;
  on(event: string, cb: Listener): void;
  off(event: string, cb: Listener): void;
  request(input: { command: string; data?: unknown }): Promise<unknown>;
};

/**
 * XRPL provider on window.crossmark — the namespace XRPL dApps look in. It does
 * not claim to be Crossmark; it implements the same call surface.
 */
export function installXrp(bridge: Bridge, _config: InjectedConfig): XrpProvider | null {
  if (!claimInstall("xrp")) return null;

  const listeners = new Map<string, Set<Listener>>();
  let connectedAddress = "";

  const emit = (event: string, data: unknown): void => {
    const set = listeners.get(event);
    if (!set) return;
    for (const cb of set) {
      try {
        cb(data);
      } catch {
        /* never let a dApp listener break the bridge */
      }
    }
  };

  const provider: XrpProvider = {
    async signIn() {
      const res = (await bridge.request("xrpl_requestAccounts", [{}])) as {
        address: string;
      } | null;
      if (!res) throw rpcException({ code: RPC_USER_REJECTED, message: "User rejected" });
      connectedAddress = res.address;
      emit("signin", { address: connectedAddress });
      return { address: connectedAddress };
    },
    async getAddress() {
      if (connectedAddress) return connectedAddress;
      const accounts = (await bridge.request("xrpl_accounts")) as string[];
      connectedAddress = accounts[0] ?? "";
      return connectedAddress;
    },
    sign: (tx_json) =>
      bridge.request("xrpl_signTransaction", [{ tx_json, submit: false }]) as Promise<{
        tx_blob: string;
        hash: string;
      }>,
    signAndSubmit: (tx_json) =>
      bridge.request("xrpl_signTransaction", [{ tx_json, submit: true }]),
    signMessage: (message) =>
      bridge.request("xrpl_signMessage", [{ message }]) as Promise<string>,
    async signOut() {
      await bridge.request("xrpl_disconnect");
      connectedAddress = "";
      emit("signout", null);
      return null;
    },
    on(event, cb) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(cb);
    },
    off(event, cb) {
      listeners.get(event)?.delete(cb);
    },
    request({ command, data }) {
      const payload = (data ?? {}) as { tx_json?: TxJson; message?: string };
      switch (command) {
        case "signIn":
          return provider.signIn();
        case "getAddress":
          return provider.getAddress();
        case "sign":
          return provider.sign(payload.tx_json ?? {});
        case "signAndSubmit":
        case "submit":
          return provider.signAndSubmit(payload.tx_json ?? {});
        case "signMessage":
          return provider.signMessage(payload.message ?? "");
        case "signOut":
          return provider.signOut();
        default:
          return Promise.reject(
            rpcException({
              code: RPC_UNSUPPORTED_METHOD,
              message: `Unsupported command: ${command}`,
            }),
          );
      }
    },
  };

  const announce = (): void => {
    (window as Window & { crossmark?: unknown }).crossmark = provider;
  };

  bridge.onEvent("xrp", (ev) => {
    if (ev.event !== "accountsChanged") return;
    const next = Array.isArray(ev.data) ? ev.data : [];
    if (next.length > 0) return;
    connectedAddress = "";
    emit("signout", null);
  });

  announce();
  return provider;
}
