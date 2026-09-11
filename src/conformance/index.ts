import { cardanoWalletKey } from "../inpage/chains/cardano";
import type { InjectedConfig } from "../inpage/core/config";
import { DEFAULT_CHANNEL, hostToPage, type HostToPage } from "../protocol/envelope";
import { isChainFamily, type ChainFamily, type NetworkDef } from "../protocol/networks";
import { buildPreamble } from "../script/build";
import { RN_RECEIVE } from "../transports/rn-webview";

export type ConformanceExpect = {
  identity: { name: string; rdns: string; uuid: string };
  families: ChainFamily[];
  channel?: string | undefined;
  cardanoWalletKey?: string | undefined;
};

export type ConformanceCheck = {
  name: string;
  family?: ChainFamily | undefined;
  ok: boolean;
  detail?: string | undefined;
};

export type ConformanceReport = { ok: boolean; checks: ConformanceCheck[] };

/** A well-formed base58 address, so a host-side check on the answer can pass. */
const TRON_ADDRESS = "TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE";

/** One network per family, just enough for `bootstrap()` to install each chain. */
const SAMPLE_NETWORK: Record<ChainFamily, NetworkDef> = {
  evm: { id: "1", family: "evm", name: "Ethereum", wire: { evmChainId: "0x1" } },
  solana: {
    id: "solana-mainnet",
    family: "solana",
    name: "Solana",
    wire: { walletStandardChain: "solana:mainnet" },
  },
  cardano: { id: "cardano-mainnet", family: "cardano", name: "Cardano", wire: { cardanoNetworkId: 1 } },
  tron: { id: "tron-mainnet", family: "tron", name: "Tron", wire: {} },
  xrp: { id: "xrpl-mainnet", family: "xrp", name: "XRPL", wire: { walletStandardChain: "xrpl:0" } },
  btc: {
    id: "bitcoin-mainnet",
    family: "btc",
    name: "Bitcoin",
    wire: { walletStandardChain: "bitcoin:mainnet" },
  },
};

/** Wallet Standard registration keyed by the chain-id prefix each family uses. */
const WALLET_STANDARD_SPEC: Record<
  "solana" | "btc" | "xrp",
  { chainPrefix: string; connectFeature: string; eventsFeature: string }
> = {
  solana: { chainPrefix: "solana:", connectFeature: "standard:connect", eventsFeature: "standard:events" },
  xrp: { chainPrefix: "xrpl:", connectFeature: "standard:connect", eventsFeature: "standard:events" },
  btc: { chainPrefix: "bitcoin:", connectFeature: "bitcoin:connect", eventsFeature: "standard:events" },
};

type Announced = { info: { name: string; rdns: string; uuid: string }; provider: unknown };
type TronProviderLike = {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
};
type RegisteredWallet = {
  name: string;
  chains?: readonly string[];
  features?: Record<string, { connect?: (input?: { silent?: boolean }) => Promise<unknown>; on?: (event: string, cb: (data: unknown) => void) => void }>;
};

/**
 * Evaluates an already-built injected bundle inside a caller-supplied window and
 * checks it still speaks the protocol: discovery, the `ready` handshake, one
 * request round-trip and one event per family, and that a second evaluation does
 * not install anything twice. Throws only when `source` itself is broken
 * (a syntax error); every other failure is a `{ ok: false }` check.
 */
export async function checkInpageBundle(
  source: string,
  expect: ConformanceExpect,
  env: { window: Window & typeof globalThis },
): Promise<ConformanceReport> {
  const win = env.window as Window & typeof globalThis & Record<string, unknown>;
  const channel = expect.channel ?? DEFAULT_CHANNEL;
  const checks: ConformanceCheck[] = [];

  const config: InjectedConfig = {
    identity: expect.identity,
    networks: expect.families.map((family) => SAMPLE_NETWORK[family]),
    ...(expect.channel !== undefined ? { channel: expect.channel } : {}),
    ...(expect.cardanoWalletKey !== undefined ? { cardanoWalletKey: expect.cardanoWalletKey } : {}),
  };

  const posted: string[] = [];
  const announced: Announced[] = [];
  const announcedTron: Announced[] = [];
  const registered: RegisteredWallet[] = [];

  (win as { ReactNativeWebView?: { postMessage(data: string): void } }).ReactNativeWebView = {
    postMessage: (data) => posted.push(data),
  };
  // TronLink dispatches over window.postMessage(data, location.origin). A window
  // never navigated to a real URL (a bare jsdom instance, an unattached iframe)
  // has an opaque "null" origin, which throws there; deliver the message
  // directly instead so the check does not depend on the caller's window having
  // a real origin.
  win.postMessage = ((data: unknown) => {
    win.dispatchEvent(new win.MessageEvent("message", { data, origin: win.location.origin, source: win }));
  }) as typeof win.postMessage;
  win.addEventListener("eip6963:announceProvider", (event) => {
    announced.push((event as CustomEvent<Announced>).detail);
  });
  win.addEventListener("TIP6963:announceProvider", (event) => {
    announcedTron.push((event as CustomEvent<Announced>).detail);
  });
  win.addEventListener("wallet-standard:register-wallet", (event) => {
    const detail = (event as unknown as { detail: (api: { register(w: unknown): void }) => void }).detail;
    detail({ register: (wallet) => registered.push(wallet as RegisteredWallet) });
  });

  // A syntax error in `source` (or the preamble) must propagate, not become a check.
  win.eval(buildPreamble(config));
  win.eval(source);

  function record(name: string, ok: boolean, family?: ChainFamily, detail?: string): void {
    checks.push({ name, ...(family ? { family } : {}), ok, ...(detail !== undefined ? { detail } : {}) });
  }

  function deliver(message: HostToPage): void {
    const receive = win[RN_RECEIVE] as ((env: unknown, nonce?: unknown) => void) | undefined;
    receive?.(hostToPage(channel, message), null);
  }

  async function tick(): Promise<void> {
    await new Promise<void>((resolve) => win.setTimeout(resolve, 0));
  }

  /**
   * A loose read of what the page posted, not a protocol validation: the RN
   * preamble this harness reuses as its transport hook always stamps `n`, even
   * `null` with no nonce configured, which `isPageToHost` would reject as
   * unbounded. Channel and direction are still checked so a message meant for
   * another consumer sharing the window is never mistaken for ours.
   */
  function parsePosted(raw: string): Record<string, unknown> | null {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      const env = parsed as Record<string, unknown>;
      if (env.channel !== channel || env.direction !== "page-to-host") return null;
      return env;
    } catch {
      return null;
    }
  }

  function lastRequest(): { id: string; method: string } | null {
    for (let i = posted.length - 1; i >= 0; i -= 1) {
      const env = parsePosted(posted[i]!);
      if (env && env.kind === "request" && typeof env.id === "string" && typeof env.method === "string") {
        return { id: env.id, method: env.method };
      }
    }
    return null;
  }

  async function roundTrip(family: ChainFamily, call: () => Promise<unknown>, result: unknown): Promise<void> {
    const promise = call();
    await tick();
    const req = lastRequest();
    if (!req) {
      record("request round-trips", false, family, "no request envelope observed");
      promise.catch(() => {});
      return;
    }
    deliver({ kind: "response", id: req.id, result });
    try {
      await promise;
      record("request round-trips", true, family);
    } catch (error) {
      record("request round-trips", false, family, error instanceof Error ? error.message : String(error));
    }
  }

  function walletStandardWallet(prefix: string): RegisteredWallet | undefined {
    return registered.find((w) => (w.chains ?? []).some((c) => c.startsWith(prefix)));
  }

  async function checkWalletStandard(family: "solana" | "btc" | "xrp"): Promise<void> {
    const spec = WALLET_STANDARD_SPEC[family];
    const wallet = walletStandardWallet(spec.chainPrefix);
    const ok = Boolean(wallet) && wallet?.name === expect.identity.name;
    record(
      "discovery: wallet-standard:register-wallet",
      ok,
      family,
      ok ? undefined : "no matching wallet-standard registration observed",
    );
    if (!wallet) return;

    const connect = wallet.features?.[spec.connectFeature]?.connect;
    if (connect) {
      await roundTrip(family, () => connect({ silent: true }), null);
    } else {
      record("request round-trips", false, family, `wallet is missing the ${spec.connectFeature} feature`);
    }

    let seen: unknown;
    wallet.features?.[spec.eventsFeature]?.on?.("change", (data) => {
      seen = data;
    });
    deliver({ kind: "event", family, event: "accountsChanged", data: [] });
    await tick();
    record("event reaches a listener", seen !== undefined, family);
  }

  async function checkEvm(): Promise<void> {
    const last = announced[announced.length - 1];
    const identityOk =
      Boolean(last) &&
      last?.info.name === expect.identity.name &&
      last?.info.rdns === expect.identity.rdns &&
      last?.info.uuid === expect.identity.uuid;
    record(
      "discovery: eip6963:announceProvider",
      identityOk,
      "evm",
      identityOk ? undefined : "no announce observed, or identity did not match",
    );
    if (!last) return;

    const provider = last.provider as {
      request(args: { method: string; params?: unknown[] }): Promise<unknown>;
      on(event: string, cb: (data: unknown) => void): void;
    };
    await roundTrip("evm", () => provider.request({ method: "eth_chainId" }), "0x1");

    let seen: unknown;
    provider.on("accountsChanged", (data) => {
      seen = data;
    });
    deliver({ kind: "event", family: "evm", event: "accountsChanged", data: ["0xabc"] });
    await tick();
    record("event reaches a listener", Array.isArray(seen) && seen[0] === "0xabc", "evm");
  }

  async function checkCardano(): Promise<void> {
    const key = cardanoWalletKey(config);
    const wallet = (win.cardano as Record<string, { name: string; isEnabled(): Promise<unknown> }> | undefined)?.[
      key
    ];
    record(
      "discovery: window.cardano[key]",
      Boolean(wallet) && wallet?.name === expect.identity.name,
      "cardano",
      wallet ? undefined : `window.cardano.${key} is missing`,
    );
    if (!wallet) return;

    await roundTrip("cardano", () => wallet.isEnabled(), true);
    // CIP-30 exposes no public event-listener surface to verify against.
    record("event reaches a listener", true, "cardano", "cardano has no public event API; not applicable");
  }

  /** Both Tron surfaces: the announced provider on window.tron, and the legacy one. */
  async function checkTron(): Promise<void> {
    const provider = win.tron as TronProviderLike | undefined;
    const last = announcedTron[announcedTron.length - 1];
    const identityOk =
      Boolean(last) &&
      last?.info.name === expect.identity.name &&
      last?.info.rdns === expect.identity.rdns &&
      last?.info.uuid === expect.identity.uuid;
    record(
      "discovery: TIP6963:announceProvider",
      identityOk && last?.provider === provider,
      "tron",
      identityOk
        ? last?.provider === provider
          ? undefined
          : "the announced provider is not window.tron"
        : "no announce observed, or identity did not match",
    );
    record(
      "discovery: window.tron.request",
      typeof provider?.request === "function",
      "tron",
      provider ? undefined : "window.tron is missing",
    );

    const tronLink = win.tronLink as
      | { ready: boolean; request(args: { method: string; params?: unknown }): Promise<unknown> }
      | undefined;
    record("discovery: window.tronLink", Boolean(tronLink), "tron", tronLink ? undefined : "window.tronLink is missing");
    if (!tronLink) return;

    await roundTrip("tron", () => tronLink.request({ method: "tron_accounts" }), []);
    if (provider) await checkTronConnect(provider, tronLink);

    let seen: unknown;
    const listener = (event: MessageEvent): void => {
      const data = event.data as { message?: { action?: string } } | undefined;
      if (data?.message?.action === "disconnect") seen = data;
    };
    win.addEventListener("message", listener);
    deliver({ kind: "event", family: "tron", event: "accountsChanged", data: [] });
    win.removeEventListener("message", listener);
    record("event reaches a listener", seen !== undefined, "tron");
  }

  /**
   * The authorization method current Tron dApps call. It must reach the host as
   * `tron_requestAccounts`, answer with the address array, and flip legacy `ready`.
   */
  async function checkTronConnect(
    provider: TronProviderLike,
    tronLink: { ready: boolean },
  ): Promise<void> {
    const name = "connect: eth_requestAccounts authorizes over tron_requestAccounts";
    const promise = provider.request({ method: "eth_requestAccounts" });
    await tick();
    const req = lastRequest();
    if (!req || req.method !== "tron_requestAccounts") {
      record(name, false, "tron", req ? `the host was asked for ${req.method}` : "no request envelope observed");
      promise.catch(() => {});
      return;
    }
    deliver({ kind: "response", id: req.id, result: { address: TRON_ADDRESS } });
    try {
      const accounts = await promise;
      const ok = Array.isArray(accounts) && accounts[0] === TRON_ADDRESS;
      record(
        name,
        ok && tronLink.ready,
        "tron",
        ok ? (tronLink.ready ? undefined : "window.tronLink.ready did not flip") : `resolved ${JSON.stringify(accounts)}`,
      );
    } catch (error) {
      record(name, false, "tron", error instanceof Error ? error.message : String(error));
    }
  }

  async function checkXrpCrossmark(): Promise<void> {
    const crossmark = win.crossmark as
      | { getAddress(): Promise<string>; on(event: string, cb: (data: unknown) => void): void }
      | undefined;
    record(
      "discovery: window.crossmark",
      Boolean(crossmark),
      "xrp",
      crossmark ? undefined : "window.crossmark is missing",
    );
    if (!crossmark) return;

    await roundTrip("xrp", () => crossmark.getAddress(), []);

    let seen: unknown = "unset";
    crossmark.on("signout", (data) => {
      seen = data;
    });
    deliver({ kind: "event", family: "xrp", event: "accountsChanged", data: [] });
    await tick();
    record("event reaches a listener", seen === null, "xrp");
  }

  for (const family of expect.families) {
    switch (family) {
      case "evm":
        await checkEvm();
        break;
      case "solana":
      case "btc":
        await checkWalletStandard(family);
        break;
      case "cardano":
        await checkCardano();
        break;
      case "tron":
        await checkTron();
        break;
      case "xrp":
        await checkXrpCrossmark();
        await checkWalletStandard("xrp");
        break;
    }
  }

  const readyFamilies = new Set<ChainFamily>();
  for (const raw of posted) {
    const env = parsePosted(raw);
    if (env && env.kind === "ready" && Array.isArray(env.families)) {
      for (const f of env.families) if (isChainFamily(f)) readyFamilies.add(f);
    }
  }
  const missingReady = expect.families.filter((f) => !readyFamilies.has(f));
  record(
    "ready envelope announces the expected families",
    missingReady.length === 0,
    undefined,
    missingReady.length > 0 ? `missing: ${missingReady.join(", ")}` : undefined,
  );

  const announcedBefore = announced.length + announcedTron.length;
  const registeredBefore = registered.length;
  win.eval(source);
  const announcedAfter = announced.length + announcedTron.length;
  record(
    "second evaluation does not re-announce or re-register",
    announcedAfter === announcedBefore && registered.length === registeredBefore,
    undefined,
    announcedAfter !== announcedBefore || registered.length !== registeredBefore
      ? `announced ${announcedAfter - announcedBefore} more, registered ${registered.length - registeredBefore} more`
      : undefined,
  );

  return { ok: checks.every((c) => c.ok), checks };
}
