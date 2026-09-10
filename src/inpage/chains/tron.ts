import { invalidParams, unsupportedMethod, userRejected, RPC_USER_REJECTED } from "../../protocol/errors";
import type { Bridge } from "../core/bridge";
import { rpcException } from "../core/bridge";
import type { InjectedConfig } from "../core/config";
import { claimInstall } from "../core/guard";

type TronRequestArgs = { method: string; params?: unknown };
type ProviderListener = (...args: unknown[]) => void;

/**
 * The part of a TronWeb instance this module touches. Reads keep running against
 * whichever fullnode the instance was built with; only signing is redirected.
 */
export type TronWebLike = {
  setAddress(address: string): void;
  trx: Record<string, unknown>;
  [key: string]: unknown;
};

export type TronDeps = {
  /** A TronWeb instance, already pointed at a fullnode. */
  tronWeb?: TronWebLike | undefined;
};

/** Legacy window.tronLink. `ready` is true while an authorized account is known. */
export type TronLinkBridge = {
  ready: boolean;
  tronWeb: TronWebLike | null;
  request(args: TronRequestArgs): Promise<unknown>;
};

/**
 * window.tron, the surface current Tron dApps use. `tronWeb` is `false` until the
 * origin is authorized. No `is<Wallet>` flag: identity travels in the announcement.
 */
export type TronProvider = {
  request(args: TronRequestArgs): Promise<unknown>;
  on(event: string, listener: ProviderListener): TronProvider;
  removeListener(event: string, listener: ProviderListener): TronProvider;
  readonly tronWeb: TronWebLike | false;
};

/** TronLink dApps subscribe to these through window 'message' events. */
function dispatchTronMessage(action: string, data: unknown): void {
  window.postMessage({ message: { action, data }, isTronLink: true }, window.location.origin);
}

/**
 * Points the SDK's signing calls at the bridge; every other call keeps running
 * against the instance's own fullnode.
 */
function wrapTronWeb(bridge: Bridge, tronWeb: TronWebLike): void {
  const trx = tronWeb.trx as unknown as {
    sign(transaction: unknown): Promise<unknown>;
    signMessageV2(message: string): Promise<string>;
    multiSign(transaction: unknown): Promise<unknown>;
  };
  trx.sign = (transaction) => bridge.request("tron_signTransaction", [{ transaction }]);
  trx.signMessageV2 = (message) =>
    bridge.request("tron_signMessage", [{ message }]) as Promise<string>;
  trx.multiSign = (transaction) => bridge.request("tron_signTransaction", [{ transaction }]);
  (tronWeb as { ready?: boolean }).ready = false;
}

/**
 * Tron providers on window.tron and legacy window.tronLink, announced over the
 * multi-wallet discovery event. Without `deps.tronWeb` no SDK is put on the page.
 */
export function installTron(
  bridge: Bridge,
  config: InjectedConfig,
  deps?: TronDeps,
): TronLinkBridge | null {
  if (!claimInstall("tron")) return null;

  const listeners = new Map<string, Set<ProviderListener>>();
  const tronWeb = deps?.tronWeb ?? null;
  let connectedAddress = "";

  if (tronWeb) wrapTronWeb(bridge, tronWeb);

  const emit = (event: string, data: unknown): void => {
    const set = listeners.get(event);
    if (!set) return;
    for (const listener of set) {
      try {
        listener(data);
      } catch {
        /* never let a dApp listener break the bridge */
      }
    }
  };

  const authorize = (address: string): void => {
    connectedAddress = address;
    tronLink.ready = true;
    if (tronWeb) {
      tronWeb.setAddress(address);
      (tronWeb as { ready?: boolean }).ready = true;
    }
  };

  const clear = (): void => {
    connectedAddress = "";
    tronLink.ready = false;
    if (tronWeb) (tronWeb as { ready?: boolean }).ready = false;
  };

  const connect = async (): Promise<string | null> => {
    const res = (await bridge.request("tron_requestAccounts", [{}])) as {
      address: string;
    } | null;
    if (!res) return null;
    authorize(res.address);
    dispatchTronMessage("setAccount", { address: res.address });
    dispatchTronMessage("connect", res.address);
    dispatchTronMessage("accountsChanged", { address: res.address });
    return res.address;
  };

  /** `modern` only picks the answer for a malformed call; the mapping is shared. */
  const request = (args: TronRequestArgs, modern: boolean): Promise<unknown> => {
    if (!args || typeof args.method !== "string") {
      return modern
        ? Promise.reject(rpcException(invalidParams("Invalid request")))
        : Promise.resolve({ code: RPC_USER_REJECTED, message: "Invalid request" });
    }
    const method = args.method;
    if (method === "tron_requestAccounts") {
      return connect().then((address) =>
        address ? { code: 200, message: "ok" } : { code: RPC_USER_REJECTED, message: "User rejected" },
      );
    }
    // The host classifies a method by its prefix, so an eth_* name is translated
    // here or it would reach the evm family.
    if (method === "eth_requestAccounts") {
      return connect().then((address) => {
        if (address === null) throw rpcException(userRejected());
        return [address];
      });
    }
    if (method === "eth_accounts") return bridge.request("tron_accounts");
    if (!method.startsWith("tron_")) {
      return Promise.reject(rpcException(unsupportedMethod(method)));
    }
    return bridge.request(method, args.params as unknown[] | undefined);
  };

  const tronLink: TronLinkBridge = {
    ready: false,
    tronWeb,
    request: (args) => request(args, false),
  };

  const provider: TronProvider = {
    request: (args) => request(args, true),
    on(event, listener) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(listener);
      return provider;
    },
    removeListener(event, listener) {
      listeners.get(event)?.delete(listener);
      return provider;
    },
    get tronWeb() {
      return connectedAddress.length > 0 && tronWeb ? tronWeb : false;
    },
  };

  const announce = (): void => {
    window.dispatchEvent(
      new CustomEvent("TIP6963:announceProvider", {
        detail: Object.freeze({
          info: Object.freeze({
            uuid: config.identity.uuid,
            name: config.identity.name,
            icon: bridge.icon(),
            rdns: config.identity.rdns,
          }),
          provider,
        }),
      }),
    );
  };

  const install = (): void => {
    const w = window as Window & { tron?: unknown; tronLink?: unknown; tronWeb?: unknown };
    if (!w.tron) {
      try {
        // Not writable, so a later script cannot swap the provider out; still
        // configurable, so the page is not permanently wedged by this definition.
        Object.defineProperty(window, "tron", {
          value: provider,
          writable: false,
          configurable: true,
        });
      } catch {
        w.tron = provider;
      }
    }
    w.tronLink = tronLink;
    if (tronWeb) w.tronWeb = tronWeb;
  };

  bridge.onIcon(announce);
  bridge.onEvent("tron", (ev) => {
    if (ev.event === "accountsChanged") {
      const next = Array.isArray(ev.data) ? (ev.data as unknown[]) : [];
      const first = next[0];
      if (typeof first === "string" && first.length > 0) {
        authorize(first);
      } else {
        clear();
        dispatchTronMessage("disconnect", {});
        dispatchTronMessage("accountsChanged", { address: "" });
      }
    }
    emit(ev.event, ev.data);
  });

  // Dispatched by a dApp whose picker opens after this script ran.
  window.addEventListener("TIP6963:requestProvider", announce);

  install();
  announce();
  return tronLink;
}
