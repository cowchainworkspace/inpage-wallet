/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInjectedWallet } from "../../src/inpage";
import { FALLBACK_ICON } from "../../src/inpage/core/config";
import { resetInstalls } from "../../src/inpage/core/guard";
import type { TronProvider } from "../../src/inpage/chains/tron";
import { DEFAULT_CHANNEL } from "../../src/protocol/envelope";
import { resetWindowListeners } from "./dom";
import { configFor, fakeTransport, IDENTITY, type FakeTransport } from "./fake-transport";

const ADDRESS = "TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE";

type TronLink = { ready: boolean; request(a: { method: string; params?: unknown }): Promise<unknown> };
type TronWindow = Window & { tron?: TronProvider; tronLink?: TronLink; tronWeb?: unknown };

type Announced = {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: TronProvider;
};

function announcements(): Announced[] {
  const seen: Announced[] = [];
  window.addEventListener("TIP6963:announceProvider", (event) => {
    seen.push((event as CustomEvent<Announced>).detail);
  });
  return seen;
}

function install(): { tronLink: TronLink; provider: TronProvider; transport: FakeTransport } {
  const transport = fakeTransport(DEFAULT_CHANNEL);
  createInjectedWallet(transport, configFor(["tron"]));
  const { tronLink, tron } = window as TronWindow;
  if (!tronLink) throw new Error("no tronLink installed");
  if (!tron) throw new Error("no window.tron installed");
  return { tronLink, provider: tron, transport };
}

beforeEach(() => {
  resetWindowListeners();
  resetInstalls();
  delete (window as TronWindow).tron;
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

describe("Tron multi-wallet discovery", () => {
  it("announces the configured identity with the provider on window.tron", () => {
    const seen = announcements();
    const { provider } = install();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.info).toEqual({
      uuid: IDENTITY.uuid,
      name: IDENTITY.name,
      icon: FALLBACK_ICON,
      rdns: IDENTITY.rdns,
    });
    expect(seen[0]?.provider).toBe(provider);
  });

  it("re-announces when a dApp asks and when the host sends its icon", () => {
    const seen = announcements();
    const { transport } = install();

    window.dispatchEvent(new Event("TIP6963:requestProvider"));
    transport.deliver({ kind: "init", icon: "data:image/png;base64,aa" });

    expect(seen).toHaveLength(3);
    expect(seen[2]?.info.icon).toBe("data:image/png;base64,aa");
  });

  it("leaves another wallet's window.tron in place", () => {
    const other = { request: () => Promise.resolve(null) };
    (window as unknown as { tron: unknown }).tron = other;

    createInjectedWallet(fakeTransport(DEFAULT_CHANNEL), configFor(["tron"]));

    expect((window as unknown as { tron: unknown }).tron).toBe(other);
  });
});

describe("Tron provider on window.tron", () => {
  it("authorizes with eth_requestAccounts over a tron_requestAccounts request", async () => {
    const { provider, tronLink, transport } = install();

    const pending = provider.request({ method: "eth_requestAccounts" });
    expect(transport.lastRequest()).toMatchObject({ method: "tron_requestAccounts", params: [{}] });
    transport.respond({ address: ADDRESS });

    await expect(pending).resolves.toEqual([ADDRESS]);
    expect(tronLink.ready).toBe(true);
  });

  it("rejects a refused authorization with a code the dApp can read", async () => {
    const { provider, transport } = install();

    const pending = provider.request({ method: "eth_requestAccounts" });
    transport.respond(null);

    await expect(pending).rejects.toMatchObject({ code: 4001 });
  });

  it("translates eth_accounts into the tron read", async () => {
    const { provider, transport } = install();

    const pending = provider.request({ method: "eth_accounts" });
    expect(transport.lastRequest().method).toBe("tron_accounts");
    transport.respond([ADDRESS]);

    await expect(pending).resolves.toEqual([ADDRESS]);
  });

  it("never forwards an untranslated eth_ or wallet_ method to the host", async () => {
    const { provider, transport } = install();

    for (const method of ["eth_chainId", "personal_sign", "wallet_switchEthereumChain"]) {
      await expect(provider.request({ method })).rejects.toMatchObject({ code: 4200 });
    }
    expect(transport.requests()).toHaveLength(0);
  });

  it("keeps tronWeb false with no instance to hand out", async () => {
    const { provider, transport } = install();

    expect(provider.tronWeb).toBe(false);
    const pending = provider.request({ method: "eth_requestAccounts" });
    transport.respond({ address: ADDRESS });
    await pending;

    expect(provider.tronWeb).toBe(false);
  });

  it("delivers the host's events to listeners until they are removed", () => {
    const { provider, transport } = install();
    const accounts: unknown[] = [];
    const chains: unknown[] = [];
    const onChain = (data: unknown): void => void chains.push(data);
    provider.on("accountsChanged", (data) => void accounts.push(data));
    provider.on("chainChanged", onChain);

    transport.deliver({ kind: "event", family: "tron", event: "accountsChanged", data: [ADDRESS] });
    transport.deliver({
      kind: "event",
      family: "tron",
      event: "chainChanged",
      data: { chainId: "0x2b6653dc" },
    });
    provider.removeListener("chainChanged", onChain);
    transport.deliver({
      kind: "event",
      family: "tron",
      event: "chainChanged",
      data: { chainId: "0x94a9059e" },
    });

    expect(accounts).toEqual([[ADDRESS]]);
    expect(chains).toEqual([{ chainId: "0x2b6653dc" }]);
  });

  it("takes the account the host announces as the authorized one", () => {
    const { tronLink, transport } = install();

    transport.deliver({ kind: "event", family: "tron", event: "accountsChanged", data: [ADDRESS] });

    expect(tronLink.ready).toBe(true);
  });
});
