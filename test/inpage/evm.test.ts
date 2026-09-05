/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInjectedWallet } from "../../src/inpage";
import { resetInstalls } from "../../src/inpage/core/guard";
import { DEFAULT_CHANNEL } from "../../src/protocol/envelope";
import { resetWindowListeners } from "./dom";
import { configFor, fakeTransport, IDENTITY } from "./fake-transport";

type Announced = {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: {
    request(args: { method: string; params?: unknown }): Promise<unknown>;
    on(event: string, listener: (data: unknown) => void): unknown;
    removeListener(event: string, listener: (data: unknown) => void): unknown;
    chainId: string | null;
  };
};

function collectAnnouncements(): Announced[] {
  const seen: Announced[] = [];
  window.addEventListener("eip6963:announceProvider", (e) => {
    seen.push((e as CustomEvent<Announced>).detail);
  });
  return seen;
}

beforeEach(() => {
  resetWindowListeners();
  resetInstalls();
});

describe("EVM injection", () => {
  it("announces the configured identity over EIP-6963", () => {
    const seen = collectAnnouncements();
    createInjectedWallet(fakeTransport(DEFAULT_CHANNEL), configFor(["evm"]));

    expect(seen).toHaveLength(1);
    expect(seen[0]?.info).toMatchObject({
      uuid: IDENTITY.uuid,
      name: IDENTITY.name,
      rdns: IDENTITY.rdns,
    });
    expect(seen[0]?.info.icon.startsWith("data:image/svg+xml")).toBe(true);
  });

  it("re-announces when a dApp asks for providers", () => {
    const seen = collectAnnouncements();
    createInjectedWallet(fakeTransport(DEFAULT_CHANNEL), configFor(["evm"]));
    window.dispatchEvent(new Event("eip6963:requestProvider"));

    expect(seen).toHaveLength(2);
  });

  it("sends ready with the families it injected", () => {
    const transport = fakeTransport(DEFAULT_CHANNEL);
    createInjectedWallet(transport, configFor(["evm"]));

    expect(transport.sent).toEqual([
      { channel: DEFAULT_CHANNEL, direction: "page-to-host", kind: "ready", families: ["evm"] },
    ]);
  });

  it("round-trips request() through the transport and resolves on response", async () => {
    const seen = collectAnnouncements();
    const transport = fakeTransport(DEFAULT_CHANNEL);
    createInjectedWallet(transport, configFor(["evm"]));

    const pending = seen[0]?.provider.request({ method: "eth_accounts" });
    expect(transport.lastRequest().method).toBe("eth_accounts");

    transport.respond(["0xabc"]);
    await expect(pending).resolves.toEqual(["0xabc"]);
  });

  it("rejects with the RPC code the host returned", async () => {
    const seen = collectAnnouncements();
    const transport = fakeTransport(DEFAULT_CHANNEL);
    createInjectedWallet(transport, configFor(["evm"]));

    const pending = seen[0]?.provider.request({ method: "personal_sign", params: [] });
    transport.fail({ code: 4001, message: "User rejected the request" });

    await expect(pending).rejects.toMatchObject({ code: 4001, message: "User rejected the request" });
  });

  it("rejects an invalid request without touching the transport", async () => {
    const seen = collectAnnouncements();
    const transport = fakeTransport(DEFAULT_CHANNEL);
    createInjectedWallet(transport, configFor(["evm"]));

    await expect(
      seen[0]?.provider.request({ method: undefined as unknown as string }),
    ).rejects.toMatchObject({ code: -32602 });
    expect(transport.requests()).toHaveLength(0);
  });

  it("delivers host events to provider listeners and tracks chainChanged", () => {
    const seen = collectAnnouncements();
    const transport = fakeTransport(DEFAULT_CHANNEL);
    createInjectedWallet(transport, configFor(["evm"]));
    const provider = seen[0]?.provider;

    const onAccounts = vi.fn();
    provider?.on("accountsChanged", onAccounts);
    transport.deliver({ kind: "event", family: "evm", event: "accountsChanged", data: ["0x1"] });
    expect(onAccounts).toHaveBeenCalledWith(["0x1"]);

    expect(provider?.chainId).toBe("0x1");
    transport.deliver({ kind: "event", family: "evm", event: "chainChanged", data: "0x89" });
    expect(provider?.chainId).toBe("0x89");

    provider?.removeListener("accountsChanged", onAccounts);
    transport.deliver({ kind: "event", family: "evm", event: "accountsChanged", data: [] });
    expect(onAccounts).toHaveBeenCalledTimes(1);
  });

  it("ignores events addressed to another family", () => {
    const seen = collectAnnouncements();
    const transport = fakeTransport(DEFAULT_CHANNEL);
    createInjectedWallet(transport, configFor(["evm"]));

    const onAccounts = vi.fn();
    seen[0]?.provider.on("accountsChanged", onAccounts);
    transport.deliver({ kind: "event", family: "solana", event: "accountsChanged", data: [] });

    expect(onAccounts).not.toHaveBeenCalled();
  });

  it("re-announces with the host icon but ignores an empty one", () => {
    const seen = collectAnnouncements();
    const transport = fakeTransport(DEFAULT_CHANNEL);
    createInjectedWallet(transport, configFor(["evm"]));

    transport.deliver({ kind: "init", icon: "" });
    expect(seen).toHaveLength(1);

    transport.deliver({ kind: "init", icon: "data:image/png;base64,AAA" });
    expect(seen).toHaveLength(2);
    expect(seen[1]?.info.icon).toBe("data:image/png;base64,AAA");
  });

  it("leaves window.ethereum alone unless the host opts in", () => {
    createInjectedWallet(fakeTransport(DEFAULT_CHANNEL), configFor(["evm"]));
    expect((window as { ethereum?: unknown }).ethereum).toBeUndefined();

    resetInstalls();
    createInjectedWallet(fakeTransport(DEFAULT_CHANNEL), {
      ...configFor(["evm"]),
      legacyGlobals: { ethereum: true },
    });
    expect((window as { ethereum?: unknown }).ethereum).toBeDefined();
  });

  it("is a no-op on a second injection", () => {
    const seen = collectAnnouncements();
    const transport = fakeTransport(DEFAULT_CHANNEL);
    createInjectedWallet(transport, configFor(["evm"]));
    createInjectedWallet(fakeTransport(DEFAULT_CHANNEL), configFor(["evm"]));

    expect(seen).toHaveLength(1);
  });

  it("drops envelopes from another channel", async () => {
    const seen = collectAnnouncements();
    const transport = fakeTransport("someone-elses-channel");
    createInjectedWallet(transport, configFor(["evm"]));

    const pending = seen[0]?.provider.request({ method: "eth_accounts" });
    transport.respond(["0xabc"]);

    const settled = await Promise.race([pending, Promise.resolve("still-pending")]);
    expect(settled).toBe("still-pending");
  });
});
