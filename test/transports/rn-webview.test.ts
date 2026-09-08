import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createRnHostTransport,
  MAX_ENVELOPE_BYTES,
  type RnDropReason,
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
  transport.commit(nonce === null ? null : { origin: ORIGIN, nonce });
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

  it("delivers through injectJavaScript, carrying the document's nonce", () => {
    const inject = vi.fn();
    const transport = createRnHostTransport({ inject });
    transport.commit({ origin: ORIGIN, nonce: NONCE });

    transport.deliver(ORIGIN, hostToPage(DEFAULT_CHANNEL, { kind: "init", icon: "data:x" }));

    expect(inject).toHaveBeenCalledTimes(1);
    expect(inject.mock.calls[0]?.[0]).toContain("__inpageWalletReceive");
    expect(inject.mock.calls[0]?.[0]).toContain(NONCE);
  });

  it("injects nothing for an origin that is no longer showing", () => {
    const inject = vi.fn();
    const transport = createRnHostTransport({ inject });
    transport.commit({ origin: "https://evil.example", nonce: NONCE });

    transport.deliver(ORIGIN, hostToPage(DEFAULT_CHANNEL, { kind: "init", icon: "data:x" }));

    expect(inject).not.toHaveBeenCalled();
  });

  it("injects nothing while no navigation is committed", () => {
    const inject = vi.fn();
    const transport = createRnHostTransport({ inject });

    transport.deliver(ORIGIN, hostToPage(DEFAULT_CHANNEL, { kind: "init", icon: "data:x" }));

    expect(inject).not.toHaveBeenCalled();
  });
});

describe("nonce", () => {
  it("accepts nothing until a navigation is committed", () => {
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

    transport.commit({ origin: ORIGIN, nonce: "a-newer-nonce" });
    transport.receive(ORIGIN, payload("request"));

    expect(seen).toEqual([]);
  });

  it("drops a message whose origin is not the one committed", () => {
    const { transport, seen } = transportOn();

    transport.receive("https://evil.example", payload("request"));

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

describe("dropped messages are observable", () => {
  function watched(): {
    transport: RnHostTransport;
    drops: { reason: RnDropReason; detail: { origin?: string; size?: number } }[];
  } {
    const drops: { reason: RnDropReason; detail: { origin?: string; size?: number } }[] = [];
    const transport = createRnHostTransport({
      inject: vi.fn(),
      onDrop: (reason, detail) => void drops.push({ reason, detail }),
    });
    transport.commit({ origin: ORIGIN, nonce: NONCE });
    return { transport, drops };
  }

  it("reports a message that arrives before any navigation is committed", () => {
    const drops: RnDropReason[] = [];
    const transport = createRnHostTransport({
      inject: vi.fn(),
      onDrop: (reason) => void drops.push(reason),
    });

    transport.receive(ORIGIN, payload("request"));
    transport.deliver(ORIGIN, hostToPage(DEFAULT_CHANNEL, { kind: "init", icon: "x" }));

    expect(drops).toEqual(["no-commit", "no-commit"]);
  });

  it("reports a message minted for a document the host has navigated away from", () => {
    const { transport, drops } = watched();

    transport.commit({ origin: ORIGIN, nonce: "a-newer-nonce" });
    transport.receive(ORIGIN, payload("request"));

    expect(drops).toEqual([{ reason: "nonce-mismatch", detail: { origin: ORIGIN } }]);
  });

  it("reports an origin that is not the one committed, in both directions", () => {
    const { transport, drops } = watched();

    transport.receive("https://evil.example", payload("request"));
    transport.deliver("https://evil.example", hostToPage(DEFAULT_CHANNEL, { kind: "init", icon: "x" }));

    expect(drops).toEqual([
      { reason: "origin-mismatch", detail: { origin: "https://evil.example" } },
      { reason: "origin-mismatch", detail: { origin: "https://evil.example" } },
    ]);
  });

  it("reports an oversized payload with its size", () => {
    const { transport, drops } = watched();
    const huge = "x".repeat(MAX_ENVELOPE_BYTES + 1);

    transport.receive(ORIGIN, huge);

    expect(drops).toEqual([
      { reason: "oversized", detail: { origin: ORIGIN, size: huge.length } },
    ]);
  });

  it("reports payloads that are not an envelope of ours", () => {
    const { transport, drops } = watched();

    transport.receive(ORIGIN, "not json");
    transport.receive(
      ORIGIN,
      JSON.stringify({ channel: "other", direction: "page-to-host", kind: "ready", n: NONCE }),
    );

    expect(drops.map((d) => d.reason)).toEqual(["malformed", "malformed"]);
  });

  it("never hands the nonce to the callback", () => {
    const { transport, drops } = watched();

    transport.receive(ORIGIN, payload("request", "guessed"));

    expect(JSON.stringify(drops)).not.toContain(NONCE);
    expect(JSON.stringify(drops)).not.toContain("guessed");
  });

  it("keeps working when the callback throws", () => {
    const seen: string[] = [];
    const transport = createRnHostTransport({
      inject: vi.fn(),
      onDrop: () => {
        throw new Error("host bug");
      },
    });
    transport.onMessage((_o, env) => void seen.push(env.kind));
    transport.commit({ origin: ORIGIN, nonce: NONCE });

    expect(() => transport.receive("https://evil.example", payload("request"))).not.toThrow();
    transport.receive(ORIGIN, payload("request"));
    expect(seen).toEqual(["request"]);
  });
});

describe("without a callback, development warns once per reason", () => {
  function warns(): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(console, "warn").mockImplementation(() => {});
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns once however many messages are dropped for that reason", () => {
    const warn = warns();
    const transport = createRnHostTransport({ inject: vi.fn() });
    transport.commit({ origin: ORIGIN, nonce: NONCE });

    for (let i = 0; i < 5; i += 1) transport.receive(ORIGIN, payload("request", "guessed"));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("nonce-mismatch");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(NONCE);
  });

  it("warns once per reason", () => {
    const warn = warns();
    const transport = createRnHostTransport({ inject: vi.fn() });
    transport.commit({ origin: ORIGIN, nonce: NONCE });

    transport.receive(ORIGIN, payload("request", "guessed"));
    transport.receive("https://evil.example", payload("request"));
    transport.receive(ORIGIN, "not json");

    expect(warn.mock.calls.map((c) => String(c[0]).replace(/^.*: /, ""))).toEqual([
      "nonce-mismatch",
      "origin-mismatch",
      "malformed",
    ]);
  });

  it("warns again for the next document", () => {
    const warn = warns();
    const transport = createRnHostTransport({ inject: vi.fn() });
    transport.commit({ origin: ORIGIN, nonce: NONCE });

    transport.receive(ORIGIN, payload("request", "guessed"));
    transport.commit({ origin: ORIGIN, nonce: "a-newer-nonce" });
    transport.receive(ORIGIN, payload("request", "guessed"));

    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("says nothing when the host supplied a callback", () => {
    const warn = warns();
    const transport = createRnHostTransport({ inject: vi.fn(), onDrop: () => {} });
    transport.commit({ origin: ORIGIN, nonce: NONCE });

    transport.receive(ORIGIN, payload("request", "guessed"));

    expect(warn).not.toHaveBeenCalled();
  });

  it("says nothing in production", () => {
    const warn = warns();
    vi.stubEnv("NODE_ENV", "production");
    const transport = createRnHostTransport({ inject: vi.fn() });
    transport.commit({ origin: ORIGIN, nonce: NONCE });

    transport.receive(ORIGIN, payload("request", "guessed"));

    expect(warn).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});
