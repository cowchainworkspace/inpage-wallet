/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInjectedWallet } from "../../src/inpage";
import { resetInstalls } from "../../src/inpage/core/guard";
import { DEFAULT_CHANNEL } from "../../src/protocol/envelope";
import { resetWindowListeners } from "./dom";
import { configFor, fakeTransport, IDENTITY, type FakeTransport } from "./fake-transport";

const ADDRESS = "rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH";

type Crossmark = {
  signIn(): Promise<{ address: string }>;
  getAddress(): Promise<string>;
  sign(tx: Record<string, unknown>): Promise<unknown>;
  signOut(): Promise<null>;
  on(event: string, cb: (data: unknown) => void): void;
  request(input: { command: string; data?: unknown }): Promise<unknown>;
};

type StandardWallet = {
  name: string;
  chains: readonly string[];
  accounts: readonly { address: string }[];
  features: Record<string, Record<string, unknown>>;
};

type XrpWindow = Window & { crossmark?: Crossmark };

function install(): {
  crossmark: Crossmark;
  wallet: StandardWallet;
  transport: FakeTransport;
} {
  const wallets: StandardWallet[] = [];
  window.addEventListener("wallet-standard:register-wallet", (e) => {
    const detail = (e as unknown as { detail: (api: { register(w: unknown): void }) => void })
      .detail;
    detail({ register: (w) => wallets.push(w as StandardWallet) });
  });

  const transport = fakeTransport(DEFAULT_CHANNEL);
  createInjectedWallet(transport, configFor(["xrp"]));

  const crossmark = (window as XrpWindow).crossmark;
  const wallet = wallets[0];
  if (!crossmark || !wallet) throw new Error("XRP providers were not installed");
  return { crossmark, wallet, transport };
}

beforeEach(() => {
  resetWindowListeners();
  resetInstalls();
  delete (window as XrpWindow).crossmark;
});

describe("XRPL injection", () => {
  it("installs both discovery surfaces from one family", () => {
    const { wallet } = install();

    expect((window as XrpWindow).crossmark).toBeDefined();
    expect(wallet.name).toBe(IDENTITY.name);
    expect(wallet.chains).toEqual(["xrpl:0"]);
    expect(Object.keys(wallet.features)).toContain("xrpl:signAndSubmitTransaction");
  });

  it("signs in and caches the address for getAddress", async () => {
    const { crossmark, transport } = install();

    const pending = crossmark.signIn();
    expect(transport.lastRequest().method).toBe("xrpl_requestAccounts");
    transport.respond({ address: ADDRESS });

    await expect(pending).resolves.toEqual({ address: ADDRESS });
    await expect(crossmark.getAddress()).resolves.toBe(ADDRESS);
    expect(transport.requests()).toHaveLength(1);
  });

  it("rejects a refused sign-in with 4001", async () => {
    const { crossmark, transport } = install();

    const pending = crossmark.signIn();
    transport.respond(null);

    await expect(pending).rejects.toMatchObject({ code: 4001 });
  });

  it("routes the Crossmark-style command surface", async () => {
    const { crossmark, transport } = install();

    void crossmark.request({ command: "sign", data: { tx_json: { TransactionType: "Payment" } } });
    expect(transport.lastRequest()).toMatchObject({
      method: "xrpl_signTransaction",
      params: [{ tx_json: { TransactionType: "Payment" }, submit: false }],
    });
    transport.respond({ tx_blob: "blob", hash: "hash" });

    await expect(crossmark.request({ command: "nonsense" })).rejects.toMatchObject({ code: 4200 });
  });

  it("reshapes signTransaction for the Wallet Standard feature", async () => {
    const { wallet, transport } = install();
    const feature = wallet.features["xrpl:signTransaction"] as {
      signTransaction(i: { tx_json: Record<string, unknown> }): Promise<{ signed_tx_blob: string }>;
    };

    const pending = feature.signTransaction({ tx_json: { TransactionType: "Payment" } });
    transport.respond({ tx_blob: "blob", hash: "hash" });

    await expect(pending).resolves.toEqual({ signed_tx_blob: "blob" });
  });

  it("clears both surfaces when the host reports a disconnect", async () => {
    const { crossmark, wallet, transport } = install();
    const onSignout = vi.fn();
    crossmark.on("signout", onSignout);

    const connect = wallet.features["standard:connect"] as { connect(): Promise<unknown> };
    const pending = connect.connect();
    transport.respond({ address: ADDRESS });
    await pending;

    transport.deliver({ kind: "event", family: "xrp", event: "accountsChanged", data: [] });

    expect(onSignout).toHaveBeenCalled();
    expect(wallet.accounts).toEqual([]);
  });

  it("is a no-op on a second injection", () => {
    const { crossmark } = install();
    createInjectedWallet(fakeTransport(DEFAULT_CHANNEL), configFor(["xrp"]));

    expect((window as XrpWindow).crossmark).toBe(crossmark);
  });
});
