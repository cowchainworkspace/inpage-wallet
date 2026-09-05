import { DEFAULT_CHANNEL, type HostToPageEnvelope } from "../protocol/envelope";
import { familiesOf, type ChainFamily } from "../protocol/networks";
import type { InjectedConfig } from "../inpage/core/config";
import {
  deliveryScript,
  RN_CONFIG,
  RN_DELIVER,
  RN_GUARD,
  RN_POST,
  RN_RECEIVE,
} from "../transports/rn-webview";
import { INPAGE_BUNDLES } from "./bundles.generated";

/** Bundles injected for each family. XRP ships two discovery surfaces. */
const BUNDLES_FOR: Record<ChainFamily, string[]> = {
  evm: ["evm"],
  solana: ["solana"],
  cardano: ["cardano"],
  tron: ["tron"],
  xrp: ["xrp", "xrp-standard"],
  btc: ["btc"],
};

export function availableBundles(): string[] {
  return Object.keys(INPAGE_BUNDLES).sort();
}

/**
 * There is no isolated world in a WebView, so this captures
 * `ReactNativeWebView.postMessage` before any page script can swap it. On Android
 * that bridge is exposed to every frame, so the preamble also stamps the
 * per-document `nonce` — held in this closure, never in the page-readable config —
 * on each envelope. The host drops anything carrying the wrong one. Exported for
 * hosts that register the chain bundles as files instead of inlining them.
 */
export function buildPreamble(config: InjectedConfig): string {
  const channel = config.channel ?? DEFAULT_CHANNEL;
  const { nonce, ...pageConfig } = config;
  return `(function () {
  var CHANNEL = ${JSON.stringify(channel)};
  var NONCE = ${JSON.stringify(nonce ?? null)};

  function lock(name, value) {
    try {
      Object.defineProperty(window, name, {
        value: value, writable: false, configurable: false, enumerable: false
      });
    } catch (e) {}
  }

  // Written before the guard is read: a page that pre-sets the guard must not be
  // able to leave its own config standing. Shallow freeze — a page script must
  // not swap identity or channel before a bundle reads them.
  lock(${JSON.stringify(RN_CONFIG)}, Object.freeze(${JSON.stringify(pageConfig)}));

  if (window.${RN_GUARD}) return;
  window.${RN_GUARD} = true;

  var native = window.ReactNativeWebView;
  var send = native && native.postMessage ? native.postMessage.bind(native) : null;

  window.${RN_DELIVER} = window.${RN_DELIVER} || {};

  lock(${JSON.stringify(RN_POST)}, function (env) {
    if (!send || !env) return;
    try {
      var out = {};
      for (var k in env) {
        if (Object.prototype.hasOwnProperty.call(env, k)) out[k] = env[k];
      }
      out.n = NONCE;
      send(JSON.stringify(out));
    } catch (e) {}
  });

  lock(${JSON.stringify(RN_RECEIVE)}, function (env) {
    if (!env || env.channel !== CHANNEL) return;
    var d = window.${RN_DELIVER};
    for (var key in d) {
      if (Object.prototype.hasOwnProperty.call(d, key)) {
        try { d[key](env); } catch (e) {}
      }
    }
  });
})();`;
}

/**
 * The whole injected script for a WebView: the preamble, the serialised config,
 * and one bundle per family the host registered.
 */
export function buildInjectedScript(config: InjectedConfig): string {
  const parts = [buildPreamble(config)];
  for (const family of familiesOf(config.networks)) {
    for (const name of BUNDLES_FOR[family]) {
      const bundle = INPAGE_BUNDLES[name];
      if (bundle) parts.push(bundle);
    }
  }
  // WebViews treat a script whose last expression is undefined as an error.
  return `${parts.join("\n")}\ntrue;`;
}

/** One host-to-page envelope as an `injectJavaScript` payload. */
export function buildDeliveryScript(env: HostToPageEnvelope): string {
  return deliveryScript(env);
}
