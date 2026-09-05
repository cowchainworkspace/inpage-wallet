import { describe, expect, it, vi } from "vitest";

import { createRnHostTransport } from "../../src/transports/rn-webview";
import { hostToPage, pageToHost, DEFAULT_CHANNEL } from "../../src/protocol/envelope";

const ORIGIN = "https://app.uniswap.org";

function payload(kind: "ready" | "request"): string {
  return JSON.stringify(
    kind === "ready"
      ? pageToHost(DEFAULT_CHANNEL, { kind: "ready", families: ["evm"] })
      : pageToHost(DEFAULT_CHANNEL, { kind: "request", id: "r1", method: "eth_accounts" }),
  );
}

describe("createRnHostTransport", () => {
  it("hands parsed envelopes to the router with the committed origin", () => {
    const seen: { origin: string; kind: string }[] = [];
    const transport = createRnHostTransport({ inject: vi.fn() });
    transport.onMessage((origin, env) => seen.push({ origin, kind: env.kind }));

    transport.receive(ORIGIN, payload("ready"));
    transport.receive(ORIGIN, payload("request"));

    expect(seen).toEqual([
      { origin: ORIGIN, kind: "ready" },
      { origin: ORIGIN, kind: "request" },
    ]);
  });

  it("drops messages that arrive while no origin is committed", () => {
    const seen: unknown[] = [];
    const transport = createRnHostTransport({ inject: vi.fn() });
    transport.onMessage((_o, env) => seen.push(env));

    transport.receive(null, payload("request"));

    expect(seen).toEqual([]);
  });

  it("ignores malformed payloads and foreign channels", () => {
    const seen: unknown[] = [];
    const transport = createRnHostTransport({ inject: vi.fn() });
    transport.onMessage((_o, env) => seen.push(env));

    transport.receive(ORIGIN, "not json");
    transport.receive(ORIGIN, JSON.stringify({ channel: "other", direction: "page-to-host", kind: "ready" }));
    transport.receive(ORIGIN, JSON.stringify(hostToPage(DEFAULT_CHANNEL, { kind: "init", icon: "x" })));

    expect(seen).toEqual([]);
  });

  it("delivers through injectJavaScript", () => {
    const inject = vi.fn();
    const transport = createRnHostTransport({ inject });

    transport.deliver(ORIGIN, hostToPage(DEFAULT_CHANNEL, { kind: "init", icon: "data:x" }));

    expect(inject).toHaveBeenCalledTimes(1);
    expect(inject.mock.calls[0]?.[0]).toContain("__inpageWalletReceive");
  });
});
