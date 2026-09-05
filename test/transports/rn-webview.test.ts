import { describe, expect, it, vi } from "vitest";

import {
  createRnHostTransport,
  MAX_ENVELOPE_BYTES,
  type RnHostTransport,
} from "../../src/transports/rn-webview";
import { hostToPage, pageToHost, DEFAULT_CHANNEL } from "../../src/protocol/envelope";

const ORIGIN = "https://app.uniswap.org";
const NONCE = "0f6f2a8c-8b2d-4f6a-9a1e-1c2d3e4f5a6b";

function payload(kind: "ready" | "request", nonce: string | null = NONCE): string {
  const env = {
    ...(kind === "ready"
      ? pageToHost(DEFAULT_CHANNEL, { kind: "ready", families: ["evm"] })
      : pageToHost(DEFAULT_CHANNEL, { kind: "request", id: "r1", method: "eth_accounts" })),
    ...(nonce === null ? {} : { n: nonce }),
  };
  return JSON.stringify(env);
}

function transportOn(nonce: string | null = NONCE): {
  transport: RnHostTransport;
  seen: { origin: string; kind: string }[];
} {
  const seen: { origin: string; kind: string }[] = [];
  const transport = createRnHostTransport({ inject: vi.fn() });
  transport.onMessage((origin, env) => seen.push({ origin, kind: env.kind }));
  transport.setNonce(nonce);
  return { transport, seen };
}

describe("createRnHostTransport", () => {
  it("hands parsed envelopes to the router with the committed origin", () => {
    const { transport, seen } = transportOn();

    transport.receive(ORIGIN, payload("ready"));
    transport.receive(ORIGIN, payload("request"));

    expect(seen).toEqual([
      { origin: ORIGIN, kind: "ready" },
      { origin: ORIGIN, kind: "request" },
    ]);
  });

  it("drops messages that arrive while no origin is committed", () => {
    const { transport, seen } = transportOn();

    transport.receive(null, payload("request"));

    expect(seen).toEqual([]);
  });

  it("ignores malformed payloads and foreign channels", () => {
    const { transport, seen } = transportOn();

    transport.receive(ORIGIN, "not json");
    transport.receive(
      ORIGIN,
      JSON.stringify({ channel: "other", direction: "page-to-host", kind: "ready", n: NONCE }),
    );
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

describe("nonce", () => {
  it("accepts nothing until a nonce is set", () => {
    const seen: unknown[] = [];
    const transport = createRnHostTransport({ inject: vi.fn() });
    transport.onMessage((_o, env) => seen.push(env));

    transport.receive(ORIGIN, payload("request"));

    expect(seen).toEqual([]);
  });

  it("drops an envelope carrying no nonce", () => {
    // What an Android iframe can hand-roll: the native bridge is exposed to it,
    // the injected script's stamp is not.
    const { transport, seen } = transportOn();

    transport.receive(ORIGIN, payload("request", null));

    expect(seen).toEqual([]);
  });

  it("drops an envelope carrying the wrong nonce", () => {
    const { transport, seen } = transportOn();

    transport.receive(ORIGIN, payload("request", "guessed"));

    expect(seen).toEqual([]);
  });

  it("drops envelopes minted for the previous document", () => {
    const { transport, seen } = transportOn();

    transport.setNonce("a-newer-nonce");
    transport.receive(ORIGIN, payload("request"));

    expect(seen).toEqual([]);
  });
});

describe("payload size", () => {
  it("drops an oversized payload before parsing it", () => {
    const { transport, seen } = transportOn();
    const huge = JSON.stringify({
      ...pageToHost(DEFAULT_CHANNEL, {
        kind: "request",
        id: "r1",
        method: "eth_accounts",
        params: ["x".repeat(MAX_ENVELOPE_BYTES)],
      }),
      n: NONCE,
    });

    expect(huge.length).toBeGreaterThan(MAX_ENVELOPE_BYTES);
    transport.receive(ORIGIN, huge);

    expect(seen).toEqual([]);
  });
});
