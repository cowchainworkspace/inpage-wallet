/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://app.uniswap.org" }
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createContentScriptRelay,
  type WorkerBoundMessage,
} from "../../src/transports/extension-content-script";
import {
  DEFAULT_CHANNEL,
  hostToPage,
  pageToHost,
  type HostToPageEnvelope,
} from "../../src/protocol/envelope";

const ORIGIN = "https://app.uniswap.org";

type Harness = {
  toWorker: WorkerBoundMessage[];
  toPage: HostToPageEnvelope[];
  fromWorker: (env: HostToPageEnvelope) => void;
  stop(): void;
};

function relay(resolveIcon?: () => Promise<string>): Harness {
  const toWorker: WorkerBoundMessage[] = [];
  const toPage: HostToPageEnvelope[] = [];
  let deliver: (env: HostToPageEnvelope) => void = () => {};

  window.addEventListener("message", (e) => {
    const env = e.data as HostToPageEnvelope;
    if (env?.direction === "host-to-page") toPage.push(env);
  });

  const relayed = createContentScriptRelay({
    sendToWorker: (m) => toWorker.push(m),
    onWorkerMessage: (handler) => {
      deliver = handler;
      return () => {
        deliver = () => {};
      };
    },
    ...(resolveIcon ? { resolveIcon } : {}),
  });

  return { toWorker, toPage, fromWorker: (env) => deliver(env), stop: relayed.stop };
}

// jsdom's own postMessage reports an empty origin and a null source, which the
// relay is right to reject, so the page's message is synthesised here instead.
function fromPage(data: unknown): void {
  window.dispatchEvent(new MessageEvent("message", { data, origin: ORIGIN, source: window }));
}

function pagePosts(message: Parameters<typeof pageToHost>[1]): void {
  fromPage(pageToHost(DEFAULT_CHANNEL, message));
}

beforeEach(() => {
  expect(window.location.origin).toBe(ORIGIN);
});

describe("content script relay", () => {
  it("forwards page requests to the worker with the document's origin", async () => {
    const h = relay();

    pagePosts({ kind: "request", id: "r1", method: "eth_accounts" });
    await vi.waitFor(() => expect(h.toWorker).toHaveLength(1));

    expect(h.toWorker[0]).toEqual({
      origin: ORIGIN,
      env: {
        channel: DEFAULT_CHANNEL,
        direction: "page-to-host",
        kind: "request",
        id: "r1",
        method: "eth_accounts",
      },
    });
    h.stop();
  });

  it("answers ready with the resolved icon instead of forwarding it", async () => {
    const h = relay(async () => "data:image/png;base64,AAA");

    pagePosts({ kind: "ready", families: ["evm"] });
    await vi.waitFor(() =>
      expect(h.toPage.some((e) => e.kind === "init")).toBe(true),
    );

    expect(h.toWorker).toHaveLength(0);
    h.stop();
  });

  it("does not push an empty icon over the placeholder", async () => {
    const h = relay(async () => "");

    pagePosts({ kind: "ready", families: ["evm"] });
    await new Promise((r) => setTimeout(r, 5));

    expect(h.toPage).toHaveLength(0);
    h.stop();
  });

  it("relays worker responses down to the page", async () => {
    const h = relay();

    h.fromWorker(hostToPage(DEFAULT_CHANNEL, { kind: "response", id: "r1", result: ["0xabc"] }));
    await vi.waitFor(() => expect(h.toPage).toHaveLength(1));

    expect(h.toPage[0]).toMatchObject({ kind: "response", id: "r1" });
    h.stop();
  });

  it("ignores envelopes from another channel", async () => {
    const h = relay();

    fromPage(pageToHost("other", { kind: "request", id: "x", method: "eth_accounts" }));
    await new Promise((r) => setTimeout(r, 5));

    expect(h.toWorker).toHaveLength(0);
    h.stop();
  });

  it("stops relaying after stop()", async () => {
    const h = relay();
    h.stop();

    pagePosts({ kind: "request", id: "r2", method: "eth_accounts" });
    await new Promise((r) => setTimeout(r, 5));

    expect(h.toWorker).toHaveLength(0);
  });
});
