/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInjectedWallet } from "../../src/inpage";
import { resetInstalls } from "../../src/inpage/core/guard";
import { DEFAULT_CHANNEL } from "../../src/protocol/envelope";
import { resetWindowListeners } from "./dom";
import { configFor, fakeTransport, type FakeTransport } from "./fake-transport";

const ADDRESS = "TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE";

type TronLink = { ready: boolean; request(a: { method: string; params?: unknown }): Promise<unknown> };
type TronWindow = Window & { tronLink?: TronLink; tronWeb?: unknown };

function install(): { tronLink: TronLink; transport: FakeTransport } {
  const transport = fakeTransport(DEFAULT_CHANNEL);
  createInjectedWallet(transport, configFor(["tron"]));
  const tronLink = (window as TronWindow).tronLink;
  if (!tronLink) throw new Error("no tronLink installed");
  return { tronLink, transport };
}

beforeEach(() => {
  resetWindowListeners();
  resetInstalls();
  delete (window as TronWindow).tronLink;
});

describe("Tron injection", () => {
  it("exposes window.tronLink and leaves window.tronWeb alone", () => {
    const { tronLink } = install();

    expect(tronLink.ready).toBe(false);
    expect((window as TronWindow).tronWeb).toBeUndefined();
  });

  it("flips ready and announces the account on tron_requestAccounts", async () => {
    const { tronLink, transport } = install();
    const messages: unknown[] = [];
    window.addEventListener("message", (e) => {
      if ((e.data as { isTronLink?: boolean })?.isTronLink) messages.push(e.data);
    });

    const pending = tronLink.request({ method: "tron_requestAccounts" });
    expect(transport.lastRequest().method).toBe("tron_requestAccounts");
    transport.respond({ address: ADDRESS });

    await expect(pending).resolves.toEqual({ code: 200, message: "ok" });
    expect(tronLink.ready).toBe(true);
    await vi.waitFor(() => expect(messages).toHaveLength(3));
  });

  it("reports a refusal as TronLink's 4001", async () => {
    const { tronLink, transport } = install();

    const pending = tronLink.request({ method: "tron_requestAccounts" });
    transport.respond(null);

    await expect(pending).resolves.toEqual({ code: 4001, message: "User rejected" });
    expect(tronLink.ready).toBe(false);
  });

  it("forwards every other method straight to the bridge", async () => {
    const { tronLink, transport } = install();

    const pending = tronLink.request({
      method: "tron_signTransaction",
      params: [{ transaction: { raw: 1 } }],
    });
    expect(transport.lastRequest()).toMatchObject({
      method: "tron_signTransaction",
      params: [{ transaction: { raw: 1 } }],
    });
    transport.respond({ signature: ["sig"] });

    await expect(pending).resolves.toEqual({ signature: ["sig"] });
  });

  it("clears ready when the host reports a disconnect", async () => {
    const { tronLink, transport } = install();
    const pending = tronLink.request({ method: "tron_requestAccounts" });
    transport.respond({ address: ADDRESS });
    await pending;

    transport.deliver({ kind: "event", family: "tron", event: "accountsChanged", data: [] });

    expect(tronLink.ready).toBe(false);
  });

  it("is a no-op on a second injection", () => {
    const { tronLink } = install();
    createInjectedWallet(fakeTransport(DEFAULT_CHANNEL), configFor(["tron"]));

    expect((window as TronWindow).tronLink).toBe(tronLink);
  });
});
