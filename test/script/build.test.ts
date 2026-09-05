/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildDeliveryScript, buildInjectedScript } from "../../src/script/build";
import { DEFAULT_CHANNEL, hostToPage } from "../../src/protocol/envelope";
import { resetWindowListeners } from "../inpage/dom";
import { configFor, IDENTITY } from "../inpage/fake-transport";

type Announced = { info: { rdns: string; uuid: string } };

type RnWindow = Window & {
  ReactNativeWebView?: { postMessage: (data: string) => void };
  __inpageWalletBridge?: boolean;
  __inpageWalletInstalled?: Record<string, boolean>;
};

function run(script: string): void {
  new Function(script).call(window);
}

const rn = window as RnWindow;

beforeEach(() => {
  resetWindowListeners();
  rn.__inpageWalletBridge = false;
  rn.__inpageWalletInstalled = {};
});

describe("buildInjectedScript", () => {
  it("produces script the page can execute", () => {
    expect(() => new Function(buildInjectedScript(configFor(["evm"])))).not.toThrow();
  });

  it("carries no brand from the codebases it was extracted from", () => {
    const script = buildInjectedScript(configFor(["evm"])).toLowerCase();

    expect(script).not.toContain("trustodian");
    expect(script).not.toContain("afridax");
  });

  it("embeds the host's identity and networks", () => {
    const script = buildInjectedScript(configFor(["evm"]));

    expect(script).toContain(IDENTITY.rdns);
    expect(script).toContain(IDENTITY.uuid);
    expect(script).toContain("0x1");
  });

  it("injects only the families the host registered", () => {
    const script = buildInjectedScript(configFor(["evm"]));

    expect(script).toContain("eip6963:announceProvider");
    expect(script).not.toContain("wallet-standard:register-wallet");
  });

  it("announces over EIP-6963 and posts through the captured bridge", () => {
    const postMessage = vi.fn();
    rn.ReactNativeWebView = { postMessage };
    const announced: Announced[] = [];
    window.addEventListener("eip6963:announceProvider", (e) => {
      announced.push((e as CustomEvent<Announced>).detail);
    });

    run(buildInjectedScript(configFor(["evm"])));

    expect(announced).toHaveLength(1);
    expect(announced[0]?.info.rdns).toBe(IDENTITY.rdns);
    expect(JSON.parse(postMessage.mock.calls[0]?.[0] as string)).toEqual({
      channel: DEFAULT_CHANNEL,
      direction: "page-to-host",
      kind: "ready",
      families: ["evm"],
    });
  });

  it("round-trips a request through the delivery script", async () => {
    const postMessage = vi.fn();
    rn.ReactNativeWebView = { postMessage };
    const announced: (Announced & {
      provider: { request(a: { method: string }): Promise<unknown> };
    })[] = [];
    window.addEventListener("eip6963:announceProvider", (e) => {
      announced.push((e as CustomEvent).detail);
    });

    run(buildInjectedScript(configFor(["evm"])));

    const pending = announced[0]?.provider.request({ method: "eth_accounts" });
    const sent = JSON.parse(postMessage.mock.calls[1]?.[0] as string) as { id: string };

    run(
      buildDeliveryScript(
        hostToPage(DEFAULT_CHANNEL, { kind: "response", id: sent.id, result: ["0xabc"] }),
      ),
    );

    await expect(pending).resolves.toEqual(["0xabc"]);
  });

  it("is idempotent: a second injection installs nothing new", () => {
    rn.ReactNativeWebView = { postMessage: vi.fn() };
    const announced: Announced[] = [];
    window.addEventListener("eip6963:announceProvider", (e) => {
      announced.push((e as CustomEvent<Announced>).detail);
    });

    const script = buildInjectedScript(configFor(["evm"]));
    run(script);
    run(script);

    expect(announced).toHaveLength(1);
  });
});

describe("buildDeliveryScript", () => {
  it("ends in a truthy expression so a WebView does not report an error", () => {
    const script = buildDeliveryScript(hostToPage(DEFAULT_CHANNEL, { kind: "init", icon: "x" }));

    expect(script.trim().endsWith("true;")).toBe(true);
  });
});
