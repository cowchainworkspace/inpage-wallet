/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from "vitest";

import { createInjectedWallet } from "../../src/inpage";
import { resetInstalls } from "../../src/inpage/core/guard";
import { DEFAULT_CHANNEL } from "../../src/protocol/envelope";
import { resetWindowListeners } from "./dom";
import { configFor, fakeTransport, IDENTITY, type FakeTransport } from "./fake-transport";

const ADDRESS = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";

type StandardWallet = {
  name: string;
  chains: readonly string[];
  accounts: readonly { address: string; publicKey: Uint8Array; addressType: string }[];
  features: Record<string, Record<string, unknown>>;
};

function install(): { wallet: StandardWallet; transport: FakeTransport } {
  const wallets: StandardWallet[] = [];
  window.addEventListener("wallet-standard:register-wallet", (e) => {
    const detail = (e as unknown as { detail: (api: { register(w: unknown): void }) => void })
      .detail;
    detail({ register: (w) => wallets.push(w as StandardWallet) });
  });

  const transport = fakeTransport(DEFAULT_CHANNEL);
  createInjectedWallet(transport, configFor(["btc"]));
  const wallet = wallets[0];
  if (!wallet) throw new Error("no BTC wallet registered");
  return { wallet, transport };
}

beforeEach(() => {
  resetWindowListeners();
  resetInstalls();
});

describe("Bitcoin injection", () => {
  it("registers the Bitcoin Wallet Standard feature set", () => {
    const { wallet } = install();

    expect(wallet.name).toBe(IDENTITY.name);
    expect(wallet.chains).toEqual(["bitcoin:mainnet"]);
    expect(Object.keys(wallet.features)).toEqual([
      "standard:events",
      "bitcoin:connect",
      "bitcoin:signMessage",
      "bitcoin:signTransaction",
    ]);
  });

  it("connects and carries the public key as bytes", async () => {
    const { wallet, transport } = install();
    const feature = wallet.features["bitcoin:connect"] as { connect(): Promise<unknown> };

    const pending = feature.connect();
    expect(transport.lastRequest().method).toBe("btc_requestAccounts");
    transport.respond({ address: ADDRESS, publicKey: [2, 3], addressType: "p2wpkh" });
    await pending;

    expect(wallet.accounts[0]).toMatchObject({
      address: ADDRESS,
      publicKey: new Uint8Array([2, 3]),
      addressType: "p2wpkh",
    });
  });

  it("moves PSBTs as base64 and returns bytes", async () => {
    const { wallet, transport } = install();
    const feature = wallet.features["bitcoin:signTransaction"] as {
      signTransaction(i: { psbt: Uint8Array }): Promise<{ signedPsbt: Uint8Array }[]>;
    };

    const pending = feature.signTransaction({ psbt: new Uint8Array([112, 115]) });
    expect(transport.lastRequest().params).toEqual([{ psbt: btoa("ps") }]);

    transport.respond(btoa("ok"));
    await expect(pending).resolves.toEqual([{ signedPsbt: new Uint8Array([111, 107]) }]);
  });

  it("signs a message decoded from bytes", async () => {
    const { wallet, transport } = install();
    const feature = wallet.features["bitcoin:signMessage"] as {
      signMessage(i: { message: Uint8Array }): Promise<{ signature: Uint8Array }[]>;
    };

    const pending = feature.signMessage({ message: new TextEncoder().encode("hi") });
    expect(transport.lastRequest().params).toEqual([{ message: "hi" }]);

    transport.respond(btoa("sig"));
    const [out] = await pending;
    expect(Array.from(out?.signature ?? [])).toEqual([115, 105, 103]);
  });

  it("drops accounts when the host reports a disconnect", async () => {
    const { wallet, transport } = install();
    const feature = wallet.features["bitcoin:connect"] as { connect(): Promise<unknown> };
    const pending = feature.connect();
    transport.respond({ address: ADDRESS });
    await pending;

    transport.deliver({ kind: "event", family: "btc", event: "accountsChanged", data: [] });

    expect(wallet.accounts).toEqual([]);
  });

  it("is a no-op on a second injection", () => {
    const wallets: unknown[] = [];
    window.addEventListener("wallet-standard:register-wallet", (e) => {
      (e as unknown as { detail: (api: { register(w: unknown): void }) => void }).detail({
        register: (w) => wallets.push(w),
      });
    });

    createInjectedWallet(fakeTransport(DEFAULT_CHANNEL), configFor(["btc"]));
    createInjectedWallet(fakeTransport(DEFAULT_CHANNEL), configFor(["btc"]));

    expect(wallets).toHaveLength(1);
  });
});
