/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";

import { buildDeliveryScript, buildInjectedScript, buildPreamble } from "../../src/script/build";
import { DEFAULT_CHANNEL, hostToPage } from "../../src/protocol/envelope";
import type { InjectedConfig } from "../../src/inpage/core/config";
import { configFor, IDENTITY } from "../inpage/fake-transport";

const NONCE = "8f1c0b3a-5d2e-4a67-9b81-0c1d2e3f4a5b";
const FULL_HOST = "https://tron.node.test";

type Announced = {
  info: { rdns: string; uuid: string };
  provider: { request(a: { method: string }): Promise<unknown> };
};

type RnWindow = Window & {
  ReactNativeWebView?: { postMessage: (data: string) => void };
  __inpageWalletConfig?: { identity: { rdns: string } };
  __inpageWalletPost?: (env: unknown) => void;
  __inpageWalletDeliver?: Record<string, (env: unknown) => void>;
  eval(script: string): unknown;
};

type StandardWallet = {
  chains: readonly string[];
  features: Record<string, { connect?(i?: { silent?: boolean }): Promise<unknown> }>;
};

type Page = {
  win: RnWindow;
  posted: string[];
  announced: Announced[];
  wallets: StandardWallet[];
};

/**
 * The preamble locks its globals to the document it ran in, so each case gets a
 * document of its own — which is also the only shape a real page ever sees.
 */
function freshPage(): Page {
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  const win = frame.contentWindow as RnWindow | null;
  if (!win) throw new Error("the iframe has no window");

  const posted: string[] = [];
  const announced: Announced[] = [];
  const wallets: StandardWallet[] = [];
  win.ReactNativeWebView = { postMessage: (data: string) => void posted.push(data) };
  win.addEventListener("eip6963:announceProvider", (event) => {
    announced.push((event as CustomEvent<Announced>).detail);
  });
  win.addEventListener("wallet-standard:register-wallet", (event) => {
    const detail = (event as unknown as { detail: (api: { register(w: unknown): void }) => void })
      .detail;
    detail({ register: (w) => void wallets.push(w as StandardWallet) });
  });
  return { win, posted, announced, wallets };
}

/** Every request envelope the page posted, in order. */
function requests(posted: string[]): Record<string, unknown>[] {
  return posted
    .map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .filter((env) => env.kind === "request");
}

function frozenConfigLiteral(script: string): string {
  const start = script.indexOf("Object.freeze(");
  const end = script.indexOf("));", start);
  if (start < 0 || end < 0) throw new Error("no frozen config in the preamble");
  return script.slice(start, end);
}

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
    const page = freshPage();

    page.win.eval(buildInjectedScript(configFor(["evm"])));

    expect(page.announced).toHaveLength(1);
    expect(page.announced[0]?.info.rdns).toBe(IDENTITY.rdns);
    expect(JSON.parse(page.posted[0] ?? "null")).toMatchObject({
      channel: DEFAULT_CHANNEL,
      direction: "page-to-host",
      kind: "ready",
      families: ["evm"],
    });
  });

  it("round-trips a request through the delivery script", async () => {
    const page = freshPage();
    page.win.eval(buildInjectedScript(configFor(["evm"])));

    const pending = page.announced[0]?.provider.request({ method: "eth_accounts" });
    const sent = JSON.parse(page.posted[1] ?? "null") as { id: string };

    page.win.eval(
      buildDeliveryScript(
        hostToPage(DEFAULT_CHANNEL, { kind: "response", id: sent.id, result: ["0xabc"] }),
      ),
    );

    await expect(pending).resolves.toEqual(["0xabc"]);
  });

  it("is idempotent: a second injection installs nothing new", () => {
    const page = freshPage();
    const script = buildInjectedScript(configFor(["evm"]));

    page.win.eval(script);
    page.win.eval(script);

    expect(page.announced).toHaveLength(1);
  });
});

describe("buildInjectedScript with more than one family", () => {
  for (const order of [
    ["evm", "solana"],
    ["solana", "evm"],
  ] as const) {
    it(`keeps every family's envelopes well formed: ${order.join(", ")}`, async () => {
      const page = freshPage();
      page.win.eval(buildInjectedScript(configFor([...order])));

      const solana = page.wallets.find((w) => w.chains.some((c) => c.startsWith("solana:")));
      const evm = page.announced[0]?.provider;
      expect(solana, "no Solana wallet was registered").toBeDefined();
      expect(evm, "no EVM provider was announced").toBeDefined();

      void evm?.request({ method: "eth_chainId" });
      void solana?.features["standard:connect"]?.connect?.({ silent: true });
      await new Promise<void>((resolve) => void setTimeout(resolve, 0));

      const sent = requests(page.posted);
      expect(sent.map((env) => env.method)).toEqual(["eth_chainId", "solana_connect"]);
      for (const env of sent) {
        expect(env).toMatchObject({
          channel: DEFAULT_CHANNEL,
          direction: "page-to-host",
          kind: "request",
        });
        expect(typeof env.id).toBe("string");
      }
    });
  }

  it("announces a ready envelope for each family", () => {
    const page = freshPage();

    page.win.eval(buildInjectedScript(configFor(["evm", "solana"])));

    const ready = page.posted
      .map((raw) => JSON.parse(raw) as { kind: string; families?: string[] })
      .filter((env) => env.kind === "ready")
      .flatMap((env) => env.families ?? []);
    expect(ready.sort()).toEqual(["evm", "solana"]);
  });
});

describe("buildInjectedScript prelude", () => {
  const stub = `(function () {
    function Stub(options) { this.fullHost = options.fullHost; this.trx = {}; }
    Stub.prototype.setAddress = function () {};
    window.__preludeSawConfig = typeof window.__inpageWalletConfig;
    window.TronWeb = { TronWeb: Stub };
  })();`;

  function tronConfig(): InjectedConfig {
    const base = configFor(["tron"]);
    const [network] = base.networks;
    if (!network) throw new Error("no tron fixture network");
    return {
      ...base,
      networks: [{ ...network, wire: { tronFullHost: FULL_HOST } }],
      legacyGlobals: { tronWeb: true },
    };
  }

  it("runs before the preamble, so a bundle sees what it defined", () => {
    const { win } = freshPage();

    win.eval(buildInjectedScript(tronConfig(), { prelude: [stub] }));

    const w = win as RnWindow & { __preludeSawConfig?: string; tronWeb?: { fullHost?: string } };
    expect(w.__preludeSawConfig).toBe("undefined");
    expect(w.tronWeb?.fullHost).toBe(FULL_HOST);
  });

  it("keeps a prelude's top-level declarations out of the bundles' scope", () => {
    const { win } = freshPage();

    const script = buildInjectedScript(configFor(["evm"]), {
      prelude: ["var announce = 1;", "var announce = 2;"],
    });

    expect(() => win.eval(script)).not.toThrow();
  });

  it("adds nothing when no prelude is given", () => {
    expect(buildInjectedScript(configFor(["evm"]), {})).toBe(buildInjectedScript(configFor(["evm"])));
  });
});

describe("buildDeliveryScript", () => {
  it("ends in a truthy expression so a WebView does not report an error", () => {
    const script = buildDeliveryScript(hostToPage(DEFAULT_CHANNEL, { kind: "init", icon: "x" }));

    expect(script.trim().endsWith("true;")).toBe(true);
  });

  it("escapes the line separators JSON allows but JavaScript does not", () => {
    const script = buildDeliveryScript(
      hostToPage(DEFAULT_CHANNEL, { kind: "init", icon: "a\u2028b\u2029c" }),
    );

    expect(script).not.toMatch(/[\u2028\u2029]/);
    expect(() => new Function(script)).not.toThrow();
  });

  it("is ignored by a document injected with a different nonce", () => {
    const { win } = freshPage();
    win.eval(buildInjectedScript({ ...configFor(["evm"]), nonce: NONCE }));
    const seen: unknown[] = [];
    win.__inpageWalletDeliver = { probe: (env: unknown) => void seen.push(env) };
    const env = hostToPage(DEFAULT_CHANNEL, { kind: "init", icon: "data:x" });

    win.eval(buildDeliveryScript(env, "the-previous-document"));
    expect(seen).toEqual([]);

    win.eval(buildDeliveryScript(env, NONCE));
    expect(seen).toEqual([env]);
  });
});

describe("preamble nonce", () => {
  it("keeps the nonce out of the config the page can read", () => {
    const script = buildPreamble({ ...configFor(["evm"]), nonce: NONCE });

    expect(frozenConfigLiteral(script)).not.toContain(NONCE);
    expect(script).toContain(NONCE);
  });

  it("leaves no nonce on the config global at runtime", () => {
    const { win } = freshPage();

    win.eval(buildPreamble({ ...configFor(["evm"]), nonce: NONCE }));

    expect(win.__inpageWalletConfig).toBeDefined();
    expect(JSON.stringify(win.__inpageWalletConfig)).not.toContain(NONCE);
  });

  it("stamps the nonce on every envelope it posts", () => {
    const { win, posted } = freshPage();

    win.eval(buildPreamble({ ...configFor(["evm"]), nonce: NONCE }));
    win.__inpageWalletPost?.({ channel: DEFAULT_CHANNEL, direction: "page-to-host", kind: "ready" });

    expect(JSON.parse(posted[0] ?? "null")).toMatchObject({ kind: "ready", n: NONCE });
  });

  it("posts a null stamp when the host configured no nonce", () => {
    const { win, posted } = freshPage();

    win.eval(buildPreamble(configFor(["evm"])));
    win.__inpageWalletPost?.({ channel: DEFAULT_CHANNEL, direction: "page-to-host", kind: "ready" });

    expect(JSON.parse(posted[0] ?? "null").n).toBeNull();
  });

  it("locks its globals against a page script that runs later", () => {
    const { win } = freshPage();

    win.eval(buildPreamble({ ...configFor(["evm"]), nonce: NONCE }));
    const original = win.__inpageWalletPost;
    win.eval("try { window.__inpageWalletPost = function () {}; } catch (e) {}");

    expect(win.__inpageWalletPost).toBe(original);
  });

  it("keeps its own config when a page pre-sets the install guard", () => {
    const { win } = freshPage();

    win.eval("window.__inpageWalletBridge = true; window.__inpageWalletConfig = { identity: {} };");
    win.eval(buildPreamble({ ...configFor(["evm"]), nonce: NONCE }));

    expect(win.__inpageWalletConfig?.identity.rdns).toBe(IDENTITY.rdns);
  });
});
