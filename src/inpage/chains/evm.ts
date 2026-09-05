import { RPC_INVALID_PARAMS } from "../../protocol/errors";
import { defaultNetworkFor } from "../../protocol/networks";
import type { Bridge } from "../core/bridge";
import { rpcException } from "../core/bridge";
import type { InjectedConfig } from "../core/config";
import { claimInstall } from "../core/guard";

type Eip1193RequestArgs = { method: string; params?: unknown };
type ProviderListener = (...args: unknown[]) => void;

export type EvmProvider = {
  request(args: Eip1193RequestArgs): Promise<unknown>;
  on(event: string, listener: ProviderListener): EvmProvider;
  removeListener(event: string, listener: ProviderListener): EvmProvider;
  isConnected(): boolean;
  readonly chainId: string | null;
};

/** EIP-1193 provider announced over EIP-6963. No window.ethereum unless asked for. */
export function installEvm(bridge: Bridge, config: InjectedConfig): EvmProvider | null {
  if (!claimInstall("evm")) return null;

  const listeners = new Map<string, Set<ProviderListener>>();
  let chainId = defaultNetworkFor(config.networks, "evm", config.defaultNetwork)?.wire.evmChainId ?? null;

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

  const provider: EvmProvider = {
    request(args) {
      if (!args || typeof args.method !== "string") {
        return Promise.reject(rpcException({ code: RPC_INVALID_PARAMS, message: "Invalid request" }));
      }
      return bridge.request(args.method, args.params as unknown[] | undefined);
    },
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
    isConnected: () => true,
    get chainId() {
      return chainId;
    },
  };

  const announce = (): void => {
    window.dispatchEvent(
      new CustomEvent("eip6963:announceProvider", {
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

  bridge.onIcon(announce);
  bridge.onEvent("evm", (ev) => {
    if (ev.event === "chainChanged" && typeof ev.data === "string") chainId = ev.data;
    emit(ev.event, ev.data);
  });

  // wagmi / RainbowKit dispatch this when their modal opens.
  window.addEventListener("eip6963:requestProvider", announce);

  if (config.legacyGlobals?.ethereum && !(window as { ethereum?: unknown }).ethereum) {
    try {
      Object.defineProperty(window, "ethereum", {
        value: provider,
        writable: false,
        configurable: false,
      });
    } catch {
      (window as { ethereum?: unknown }).ethereum = provider;
    }
  }

  announce();
  return provider;
}
