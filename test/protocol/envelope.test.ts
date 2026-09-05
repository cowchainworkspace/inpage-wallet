import { describe, expect, it } from "vitest";

import {
  DEFAULT_CHANNEL,
  hostToPage,
  isHostToPage,
  isPageToHost,
  pageToHost,
} from "../../src/protocol/envelope";

const CH = DEFAULT_CHANNEL;
const toHost = (body: Record<string, unknown>): Record<string, unknown> => ({
  channel: CH,
  direction: "page-to-host",
  ...body,
});
const toPage = (body: Record<string, unknown>): Record<string, unknown> => ({
  channel: CH,
  direction: "host-to-page",
  ...body,
});

const LONG = "x".repeat(129);

describe("isPageToHost", () => {
  it("accepts what the page actually sends", () => {
    expect(isPageToHost(pageToHost(CH, { kind: "ready", families: ["evm"] }), CH)).toBe(true);
    expect(isPageToHost(pageToHost(CH, { kind: "request", id: "r1", method: "eth_accounts" }), CH)).toBe(
      true,
    );
    expect(
      isPageToHost({ ...toHost({ kind: "request", id: "r1", method: "eth_call", params: [] }) }, CH),
    ).toBe(true);
    expect(isPageToHost({ ...toHost({ kind: "ready", families: ["evm"] }), n: "abc" }, CH)).toBe(true);
  });

  it("rejects a wrong channel, direction or kind", () => {
    expect(isPageToHost(toHost({ kind: "ready", families: [] }), "other")).toBe(false);
    expect(isPageToHost(toPage({ kind: "init", icon: "x" }), CH)).toBe(false);
    expect(isPageToHost(toHost({ kind: "response", id: "r1" }), CH)).toBe(false);
    expect(isPageToHost(null, CH)).toBe(false);
    expect(isPageToHost("string", CH)).toBe(false);
  });

  it("rejects a ready whose families are not families", () => {
    expect(isPageToHost(toHost({ kind: "ready" }), CH)).toBe(false);
    expect(isPageToHost(toHost({ kind: "ready", families: "evm" }), CH)).toBe(false);
    expect(isPageToHost(toHost({ kind: "ready", families: ["evm", "dogecoin"] }), CH)).toBe(false);
  });

  it("rejects a request whose id or method is missing, mistyped or oversized", () => {
    expect(isPageToHost(toHost({ kind: "request", method: "eth_accounts" }), CH)).toBe(false);
    expect(isPageToHost(toHost({ kind: "request", id: "", method: "eth_accounts" }), CH)).toBe(false);
    expect(isPageToHost(toHost({ kind: "request", id: 1, method: "eth_accounts" }), CH)).toBe(false);
    expect(isPageToHost(toHost({ kind: "request", id: LONG, method: "eth_accounts" }), CH)).toBe(false);
    expect(isPageToHost(toHost({ kind: "request", id: "r1" }), CH)).toBe(false);
    expect(isPageToHost(toHost({ kind: "request", id: "r1", method: LONG }), CH)).toBe(false);
  });

  it("rejects params that are not an array", () => {
    expect(
      isPageToHost(toHost({ kind: "request", id: "r1", method: "eth_call", params: {} }), CH),
    ).toBe(false);
  });

  it("rejects a nonce that is not a bounded string", () => {
    expect(isPageToHost({ ...toHost({ kind: "ready", families: [] }), n: 7 }, CH)).toBe(false);
    expect(isPageToHost({ ...toHost({ kind: "ready", families: [] }), n: LONG }, CH)).toBe(false);
  });
});

describe("isHostToPage", () => {
  it("accepts what the host actually sends", () => {
    expect(isHostToPage(hostToPage(CH, { kind: "init", icon: "data:x" }), CH)).toBe(true);
    expect(isHostToPage(hostToPage(CH, { kind: "response", id: "r1", result: [] }), CH)).toBe(true);
    expect(
      isHostToPage(
        hostToPage(CH, { kind: "response", id: "r1", error: { code: 4001, message: "no" } }),
        CH,
      ),
    ).toBe(true);
    expect(
      isHostToPage(
        hostToPage(CH, { kind: "event", family: "evm", event: "chainChanged", data: "0x1" }),
        CH,
      ),
    ).toBe(true);
  });

  it("rejects an init with no icon string", () => {
    expect(isHostToPage(toPage({ kind: "init" }), CH)).toBe(false);
    expect(isHostToPage(toPage({ kind: "init", icon: 1 }), CH)).toBe(false);
  });

  it("rejects a response whose id or error code is not what it claims", () => {
    expect(isHostToPage(toPage({ kind: "response" }), CH)).toBe(false);
    expect(isHostToPage(toPage({ kind: "response", id: LONG }), CH)).toBe(false);
    expect(isHostToPage(toPage({ kind: "response", id: "r1", error: "boom" }), CH)).toBe(false);
    expect(
      isHostToPage(toPage({ kind: "response", id: "r1", error: { message: "boom" } }), CH),
    ).toBe(false);
  });

  it("rejects an event outside the known set", () => {
    expect(
      isHostToPage(toPage({ kind: "event", family: "evm", event: "drainWallet" }), CH),
    ).toBe(false);
    expect(
      isHostToPage(toPage({ kind: "event", family: "dogecoin", event: "disconnect" }), CH),
    ).toBe(false);
    expect(isHostToPage(toPage({ kind: "event", event: "disconnect" }), CH)).toBe(false);
  });
});
