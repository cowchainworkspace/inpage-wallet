/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://insecure.example" }
 */
import { describe, expect, it, vi } from "vitest";

import { createContentScriptRelay } from "../../src/transports/extension-content-script";
import { originOf } from "../../src/host/origin";
import { DEFAULT_CHANNEL, pageToHost } from "../../src/protocol/envelope";

describe("content script relay in a document with no usable origin", () => {
  it("has nothing to key a session on", () => {
    // The four documents that reach this branch. jsdom cannot host the opaque
    // three — it refuses storage for them — so the relay itself is exercised
    // over http below and the origin rule is pinned here.
    expect(originOf("null")).toBeNull();
    expect(originOf("data:text/html,<p>x</p>")).toBeNull();
    expect(originOf("file:///page.html")).toBeNull();
    expect(originOf(window.location.href)).toBeNull();
  });

  it("relays nothing at all", async () => {
    const sendToWorker = vi.fn();
    const onWorkerMessage = vi.fn(() => () => {});
    const resolveIcon = vi.fn(async () => "data:image/png;base64,AAA");

    const relay = createContentScriptRelay({ sendToWorker, onWorkerMessage, resolveIcon });
    window.dispatchEvent(
      new MessageEvent("message", {
        data: pageToHost(DEFAULT_CHANNEL, { kind: "request", id: "r1", method: "eth_accounts" }),
        origin: window.location.origin,
        source: window,
      }),
    );
    await new Promise((r) => setTimeout(r, 5));

    expect(sendToWorker).not.toHaveBeenCalled();
    expect(onWorkerMessage).not.toHaveBeenCalled();
    expect(resolveIcon).not.toHaveBeenCalled();
    expect(() => relay.stop()).not.toThrow();
  });
});
