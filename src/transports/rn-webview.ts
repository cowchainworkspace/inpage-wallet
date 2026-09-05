import {
  DEFAULT_CHANNEL,
  isHostToPage,
  isPageToHost,
  type HostToPageEnvelope,
  type PageToHostEnvelope,
} from "../protocol/envelope";
import type { HostTransport, PageTransport } from "../inpage/core/transport";

/** Globals the preamble defines before any page script can run. */
export const RN_POST = "__inpageWalletPost";
export const RN_RECEIVE = "__inpageWalletReceive";
export const RN_DELIVER = "__inpageWalletDeliver";
export const RN_CONFIG = "__inpageWalletConfig";
export const RN_GUARD = "__inpageWalletBridge";

type PageGlobals = {
  [RN_POST]?: (env: unknown) => void;
  [RN_DELIVER]?: Record<string, (env: unknown) => void>;
  ReactNativeWebView?: { postMessage(data: string): void };
};

function globals(): PageGlobals {
  return globalThis as unknown as PageGlobals;
}

let deliverSlot = 0;

export type RnPageTransportOptions = {
  channel?: string | undefined;
  /** Slot in the deliver registry; one per provider sharing the page. */
  key?: string | undefined;
};

/**
 * Page side for a React Native WebView. There is no isolated world, so the
 * preamble captures `ReactNativeWebView.postMessage` before page scripts run and
 * this binds to what it captured. Origin is attributed natively, never read here.
 */
export function rnWebViewTransport(options: RnPageTransportOptions = {}): PageTransport {
  const channel = options.channel ?? DEFAULT_CHANNEL;
  const key = options.key ?? `slot${(deliverSlot += 1)}`;

  return {
    post(env: PageToHostEnvelope): void {
      const g = globals();
      const preamblePost = g[RN_POST];
      if (preamblePost) {
        preamblePost(env);
        return;
      }
      const native = g.ReactNativeWebView;
      if (!native) return;
      try {
        native.postMessage(JSON.stringify(env));
      } catch {
        /* a serialisation failure must not break the page */
      }
    },
    onMessage(handler: (env: HostToPageEnvelope) => void): void {
      const g = globals();
      const registry = g[RN_DELIVER] ?? {};
      g[RN_DELIVER] = registry;
      registry[key] = (env: unknown) => {
        if (!isHostToPage(env, channel)) return;
        handler(env);
      };
    },
  };
}

/** The `injectJavaScript` payload that hands one envelope to the page. */
export function deliveryScript(env: HostToPageEnvelope): string {
  return `window.${RN_RECEIVE} && window.${RN_RECEIVE}(${JSON.stringify(env)}); true;`;
}

export type RnHostTransportOptions = {
  /** Wire this to `webView.injectJavaScript`. */
  inject(script: string): void;
  channel?: string | undefined;
};

export type RnHostTransport = HostTransport & {
  /**
   * Feed WebView `onMessage` payloads in. `origin` is the committed navigation
   * origin: pass null while a navigation is in flight and the message is dropped.
   */
  receive(origin: string | null, data: string): void;
};

export function createRnHostTransport(options: RnHostTransportOptions): RnHostTransport {
  const channel = options.channel ?? DEFAULT_CHANNEL;
  const handlers: ((origin: string, env: PageToHostEnvelope) => void)[] = [];

  return {
    deliver(_origin: string, env: HostToPageEnvelope): void {
      options.inject(deliveryScript(env));
    },
    onMessage(handler): void {
      handlers.push(handler);
    },
    receive(origin, data): void {
      if (!origin) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      if (!isPageToHost(parsed, channel)) return;
      for (const handler of handlers) handler(origin, parsed);
    },
  };
}
