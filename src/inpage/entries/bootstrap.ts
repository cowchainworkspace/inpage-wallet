import {
  DEFAULT_CHANNEL,
  isHostToPage,
  type HostToPageEnvelope,
  type PageToHostEnvelope,
} from "../../protocol/envelope";
import type { ChainFamily } from "../../protocol/networks";
import { RN_CONFIG, RN_DELIVER, RN_POST } from "../../transports/rn-webview";
import { createBridge, type Bridge } from "../core/bridge";
import { initialIcon, type InjectedConfig } from "../core/config";
import type { PageTransport } from "../core/transport";

type PageGlobals = {
  [RN_CONFIG]?: InjectedConfig;
  [RN_POST]?: (env: unknown) => void;
  [RN_DELIVER]?: Record<string, (env: unknown) => void>;
};

function globals(): PageGlobals {
  return globalThis as unknown as PageGlobals;
}

/**
 * One transport for both hosts: a React Native preamble leaves its capture of
 * `ReactNativeWebView.postMessage` behind, and an extension MAIN world has none,
 * so postMessage to the isolated-world relay is the fallback.
 */
function ambientTransport(key: string, channel: string): PageTransport {
  return {
    post(env: PageToHostEnvelope): void {
      const preamblePost = globals()[RN_POST];
      if (preamblePost) {
        preamblePost(env);
        return;
      }
      window.postMessage(env, window.location.origin);
    },
    onMessage(handler: (env: HostToPageEnvelope) => void): void {
      const g = globals();
      const registry = g[RN_DELIVER] ?? {};
      g[RN_DELIVER] = registry;
      registry[key] = (env: unknown) => {
        if (!isHostToPage(env, channel)) return;
        handler(env);
      };
      window.addEventListener("message", (event: MessageEvent) => {
        if (event.source !== window) return;
        if (event.origin !== window.location.origin) return;
        if (!isHostToPage(event.data, channel)) return;
        handler(event.data);
      });
    },
  };
}

/**
 * Entry point of every standalone chain bundle. The config is serialised into the
 * page by the script builder; without it there is nothing to inject.
 */
export function bootstrap(
  family: ChainFamily,
  install: (bridge: Bridge, config: InjectedConfig) => unknown,
  /** Distinct per bundle: XRP ships two providers over the same family. */
  key: string = family,
): void {
  const config = globals()[RN_CONFIG];
  if (!config || !Array.isArray(config.networks)) return;
  if (!config.networks.some((n) => n.family === family)) return;

  const channel = config.channel ?? DEFAULT_CHANNEL;
  const bridge = createBridge(ambientTransport(key, channel), {
    channel,
    fallbackIcon: initialIcon(config),
  });

  install(bridge, config);
  bridge.sendReady([family]);
}
