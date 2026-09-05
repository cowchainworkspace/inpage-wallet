/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from "vitest";

import { createInjectedWallet } from "../../src/inpage";
import { resetInstalls } from "../../src/inpage/core/guard";
import { DEFAULT_CHANNEL } from "../../src/protocol/envelope";
import { resetWindowListeners } from "./dom";
import { configFor, fakeTransport, IDENTITY, type FakeTransport } from "./fake-transport";

type Cip30Api = {
  getUsedAddresses(): Promise<string[]>;
  signTx(tx: string, partialSign?: boolean): Promise<string>;
  signData(address: string, payload: string): Promise<unknown>;
};

type Cip30Wallet = {
  apiVersion: string;
  name: string;
  icon: string;
  isEnabled(): Promise<boolean>;
  enable(): Promise<Cip30Api>;
};

type CardanoWindow = Window & { cardano?: Record<string, Cip30Wallet> };

const KEY = "examplewallet";

function install(): { wallet: Cip30Wallet; transport: FakeTransport } {
  const transport = fakeTransport(DEFAULT_CHANNEL);
  createInjectedWallet(transport, configFor(["cardano"]));
  const wallet = (window as CardanoWindow).cardano?.[KEY];
  if (!wallet) throw new Error("no CIP-30 wallet registered");
  return { wallet, transport };
}

beforeEach(() => {
  resetWindowListeners();
  resetInstalls();
  delete (window as CardanoWindow).cardano;
});

describe("Cardano injection", () => {
  it("registers under a key derived from the identity name", () => {
    const { wallet } = install();

    expect(wallet.name).toBe(IDENTITY.name);
    expect(wallet.apiVersion).toBe("1.0.0");
  });

  it("honours an explicit window.cardano key", () => {
    createInjectedWallet(fakeTransport(DEFAULT_CHANNEL), {
      ...configFor(["cardano"]),
      cardanoWalletKey: "mywallet",
    });

    expect((window as CardanoWindow).cardano?.mywallet).toBeDefined();
  });

  it("resolves enable() to the full API and reuses it", async () => {
    const { wallet, transport } = install();

    const pending = wallet.enable();
    expect(transport.lastRequest().method).toBe("cardano_enable");
    transport.respond({ networkId: 1 });
    const api = await pending;

    expect(typeof api.signTx).toBe("function");
    expect(await wallet.enable()).toBe(api);
  });

  it("rejects enable() with the CIP-30 refusal code", async () => {
    const { wallet, transport } = install();

    const pending = wallet.enable();
    transport.respond(null);

    await expect(pending).rejects.toMatchObject({ code: -3, message: "User declined" });
  });

  it("bridges signTx and signData with CIP-30 arguments", async () => {
    const { wallet, transport } = install();
    const pending = wallet.enable();
    transport.respond({ networkId: 1 });
    const api = await pending;

    void api.signTx("84a4", true);
    expect(transport.lastRequest()).toMatchObject({
      method: "cardano_signTx",
      params: [{ tx: "84a4", partialSign: true }],
    });
    transport.respond("signed");

    void api.signData("addr", "payload");
    expect(transport.lastRequest()).toMatchObject({
      method: "cardano_signData",
      params: [{ address: "addr", payload: "payload" }],
    });
    transport.respond({ signature: "s", key: "k" });
  });

  it("drops the enabled state when the host reports a disconnect", async () => {
    const { wallet, transport } = install();
    const pending = wallet.enable();
    transport.respond({ networkId: 1 });
    await pending;

    transport.deliver({ kind: "event", family: "cardano", event: "accountsChanged", data: [] });

    const again = wallet.enable();
    expect(transport.lastRequest().method).toBe("cardano_enable");
    transport.respond({ networkId: 1 });
    await again;
  });

  it("is a no-op on a second injection", () => {
    const { wallet } = install();
    createInjectedWallet(fakeTransport(DEFAULT_CHANNEL), configFor(["cardano"]));

    expect((window as CardanoWindow).cardano?.[KEY]).toBe(wallet);
  });
});
