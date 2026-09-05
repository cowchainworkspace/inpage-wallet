import {
  DEFAULT_CHANNEL,
  isHostToPage,
  pageToHost,
  type HostToPageEnvelope,
  type ProviderEvent,
} from "../../protocol/envelope";
import { RPC_INTERNAL, type RpcError } from "../../protocol/errors";
import type { ChainFamily } from "../../protocol/networks";
import type { PageTransport } from "./transport";

export type BridgeOptions = {
  channel?: string;
  fallbackIcon: string;
};

export type Bridge = {
  readonly channel: string;
  request(method: string, params?: unknown[]): Promise<unknown>;
  /** Provider events scoped to one family. */
  onEvent(family: ChainFamily, handler: (event: ProviderEvent) => void): void;
  icon(): string;
  /** Fires whenever the host delivers a usable icon. */
  onIcon(handler: (icon: string) => void): void;
  sendReady(families: ChainFamily[]): void;
};

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };

export function newRequestId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `r-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** An RpcError as a throwable the dApp can read `code` off, per EIP-1193. */
export function rpcException(err: RpcError | undefined): Error & { code: number } {
  const e = new Error(err?.message ?? "Request failed") as Error & { code: number };
  e.code = typeof err?.code === "number" ? err.code : RPC_INTERNAL;
  return e;
}

/**
 * An empty or non-string icon is dropped so a host that has not resolved its
 * brand asset yet cannot blank out the placeholder.
 */
function usableIcon(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function createBridge(transport: PageTransport, options: BridgeOptions): Bridge {
  const channel = options.channel ?? DEFAULT_CHANNEL;
  const pending = new Map<string, Pending>();
  const eventHandlers = new Map<ChainFamily, Set<(event: ProviderEvent) => void>>();
  const iconHandlers = new Set<(icon: string) => void>();
  let icon = options.fallbackIcon;

  const deliver = (env: HostToPageEnvelope): void => {
    if (!isHostToPage(env, channel)) return;
    if (env.kind === "init") {
      if (!usableIcon(env.icon)) return;
      icon = env.icon;
      for (const handler of iconHandlers) {
        try {
          handler(icon);
        } catch {
          /* a chain module must not break the bridge */
        }
      }
      return;
    }
    if (env.kind === "response") {
      const p = pending.get(env.id);
      if (!p) return;
      pending.delete(env.id);
      if (env.error) p.reject(rpcException(env.error));
      else p.resolve(env.result);
      return;
    }
    const handlers = eventHandlers.get(env.family);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler({ family: env.family, event: env.event, data: env.data });
      } catch {
        /* never let a dApp listener break the bridge */
      }
    }
  };

  transport.onMessage(deliver);

  return {
    channel,
    request(method, params) {
      return new Promise<unknown>((resolve, reject) => {
        const id = newRequestId();
        pending.set(id, { resolve, reject });
        transport.post(
          pageToHost(channel, params === undefined ? { kind: "request", id, method } : { kind: "request", id, method, params }),
        );
      });
    },
    onEvent(family, handler) {
      let set = eventHandlers.get(family);
      if (!set) {
        set = new Set();
        eventHandlers.set(family, set);
      }
      set.add(handler);
    },
    icon: () => icon,
    onIcon(handler) {
      iconHandlers.add(handler);
    },
    sendReady(families) {
      transport.post(pageToHost(channel, { kind: "ready", families }));
    },
  };
}
