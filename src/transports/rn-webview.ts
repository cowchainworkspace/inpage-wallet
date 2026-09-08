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

/** JSON is not a JavaScript expression until the line separators are escaped. */
function jsLiteral(value: unknown): string {
  return JSON.stringify(value ?? null)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * The `injectJavaScript` payload that hands one envelope to the page. The nonce
 * is the one the current document was injected with: a script built for an
 * earlier document reaches nothing.
 */
export function deliveryScript(env: HostToPageEnvelope, nonce?: string | null): string {
  return `window.${RN_RECEIVE} && window.${RN_RECEIVE}(${jsLiteral(env)}, ${jsLiteral(nonce)}); true;`;
}

/** Why the transport refused a message. Never says which nonce was expected. */
export type RnDropReason =
  | "no-commit"
  | "nonce-mismatch"
  | "origin-mismatch"
  | "oversized"
  | "malformed";

export type RnHostTransportOptions = {
  /** Wire this to `webView.injectJavaScript`. */
  inject(script: string): void;
  channel?: string | undefined;
  /**
   * Called for every message the transport refuses, in both directions. A page
   * injected with a nonce the host has since rotated is dropped as
   * `nonce-mismatch` and waits forever otherwise; this is what makes it visible.
   * The nonce itself is never passed on.
   */
  onDrop?(reason: RnDropReason, detail: { origin?: string; size?: number }): void;
};

/** Above any legitimate envelope, and small enough that parsing one cannot stall. */
export const MAX_ENVELOPE_BYTES = 1_000_000;

/** The document the WebView is currently showing: origin and nonce, never one alone. */
export type RnCommittedNavigation = { origin: string; nonce: string };

export type RnHostTransport = HostTransport & {
  /**
   * Feed WebView `onMessage` payloads in. `origin` is the committed navigation
   * origin: pass null while a navigation is in flight and the message is dropped.
   */
  receive(origin: string | null, data: string): void;
  /**
   * The document now showing, or null between documents. Until one is committed
   * nothing is accepted or delivered: on Android every frame can reach
   * `ReactNativeWebView.postMessage`, and only the injected script knows the nonce.
   */
  commit(navigation: RnCommittedNavigation | null): void;
};

/** `process` is not declared in a WebView, so it is read off globalThis. */
function inDevelopment(): boolean {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.NODE_ENV !== "production";
}

export function createRnHostTransport(options: RnHostTransportOptions): RnHostTransport {
  const channel = options.channel ?? DEFAULT_CHANNEL;
  const handlers: ((origin: string, env: PageToHostEnvelope) => void)[] = [];
  let current: RnCommittedNavigation | null = null;
  /** One warning per reason per document: a stranded page drops every message. */
  const warned = new Set<RnDropReason>();

  function drop(reason: RnDropReason, detail: { origin?: string; size?: number } = {}): void {
    if (options.onDrop) {
      try {
        options.onDrop(reason, detail);
      } catch {
        /* a host callback must not break the bridge */
      }
      return;
    }
    if (warned.has(reason) || !inDevelopment()) return;
    warned.add(reason);
    globalThis.console?.warn?.(`[inpage-wallet] dropped a WebView message: ${reason}`, detail);
  }

  return {
    // A WebView has one document; injecting an answer for an origin that is no
    // longer showing would hand it to whatever replaced it.
    deliver(origin: string, env: HostToPageEnvelope): void {
      if (!current) return drop("no-commit", { origin });
      if (origin !== current.origin) return drop("origin-mismatch", { origin });
      options.inject(deliveryScript(env, current.nonce));
    },
    onMessage(handler): void {
      handlers.push(handler);
    },
    commit(navigation): void {
      current = navigation;
      warned.clear();
    },
    receive(origin, data): void {
      if (!origin || !current) return drop("no-commit", origin ? { origin } : {});
      if (origin !== current.origin) return drop("origin-mismatch", { origin });
      if (typeof data !== "string") return drop("malformed", { origin });
      if (data.length > MAX_ENVELOPE_BYTES) return drop("oversized", { origin, size: data.length });
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return drop("malformed", { origin });
      }
      if (!isPageToHost(parsed, channel)) return drop("malformed", { origin });
      if (parsed.n !== current.nonce) return drop("nonce-mismatch", { origin });
      for (const handler of handlers) handler(origin, parsed);
    },
  };
}
