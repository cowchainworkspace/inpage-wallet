/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInjectedWallet } from "../../src/inpage";
import { resetInstalls } from "../../src/inpage/core/guard";
import { DEFAULT_CHANNEL } from "../../src/protocol/envelope";
import { resetWindowListeners } from "./dom";
import { configFor, fakeTransport, IDENTITY, type FakeTransport } from "./fake-transport";

const ADDRESS = "So11111111111111111111111111111111111111112";

type StandardWallet = {
  name: string;
  icon: string;
  chains: readonly string[];
  accounts: readonly { address: string; publicKey: Uint8Array }[];
  features: Record<string, Record<string, unknown>>;
};

function register(): StandardWallet[] {
  const wallets: StandardWallet[] = [];
  window.addEventListener("wallet-standard:register-wallet", (e) => {
    const detail = (e as unknown as { detail: (api: { register(w: unknown): void }) => void })
      .detail;
    detail({ register: (w) => wallets.push(w as StandardWallet) });
  });
  return wallets;
}

function install(): { wallet: StandardWallet; transport: FakeTransport } {
  const wallets = register();
  const transport = fakeTransport(DEFAULT_CHANNEL);
  createInjectedWallet(transport, configFor(["solana"]));
  const wallet = wallets[0];
  if (!wallet) throw new Error("no wallet registered");
  return { wallet, transport };
}

beforeEach(() => {
  resetWindowListeners();
  resetInstalls();
});

describe("Solana injection", () => {
  it("registers over the Wallet Standard with the configured identity and chains", () => {
    const { wallet } = install();

    expect(wallet.name).toBe(IDENTITY.name);
    expect(wallet.chains).toEqual(["solana:mainnet"]);
    expect(Object.keys(wallet.features)).toEqual([
      "standard:connect",
      "standard:disconnect",
      "standard:events",
      "solana:signTransaction",
      "solana:signAndSendTransaction",
      "solana:signMessage",
    ]);
  });

  it("connects and exposes the account the host granted", async () => {
    const { wallet, transport } = install();
    const connect = wallet.features["standard:connect"] as {
      connect(i?: { silent?: boolean }): Promise<{ accounts: readonly { address: string }[] }>;
    };

    const pending = connect.connect({ silent: true });
    expect(transport.lastRequest()).toMatchObject({
      method: "solana_connect",
      params: [{ silent: true }],
    });

    transport.respond({ address: ADDRESS, publicKey: [1, 2, 3] });
    const out = await pending;

    expect(out.accounts[0]?.address).toBe(ADDRESS);
    expect(wallet.accounts[0]?.publicKey).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("carries transaction bytes as plain numbers and returns Uint8Array", async () => {
    const { wallet, transport } = install();
    const feature = wallet.features["solana:signTransaction"] as {
      signTransaction(i: {
        transaction: Uint8Array;
        account: { address: string };
      }): Promise<{ signedTransaction: Uint8Array }[]>;
    };

    const pending = feature.signTransaction({
      transaction: new Uint8Array([9, 8, 7]),
      account: { address: ADDRESS },
    });
    expect(transport.lastRequest().params).toEqual([{ tx: [9, 8, 7], account: ADDRESS }]);

    transport.respond({ signedTx: [4, 5] });
    await expect(pending).resolves.toEqual([{ signedTransaction: new Uint8Array([4, 5]) }]);
  });

  it("signs a message as bytes in both directions", async () => {
    const { wallet, transport } = install();
    const feature = wallet.features["solana:signMessage"] as {
      signMessage(i: {
        message: Uint8Array;
        account: { address: string };
      }): Promise<{ signedMessage: Uint8Array; signature: Uint8Array }[]>;
    };

    const pending = feature.signMessage({
      message: new Uint8Array([1]),
      account: { address: ADDRESS },
    });
    transport.respond({ signedMessage: [1], signature: [2, 3] });

    await expect(pending).resolves.toEqual([
      { signedMessage: new Uint8Array([1]), signature: new Uint8Array([2, 3]) },
    ]);
  });

  it("drops accounts when the host reports a disconnect", async () => {
    const { wallet, transport } = install();
    const connect = wallet.features["standard:connect"] as {
      connect(): Promise<unknown>;
    };
    const events = wallet.features["standard:events"] as {
      on(event: string, listener: (props: { accounts?: readonly unknown[] }) => void): () => void;
    };
    const onChange = vi.fn();
    events.on("change", onChange);

    const pending = connect.connect();
    transport.respond({ address: ADDRESS, publicKey: [] });
    await pending;

    transport.deliver({ kind: "event", family: "solana", event: "accountsChanged", data: [] });

    expect(wallet.accounts).toEqual([]);
    expect(onChange).toHaveBeenLastCalledWith({ accounts: [] });
  });

  it("is a no-op on a second injection", () => {
    const wallets = register();
    createInjectedWallet(fakeTransport(DEFAULT_CHANNEL), configFor(["solana"]));
    createInjectedWallet(fakeTransport(DEFAULT_CHANNEL), configFor(["solana"]));

    expect(wallets).toHaveLength(1);
  });
});
