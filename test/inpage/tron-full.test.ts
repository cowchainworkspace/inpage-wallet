/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { bridgeFor } from "../../src/inpage";
import { installTronFull, type TronWebLike } from "../../src/inpage/chains/tron-full";
import { resetInstalls } from "../../src/inpage/core/guard";
import { DEFAULT_CHANNEL } from "../../src/protocol/envelope";
import { resetWindowListeners } from "./dom";
import { configFor, fakeTransport, type FakeTransport } from "./fake-transport";

const ADDRESS = "TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE";

type TronWindow = Window & {
  tron?: {
    readonly tronWeb: unknown;
    request(args: { method: string; params?: unknown }): Promise<unknown>;
  };
  tronWeb?: unknown;
  tronLink?: { ready: boolean };
};

function fakeTronWeb(): TronWebLike & { setAddress: ReturnType<typeof vi.fn> } {
  return {
    setAddress: vi.fn(),
    trx: {
      sign: async () => "original",
      signMessageV2: async () => "original",
      multiSign: async () => "original",
    },
  };
}

function install(): {
  tronWeb: ReturnType<typeof fakeTronWeb>;
  transport: FakeTransport;
  tronLink: NonNullable<ReturnType<typeof installTronFull>>;
} {
  const config = configFor(["tron"]);
  const transport = fakeTransport(DEFAULT_CHANNEL);
  const tronWeb = fakeTronWeb();
  const tronLink = installTronFull(bridgeFor(transport, config), config, { tronWeb });
  if (!tronLink) throw new Error("tron-full did not install");
  return { tronWeb, transport, tronLink };
}

beforeEach(() => {
  resetWindowListeners();
  resetInstalls();
  delete (window as TronWindow).tron;
  delete (window as TronWindow).tronLink;
  delete (window as TronWindow).tronWeb;
});

describe("Tron full SDK injection", () => {
  it("puts the host's TronWeb instance on the page", () => {
    const { tronWeb } = install();

    expect((window as TronWindow).tronWeb).toBe(tronWeb);
    expect((tronWeb as { ready?: boolean }).ready).toBe(false);
  });

  it("redirects only the signing methods across the bridge", async () => {
    const { tronWeb, transport } = install();
    const trx = tronWeb.trx as { sign(t: unknown): Promise<unknown> };

    const pending = trx.sign({ raw_data: 1 });
    expect(transport.lastRequest()).toMatchObject({
      method: "tron_signTransaction",
      params: [{ transaction: { raw_data: 1 } }],
    });

    transport.respond({ signature: ["s"] });
    await expect(pending).resolves.toEqual({ signature: ["s"] });
  });

  it("sets the address and flips ready on connect", async () => {
    const { tronWeb, transport, tronLink } = install();

    const pending = tronLink.request({ method: "tron_requestAccounts" });
    transport.respond({ address: ADDRESS });

    await expect(pending).resolves.toEqual({ code: 200, message: "ok" });
    expect(tronWeb.setAddress).toHaveBeenCalledWith(ADDRESS);
    expect(tronLink.ready).toBe(true);
  });

  it("hands the instance to window.tron only once the account is authorized", async () => {
    const { tronWeb, transport } = install();
    const provider = (window as TronWindow).tron;
    if (!provider) throw new Error("no window.tron installed");

    expect(provider.tronWeb).toBe(false);

    const pending = provider.request({ method: "eth_requestAccounts" });
    transport.respond({ address: ADDRESS });
    await expect(pending).resolves.toEqual([ADDRESS]);

    expect(provider.tronWeb).toBe(tronWeb);
    expect((tronWeb as { ready?: boolean }).ready).toBe(true);
  });

  it("clears ready when the host reports a disconnect", async () => {
    const { transport, tronLink } = install();
    const pending = tronLink.request({ method: "tron_requestAccounts" });
    transport.respond({ address: ADDRESS });
    await pending;

    transport.deliver({ kind: "event", family: "tron", event: "accountsChanged", data: [] });

    expect(tronLink.ready).toBe(false);
  });

  it("shares the tron install guard with the thin bridge", () => {
    install();
    const config = configFor(["tron"]);
    const second = installTronFull(bridgeFor(fakeTransport(DEFAULT_CHANNEL), config), config, {
      tronWeb: fakeTronWeb(),
    });

    expect(second).toBeNull();
  });
});
