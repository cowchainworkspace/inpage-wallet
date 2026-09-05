/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { rnWebViewTransport, RN_DELIVER, RN_POST } from "../../src/transports/rn-webview";
import { DEFAULT_CHANNEL, hostToPage, pageToHost } from "../../src/protocol/envelope";

type RnWindow = Window & {
  ReactNativeWebView?: { postMessage(data: string): void };
  __inpageWalletPost?: (env: unknown) => void;
  __inpageWalletDeliver?: Record<string, (env: unknown) => void>;
};

const w = window as RnWindow;
const READY = pageToHost(DEFAULT_CHANNEL, { kind: "ready", families: ["evm"] });

beforeEach(() => {
  delete w.ReactNativeWebView;
  delete w[RN_POST];
  delete w[RN_DELIVER];
});

describe("rnWebViewTransport", () => {
  it("prefers the postMessage the preamble captured", () => {
    const captured = vi.fn();
    const raw = vi.fn();
    w[RN_POST] = captured;
    w.ReactNativeWebView = { postMessage: raw };

    rnWebViewTransport().post(READY);

    expect(captured).toHaveBeenCalledWith(READY);
    expect(raw).not.toHaveBeenCalled();
  });

  it("serialises to the native bridge when no preamble ran", () => {
    const raw = vi.fn();
    w.ReactNativeWebView = { postMessage: raw };

    rnWebViewTransport().post(READY);

    expect(JSON.parse(raw.mock.calls[0]?.[0] as string)).toEqual(READY);
  });

  it("stays quiet outside a WebView instead of throwing", () => {
    expect(() => rnWebViewTransport().post(READY)).not.toThrow();
  });

  it("registers a named slot in the deliver registry", () => {
    const seen: unknown[] = [];
    rnWebViewTransport({ key: "evm" }).onMessage((env) => seen.push(env));

    const env = hostToPage(DEFAULT_CHANNEL, { kind: "init", icon: "data:x" });
    w[RN_DELIVER]?.evm?.(env);

    expect(seen).toEqual([env]);
  });

  it("drops envelopes from another channel", () => {
    const seen: unknown[] = [];
    rnWebViewTransport({ key: "evm" }).onMessage((env) => seen.push(env));

    w[RN_DELIVER]?.evm?.(hostToPage("other", { kind: "init", icon: "data:x" }));

    expect(seen).toEqual([]);
  });
});
