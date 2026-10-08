/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { bootstrap } from "../../src/inpage/entries/bootstrap";
import { DEFAULT_CHANNEL, hostToPage } from "../../src/protocol/envelope";
import { RN_CONFIG, RN_DELIVER, RN_POST } from "../../src/transports/rn-webview";
import type { Bridge } from "../../src/inpage/core/bridge";
import { configFor } from "./fake-transport";

type Globals = Record<string, unknown>;
const g = globalThis as unknown as Globals;

function boot(): Bridge {
  let captured: Bridge | undefined;
  bootstrap("evm", (bridge) => {
    captured = bridge;
  }, `evm-${Math.random()}`);
  return captured as Bridge;
}

function kinds(calls: unknown[][]): unknown[] {
  return calls.map(([env]) => (env as { kind: string }).kind);
}

function deliverInit(): void {
  const registry = g[RN_DELIVER] as Record<string, (env: unknown) => void>;
  for (const slot of Object.values(registry)) slot(hostToPage(DEFAULT_CHANNEL, { kind: "init", icon: "" }));
}

afterEach(() => {
  delete g[RN_CONFIG];
  delete g[RN_POST];
  delete g[RN_DELIVER];
  vi.restoreAllMocks();
});

describe("bootstrap over React Native", () => {
  it("holds requests until the host's init, so a dropped first message is not lost", async () => {
    g[RN_CONFIG] = configFor(["evm"]);
    const post = vi.fn();
    g[RN_POST] = post;

    const bridge = boot();
    void bridge.request("eth_accounts");
    expect(kinds(post.mock.calls)).toEqual(["ready"]);

    deliverInit();
    expect(kinds(post.mock.calls)).toEqual(["ready", "request"]);
  });
});

describe("bootstrap in an extension MAIN world", () => {
  it("posts requests without waiting for init", () => {
    g[RN_CONFIG] = configFor(["evm"]);
    const post = vi.spyOn(window, "postMessage").mockImplementation(() => undefined);

    const bridge = boot();
    void bridge.request("eth_accounts");

    expect(post.mock.calls.map(([env]) => (env as { kind: string }).kind)).toEqual(["ready", "request"]);
  });
});
