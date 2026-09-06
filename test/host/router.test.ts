import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDappRouter,
  type ConnectDecision,
  type ConnectRequest,
  type DappRouter,
  type RouterDeps,
  type SignRequest,
} from "../../src/host/router";
import { memorySessionStore, type SessionStore } from "../../src/host/session-store";
import type { ProviderEvent } from "../../src/protocol/envelope";
import type { NetworkDef } from "../../src/protocol/networks";
import type { Session } from "../../src/protocol/session";

const ORIGIN = "https://app.uniswap.org";
const EVM_ADDRESS = "0x7a3f000000000000000000000000000000002b1c";
const SOL_ADDRESS = "So11111111111111111111111111111111111111112";
const MESSAGE = "0xdeadbeef";

const NETWORKS: NetworkDef[] = [
  { id: "1", family: "evm", name: "Ethereum", wire: { evmChainId: "0x1", caip2: "eip155:1" } },
  { id: "137", family: "evm", name: "Polygon", wire: { evmChainId: "0x89" } },
  {
    id: "sol_mainnet",
    family: "solana",
    name: "Solana",
    wire: { walletStandardChain: "solana:mainnet" },
  },
  { id: "ada_mainnet", family: "cardano", name: "Cardano", wire: { cardanoNetworkId: 1 } },
];

function session(over: Partial<Session> & Pick<Session, "family">): Session {
  return {
    origin: ORIGIN,
    networkId: over.family === "evm" ? "1" : over.family === "solana" ? "sol_mainnet" : "ada_mainnet",
    accounts: over.family === "solana" ? [SOL_ADDRESS] : [EVM_ADDRESS],
    createdAt: 1,
    lastUsedAt: 1,
    ...over,
  };
}

/** Let every pending continuation run before asserting on side effects. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

type Harness = {
  router: DappRouter;
  sessions: SessionStore;
  connect: ReturnType<typeof vi.fn>;
  sign: ReturnType<typeof vi.fn>;
  switchChain: ReturnType<typeof vi.fn>;
  rpc: ReturnType<typeof vi.fn>;
  events: { origin: string; event: ProviderEvent }[];
};

function harness(
  seed: Session[] = [],
  overrides: Partial<RouterDeps> = {},
): Harness {
  const sessions = memorySessionStore(seed);
  const connect = vi.fn(async (): Promise<ConnectDecision | null> => null);
  const sign = vi.fn(async () => "0xsigned");
  const switchChain = vi.fn(async () => true);
  const rpc = vi.fn(async () => "0x2a");
  const events: { origin: string; event: ProviderEvent }[] = [];

  const router = createDappRouter({
    networks: NETWORKS,
    sessions,
    ui: { connect, sign },
    rpc,
    emit: (origin, event) => events.push({ origin, event }),
    ...overrides,
  });

  return { router, sessions, connect, sign, switchChain, rpc, events };
}

let h: Harness;
beforeEach(() => {
  h = harness();
});

describe("read-only methods answer locally and never prompt", () => {
  it("returns the default chain id with no session", async () => {
    const out = await h.router.handle({ origin: ORIGIN, method: "eth_chainId" });

    expect(out).toEqual({ result: "0x1" });
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("returns an empty account list rather than prompting when not connected", async () => {
    const out = await h.router.handle({ origin: ORIGIN, method: "eth_accounts" });

    expect(out).toEqual({ result: [] });
    expect(h.connect).not.toHaveBeenCalled();
  });

  it("derives net_version from the session network", async () => {
    h = harness([session({ family: "evm", networkId: "137" })]);

    const out = await h.router.handle({ origin: ORIGIN, method: "net_version" });

    expect(out).toEqual({ result: "137" });
  });

  it("answers wallet_getPermissions from the session", async () => {
    expect(await h.router.handle({ origin: ORIGIN, method: "wallet_getPermissions" })).toEqual({
      result: [],
    });

    h = harness([session({ family: "evm" })]);
    expect(await h.router.handle({ origin: ORIGIN, method: "wallet_getPermissions" })).toEqual({
      result: [{ parentCapability: "eth_accounts" }],
    });
  });

  it("answers CIP-30 reads from the session and the network wire", async () => {
    h = harness([session({ family: "cardano", accounts: ["addr_hex_a", "addr_hex_b"] })]);

    expect(await h.router.handle({ origin: ORIGIN, method: "cardano_isEnabled" })).toEqual({
      result: true,
    });
    expect(await h.router.handle({ origin: ORIGIN, method: "cardano_getNetworkId" })).toEqual({
      result: 1,
    });
    expect(await h.router.handle({ origin: ORIGIN, method: "cardano_getUsedAddresses" })).toEqual({
      result: ["addr_hex_a", "addr_hex_b"],
    });
    expect(await h.router.handle({ origin: ORIGIN, method: "cardano_getChangeAddress" })).toEqual({
      result: "addr_hex_a",
    });
    expect(await h.router.handle({ origin: ORIGIN, method: "cardano_getRewardAddresses" })).toEqual(
      { result: [] },
    );
  });
});

describe("read RPC passthrough", () => {
  beforeEach(() => {
    h = harness([session({ family: "evm" })]);
  });

  it("proxies an allow-listed method to the node", async () => {
    const out = await h.router.handle({
      origin: ORIGIN,
      method: "eth_getBalance",
      params: [EVM_ADDRESS, "latest"],
    });

    expect(h.rpc).toHaveBeenCalledWith({
      family: "evm",
      networkId: "1",
      chainId: "0x1",
      method: "eth_getBalance",
      params: [EVM_ADDRESS, "latest"],
    });
    expect(out).toEqual({ result: "0x2a" });
  });

  it("refuses a method that is not on the allow-list", async () => {
    const out = await h.router.handle({ origin: ORIGIN, method: "eth_sendRawTransaction" });

    expect(out).toEqual({
      error: { code: 4200, message: "Unsupported method: eth_sendRawTransaction" },
    });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("reports a node failure as an internal error instead of throwing", async () => {
    h.rpc.mockRejectedValue(new Error("node unreachable"));

    const out = await h.router.handle({ origin: ORIGIN, method: "eth_call", params: [] });

    expect(out).toEqual({ error: { code: -32603, message: "node unreachable" } });
  });

  it("refuses every read when the policy is none", async () => {
    h = harness([session({ family: "evm" })], { policy: { readRpc: "none" } });

    const out = await h.router.handle({ origin: ORIGIN, method: "eth_call", params: [] });

    expect(out).toEqual({ error: { code: 4200, message: "Unsupported method: eth_call" } });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("honours a custom allow-list", async () => {
    h = harness([session({ family: "evm" })], {
      policy: { readRpc: new Set(["eth_blockNumber"]) },
    });

    expect(await h.router.handle({ origin: ORIGIN, method: "eth_blockNumber" })).toEqual({
      result: "0x2a",
    });
    expect(await h.router.handle({ origin: ORIGIN, method: "eth_call" })).toEqual({
      error: { code: 4200, message: "Unsupported method: eth_call" },
    });
  });

  it("refuses a read for an origin with no session", async () => {
    h = harness();

    const out = await h.router.handle({ origin: ORIGIN, method: "eth_getBalance", params: [] });

    expect(out).toEqual({
      error: { code: 4100, message: "Unauthorized — connect the wallet first" },
    });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("serves an unconnected origin when the host turns the gate off", async () => {
    h = harness([], { policy: { readRpcRequiresSession: false } });

    expect(await h.router.handle({ origin: ORIGIN, method: "eth_blockNumber" })).toEqual({
      result: "0x2a",
    });
  });

  it("is unsupported when the host wired no rpc client", async () => {
    const router = createDappRouter({
      networks: NETWORKS,
      sessions: memorySessionStore([session({ family: "evm" })]),
      ui: { connect: vi.fn(async () => null), sign: vi.fn(async () => "0x") },
      emit: () => {},
    });

    expect(await router.handle({ origin: ORIGIN, method: "eth_call" })).toEqual({
      error: { code: 4200, message: "Unsupported method: eth_call" },
    });
  });
});

describe("cardano_submitTx is a submit, not a read", () => {
  it("refuses an origin with no session", async () => {
    const out = await h.router.handle({
      origin: ORIGIN,
      method: "cardano_submitTx",
      params: [{ tx: "abcd" }],
    });

    expect(out).toEqual({
      error: { code: 4100, message: "Unauthorized — connect the wallet first" },
    });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("forwards to the node when the host wired no submit callback", async () => {
    h = harness([session({ family: "cardano", accounts: ["addr1"] })]);

    const out = await h.router.handle({
      origin: ORIGIN,
      method: "cardano_submitTx",
      params: [{ tx: "abcd" }],
    });

    expect(out).toEqual({ result: "0x2a" });
    expect(h.rpc).toHaveBeenCalledWith(
      expect.objectContaining({ family: "cardano", method: "cardano_submitTx" }),
    );
  });

  it("goes through ui.submit when the host supplies one", async () => {
    const submit = vi.fn(async () => "tx-hash");
    h = harness([session({ family: "cardano", accounts: ["addr1"] })], {
      ui: { connect: vi.fn(async () => null), sign: vi.fn(async () => "0x"), submit },
    });

    const out = await h.router.handle({
      origin: ORIGIN,
      method: "cardano_submitTx",
      params: [{ tx: "abcd" }],
    });

    expect(out).toEqual({ result: "tx-hash" });
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ origin: ORIGIN, family: "cardano", method: "cardano_submitTx" }),
    );
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("is not reachable through the read allow-list", async () => {
    h = harness([session({ family: "cardano", accounts: ["addr1"] })], {
      policy: { readRpc: "none" },
    });

    expect(
      await h.router.handle({ origin: ORIGIN, method: "cardano_submitTx", params: [{ tx: "a" }] }),
    ).toEqual({ result: "0x2a" });
  });
});

describe("connect", () => {
  it("returns existing accounts without prompting again", async () => {
    h = harness([session({ family: "evm" })]);

    const out = await h.router.handle({ origin: ORIGIN, method: "eth_requestAccounts" });

    expect(out).toEqual({ result: [EVM_ADDRESS] });
    expect(h.connect).not.toHaveBeenCalled();
  });

  it("prompts when there is no session and returns the granted accounts", async () => {
    h.connect.mockResolvedValue({ accounts: [EVM_ADDRESS] });

    const out = await h.router.handle({ origin: ORIGIN, method: "eth_requestAccounts" });

    expect(h.connect).toHaveBeenCalledWith(
      expect.objectContaining({ origin: ORIGIN, family: "evm", method: "eth_requestAccounts" }),
    );
    expect(out).toEqual({ result: [EVM_ADDRESS] });
    expect(await h.sessions.get(ORIGIN, "evm")).toMatchObject({
      accounts: [EVM_ADDRESS],
      networkId: "1",
    });
    expect(h.events).toContainEqual({
      origin: ORIGIN,
      event: { family: "evm", event: "accountsChanged", data: [EVM_ADDRESS] },
    });
  });

  it("stores the network the decision named", async () => {
    h.connect.mockResolvedValue({ accounts: [EVM_ADDRESS], networkId: "137", walletId: "vault-7" });

    await h.router.handle({ origin: ORIGIN, method: "eth_requestAccounts" });

    expect(await h.sessions.get(ORIGIN, "evm")).toMatchObject({
      networkId: "137",
      walletId: "vault-7",
    });
  });

  it("answers 4001 when the user rejects", async () => {
    h.connect.mockResolvedValue(null);

    const out = await h.router.handle({ origin: ORIGIN, method: "eth_requestAccounts" });

    expect(out).toEqual({ error: { code: 4001, message: "User rejected the request" } });
  });

  it("coalesces concurrent connects for the same origin and family", async () => {
    let release!: (d: ConnectDecision) => void;
    const gate = new Promise<ConnectDecision>((resolve) => {
      release = resolve;
    });
    h.connect.mockImplementation(() => gate);

    const a = h.router.handle({ origin: ORIGIN, method: "eth_requestAccounts" });
    const b = h.router.handle({ origin: ORIGIN, method: "eth_requestAccounts" });
    release({ accounts: [EVM_ADDRESS] });

    expect(await a).toEqual({ result: [EVM_ADDRESS] });
    expect(await b).toEqual({ result: [EVM_ADDRESS] });
    expect(h.connect).toHaveBeenCalledTimes(1);
  });

  it("prompts again when silentReconnect is off", async () => {
    h = harness([session({ family: "evm" })], { policy: { silentReconnect: false } });
    h.connect.mockResolvedValue({ accounts: [EVM_ADDRESS] });

    await h.router.handle({ origin: ORIGIN, method: "eth_requestAccounts" });

    expect(h.connect).toHaveBeenCalledTimes(1);
  });

  it("times out an unanswered prompt as 4001", async () => {
    vi.useFakeTimers();
    try {
      h = harness([], { policy: { requestTimeoutMs: 1000 } });
      h.connect.mockImplementation(() => new Promise<ConnectDecision>(() => {}));

      const pending = h.router.handle({ origin: ORIGIN, method: "eth_requestAccounts" });
      await vi.advanceTimersByTimeAsync(1000);

      expect(await pending).toEqual({
        error: { code: 4001, message: "Request timed out without an answer" },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("policy.canReuseSession", () => {
  it("opens ui.connect with the existing session when the hook returns false", async () => {
    const existing = session({ family: "evm" });
    const canReuseSession = vi.fn(async () => false);
    h = harness([existing], { policy: { canReuseSession } });
    h.connect.mockResolvedValue({ accounts: [EVM_ADDRESS] });

    await h.router.handle({ origin: ORIGIN, method: "eth_requestAccounts" });

    expect(canReuseSession).toHaveBeenCalledWith(
      existing,
      expect.objectContaining({ origin: ORIGIN, family: "evm", method: "eth_requestAccounts" }),
    );
    expect(h.connect).toHaveBeenCalledWith(expect.objectContaining({ existing }));
  });

  it("answers from the session with no UI when the hook returns true", async () => {
    const canReuseSession = vi.fn(async () => true);
    h = harness([session({ family: "evm" })], { policy: { canReuseSession } });

    const out = await h.router.handle({ origin: ORIGIN, method: "eth_requestAccounts" });

    expect(out).toEqual({ result: [EVM_ADDRESS] });
    expect(h.connect).not.toHaveBeenCalled();
  });

  it("never opens UI for a silent connect even when the hook returns false", async () => {
    const canReuseSession = vi.fn(async () => false);
    h = harness([session({ family: "evm" })], { policy: { canReuseSession } });

    const out = await h.router.handle({
      origin: ORIGIN,
      method: "eth_requestAccounts",
      params: [{ silent: true }],
    });

    expect(out).toEqual({ result: null });
    expect(h.connect).not.toHaveBeenCalled();
  });

  it("supports an async hook", async () => {
    const canReuseSession = vi.fn(
      () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 0)),
    );
    h = harness([session({ family: "evm" })], { policy: { canReuseSession } });

    const out = await h.router.handle({ origin: ORIGIN, method: "eth_requestAccounts" });

    expect(out).toEqual({ result: [EVM_ADDRESS] });
    expect(h.connect).not.toHaveBeenCalled();
  });

  it("treats a throwing hook as false and still prompts", async () => {
    const canReuseSession = vi.fn(() => {
      throw new Error("boom");
    });
    h = harness([session({ family: "evm" })], { policy: { canReuseSession } });
    h.connect.mockResolvedValue({ accounts: [EVM_ADDRESS] });

    const out = await h.router.handle({ origin: ORIGIN, method: "eth_requestAccounts" });

    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ result: [EVM_ADDRESS] });
  });

  it("keeps the existing session's id and createdAt when the decision reuses it", async () => {
    const existing = session({ family: "evm", id: "backend-1", createdAt: 42 });
    const canReuseSession = vi.fn(async () => false);
    h = harness([existing], { policy: { canReuseSession } });
    h.connect.mockResolvedValue({ accounts: [EVM_ADDRESS], reuse: true });

    const out = await h.router.handle({ origin: ORIGIN, method: "eth_requestAccounts" });

    expect(out).toEqual({ result: [EVM_ADDRESS] });
    expect(await h.sessions.get(ORIGIN, "evm")).toMatchObject({
      id: "backend-1",
      createdAt: 42,
      accounts: [EVM_ADDRESS],
    });
  });
});

describe("wallet_switchEthereumChain", () => {
  it("answers 4902 for a chain that is not registered", async () => {
    const out = await h.router.handle({
      origin: ORIGIN,
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0xdead" }],
    });

    expect(out).toEqual({ error: { code: 4902, message: "Unrecognized chain ID" } });
  });

  it("switches a registered chain and emits chainChanged", async () => {
    h = harness([session({ family: "evm", networkId: "1" })]);

    const out = await h.router.handle({
      origin: ORIGIN,
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x89" }],
    });

    expect(out).toEqual({ result: null });
    expect(await h.sessions.get(ORIGIN, "evm")).toMatchObject({ networkId: "137" });
    expect(h.events).toContainEqual({
      origin: ORIGIN,
      event: { family: "evm", event: "chainChanged", data: "0x89" },
    });
  });

  it("does not emit when the session is already on that chain", async () => {
    h = harness([session({ family: "evm", networkId: "137" })]);

    await h.router.handle({
      origin: ORIGIN,
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x89" }],
    });

    expect(h.events).toHaveLength(0);
  });

  it("refuses a chain outside supportedEvmChainIds even when registered", async () => {
    h = harness([], { policy: { supportedEvmChainIds: new Set(["0x1"]) } });

    expect(
      await h.router.handle({
        origin: ORIGIN,
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x89" }],
      }),
    ).toEqual({ error: { code: 4902, message: "Unrecognized chain ID" } });
  });

  it("asks switchChain when the host supplies it and maps a refusal to 4001", async () => {
    const switchChain = vi.fn(async () => false);
    h = harness([session({ family: "evm" })], {
      ui: { connect: vi.fn(async () => null), sign: vi.fn(async () => "0x"), switchChain },
    });

    const out = await h.router.handle({
      origin: ORIGIN,
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x89" }],
    });

    expect(switchChain).toHaveBeenCalled();
    expect(out).toEqual({ error: { code: 4001, message: "User rejected the request" } });
  });

  it("answers 4902 without UI when the origin has no EVM session", async () => {
    const addChain = vi.fn(async () => null);
    const switchChain = vi.fn(async () => true);
    h = harness([], {
      ui: { connect: vi.fn(async () => null), sign: vi.fn(async () => "0x"), addChain, switchChain },
    });

    const out = await h.router.handle({
      origin: ORIGIN,
      method: "wallet_addEthereumChain",
      params: [{ chainId: "0x2105" }],
    });

    expect(out).toEqual({ error: { code: 4902, message: "Unrecognized chain ID" } });
    expect(addChain).not.toHaveBeenCalled();
    expect(switchChain).not.toHaveBeenCalled();
  });

  it("keeps a chain one origin added out of every other origin's registry", async () => {
    const other = "https://evil.example";
    const added: NetworkDef = { id: "8453", family: "evm", name: "Base", wire: { evmChainId: "0x2105" } };
    const addChain = vi.fn(async (): Promise<NetworkDef | null> => added);
    h = harness([session({ family: "evm" }), session({ family: "evm", origin: other })], {
      ui: { connect: vi.fn(async () => null), sign: vi.fn(async () => "0x"), addChain },
    });

    await h.router.handle({
      origin: ORIGIN,
      method: "wallet_addEthereumChain",
      params: [{ chainId: "0x2105" }],
    });
    addChain.mockResolvedValue(null);
    const out = await h.router.handle({
      origin: other,
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x2105" }],
    });

    expect(out).toEqual({ error: { code: 4902, message: "Unrecognized chain ID" } });
    expect(await h.sessions.get(other, "evm")).toMatchObject({ networkId: "1" });
  });

  it("caps how many chains one origin can add", async () => {
    const addChain = vi.fn(async (req: { chainId: string }) => ({
      id: req.chainId,
      family: "evm" as const,
      name: `Chain ${req.chainId}`,
      wire: { evmChainId: req.chainId },
    }));
    h = harness([session({ family: "evm" })], {
      ui: { connect: vi.fn(async () => null), sign: vi.fn(async () => "0x"), addChain },
      policy: { maxConcurrentPrompts: 32 },
    });

    for (let i = 0; i < 16; i += 1) {
      const chainId = `0x${(0x1000 + i).toString(16)}`;
      expect(
        await h.router.handle({
          origin: ORIGIN,
          method: "wallet_addEthereumChain",
          params: [{ chainId }],
        }),
      ).toEqual({ result: null });
    }

    expect(
      await h.router.handle({
        origin: ORIGIN,
        method: "wallet_addEthereumChain",
        params: [{ chainId: "0xbeef" }],
      }),
    ).toEqual({ error: { code: 4902, message: "Unrecognized chain ID" } });
  });

  it("registerNetwork makes a chain visible to every origin", async () => {
    const other = "https://app.aave.com";
    h = harness([session({ family: "evm", origin: other })]);

    h.router.registerNetwork({
      id: "8453",
      family: "evm",
      name: "Base",
      wire: { evmChainId: "0x2105" },
    });
    const out = await h.router.handle({
      origin: other,
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x2105" }],
    });

    expect(out).toEqual({ result: null });
    expect(await h.sessions.get(other, "evm")).toMatchObject({ networkId: "8453" });
  });

  it("registers a network returned by addChain and completes the switch", async () => {
    const added: NetworkDef = { id: "8453", family: "evm", name: "Base", wire: { evmChainId: "0x2105" } };
    h = harness([session({ family: "evm" })], {
      ui: {
        connect: vi.fn(async () => null),
        sign: vi.fn(async () => "0x"),
        addChain: vi.fn(async () => added),
      },
    });

    const out = await h.router.handle({
      origin: ORIGIN,
      method: "wallet_addEthereumChain",
      params: [{ chainId: "0x2105" }],
    });

    expect(out).toEqual({ result: null });
    expect(await h.sessions.get(ORIGIN, "evm")).toMatchObject({ networkId: "8453" });
  });
});

describe("signing", () => {
  it("refuses to sign for an origin that never connected", async () => {
    const out = await h.router.handle({
      origin: ORIGIN,
      method: "personal_sign",
      params: ["0xdeadbeef", EVM_ADDRESS],
    });

    expect(out).toEqual({
      error: { code: 4100, message: "Unauthorized — connect the wallet first" },
    });
    expect(h.sign).not.toHaveBeenCalled();
  });

  it("raises a prompt for a connected origin and returns the signature", async () => {
    h = harness([session({ family: "evm" })]);

    const out = await h.router.handle({
      origin: ORIGIN,
      method: "eth_sendTransaction",
      params: [{ to: EVM_ADDRESS, value: "0x1", data: "0xabcdef" }],
    });

    const req = h.sign.mock.calls[0]?.[0] as SignRequest & { family: "evm" };
    expect(req.origin).toBe(ORIGIN);
    expect(req.method).toBe("eth_sendTransaction");
    expect("tx" in req && req.tx).toMatchObject({
      to: EVM_ADDRESS,
      value: "0x1",
      dataLength: 3,
      chainId: "0x1",
    });
    expect(out).toEqual({ result: "0xsigned" });
  });

  it("hands the modal a parsed EIP-712 tree", async () => {
    h = harness([session({ family: "evm" })]);
    const typed = JSON.stringify({
      primaryType: "Permit",
      domain: { name: "USDC", chainId: 1 },
      message: { owner: EVM_ADDRESS, value: "1000" },
    });

    await h.router.handle({
      origin: ORIGIN,
      method: "eth_signTypedData_v4",
      params: [EVM_ADDRESS, typed],
    });

    const req = h.sign.mock.calls[0]?.[0] as SignRequest & { family: "evm" };
    expect("typedData" in req && req.typedData).toMatchObject({
      primaryType: "Permit",
      truncated: false,
    });
  });

  it("maps a rejection thrown by the prompt back to its RPC code", async () => {
    h = harness([session({ family: "evm" })]);
    h.sign.mockRejectedValue({ code: 4001, message: "User rejected the request" });

    const out = await h.router.handle({
      origin: ORIGIN,
      method: "personal_sign",
      params: ["0xdeadbeef", EVM_ADDRESS],
    });

    expect(out).toEqual({ error: { code: 4001, message: "User rejected the request" } });
  });

  it("parses Solana transaction bytes for the modal", async () => {
    h = harness([session({ family: "solana" })]);

    await h.router.handle({
      origin: ORIGIN,
      method: "solana_signTransaction",
      params: [{ tx: [1, 2, 3], account: SOL_ADDRESS }],
    });

    const req = h.sign.mock.calls[0]?.[0] as SignRequest & { family: "solana" };
    expect("txBytes" in req && req.txBytes).toEqual([1, 2, 3]);
    expect(req.account).toBe(SOL_ADDRESS);
  });
});

describe("the payload the model was built from", () => {
  const INVALID = { code: -32602 };

  it("names the typed data candidate the tree came from, not the other one", async () => {
    h = harness([session({ family: "evm" })]);
    const drainPermit = JSON.stringify({
      primaryType: "Permit",
      message: { spender: "0xattacker", value: "115792089237316195423570985008687907853269984665640564039457584007913129639935" },
    });
    const benignLogin = JSON.stringify({
      primaryType: "Login",
      message: { statement: "Sign in" },
    });

    await h.router.handle({
      origin: ORIGIN,
      method: "eth_signTypedData_v4",
      params: [drainPermit, benignLogin],
    });

    const req = h.sign.mock.calls[0]?.[0] as SignRequest & { family: "evm" };
    expect(req.payload).toBe(benignLogin);
    expect("typedData" in req && req.typedData.primaryType).toBe("Login");
  });

  it("still parses the [json, address] order dApps sometimes send", async () => {
    h = harness([session({ family: "evm" })]);
    const typed = JSON.stringify({ primaryType: "Permit", message: { value: "1" } });

    await h.router.handle({
      origin: ORIGIN,
      method: "eth_signTypedData_v4",
      params: [typed, EVM_ADDRESS],
    });

    const req = h.sign.mock.calls[0]?.[0] as SignRequest & { family: "evm" };
    expect(req.payload).toBe(typed);
  });

  it("never opens a sheet for typed data it could not parse", async () => {
    h = harness([session({ family: "evm" })]);

    const out = await h.router.handle({
      origin: ORIGIN,
      method: "eth_signTypedData_v4",
      params: [EVM_ADDRESS, "not json"],
    });

    expect(out).toMatchObject({ error: INVALID });
    expect(h.sign).not.toHaveBeenCalled();
  });

  it("refuses an object where a string message belongs", async () => {
    h = harness([session({ family: "evm" })]);

    const out = await h.router.handle({
      origin: ORIGIN,
      method: "personal_sign",
      params: [{ toString: "0xdeadbeef" }, EVM_ADDRESS],
    });

    expect(out).toMatchObject({ error: INVALID });
    expect(h.sign).not.toHaveBeenCalled();
  });

  it("refuses every sign method whose required param is missing", async () => {
    h = harness([session({ family: "evm" })]);

    for (const method of ["personal_sign", "eth_sign", "eth_sendTransaction"]) {
      expect(await h.router.handle({ origin: ORIGIN, method, params: [] })).toMatchObject({
        error: INVALID,
      });
    }

    h = harness([session({ family: "cardano", accounts: ["addr1"] })]);
    for (const method of ["cardano_signTx", "cardano_signData"]) {
      expect(await h.router.handle({ origin: ORIGIN, method, params: [{}] })).toMatchObject({
        error: INVALID,
      });
    }

    h = harness([session({ family: "solana" })]);
    expect(
      await h.router.handle({
        origin: ORIGIN,
        method: "solana_signMessage",
        params: [{ account: SOL_ADDRESS }],
      }),
    ).toMatchObject({ error: INVALID });

    expect(h.sign).not.toHaveBeenCalled();
  });

  it("hands the message itself as the payload of a personal_sign", async () => {
    h = harness([session({ family: "evm" })]);

    await h.router.handle({
      origin: ORIGIN,
      method: "personal_sign",
      params: [MESSAGE, EVM_ADDRESS],
    });

    const req = h.sign.mock.calls[0]?.[0] as SignRequest;
    expect(req.payload).toBe(MESSAGE);
    expect(req.raw).toEqual([MESSAGE, EVM_ADDRESS]);
  });
});

describe("an account the session never granted", () => {
  const OTHER_EVM = "0xdead000000000000000000000000000000000001";
  const REFUSED = { error: { code: 4100, message: "Account is not in this session" } };

  it("refuses personal_sign for another address", async () => {
    h = harness([session({ family: "evm" })]);

    const out = await h.router.handle({
      origin: ORIGIN,
      method: "personal_sign",
      params: ["0xdeadbeef", OTHER_EVM],
    });

    expect(out).toEqual(REFUSED);
    expect(h.sign).not.toHaveBeenCalled();
  });

  it("refuses eth_sign for another address", async () => {
    h = harness([session({ family: "evm" })]);

    const out = await h.router.handle({
      origin: ORIGIN,
      method: "eth_sign",
      params: [OTHER_EVM, "0xdeadbeef"],
    });

    expect(out).toEqual(REFUSED);
    expect(h.sign).not.toHaveBeenCalled();
  });

  it("refuses a transaction sent from another address", async () => {
    h = harness([session({ family: "evm" })]);

    const out = await h.router.handle({
      origin: ORIGIN,
      method: "eth_sendTransaction",
      params: [{ from: OTHER_EVM, to: EVM_ADDRESS, value: "0x1" }],
    });

    expect(out).toEqual(REFUSED);
    expect(h.sign).not.toHaveBeenCalled();
  });

  it("refuses typed data addressed to another account, in either param order", async () => {
    h = harness([session({ family: "evm" })]);
    const typed = JSON.stringify({ primaryType: "Permit", message: { value: "1" } });

    expect(
      await h.router.handle({
        origin: ORIGIN,
        method: "eth_signTypedData_v4",
        params: [OTHER_EVM, typed],
      }),
    ).toEqual(REFUSED);
    expect(
      await h.router.handle({
        origin: ORIGIN,
        method: "eth_signTypedData_v4",
        params: [typed, OTHER_EVM],
      }),
    ).toEqual(REFUSED);
    expect(h.sign).not.toHaveBeenCalled();
  });

  it("accepts an EVM address that differs only in checksum case", async () => {
    h = harness([session({ family: "evm" })]);

    const out = await h.router.handle({
      origin: ORIGIN,
      method: "personal_sign",
      params: ["0xdeadbeef", EVM_ADDRESS.toUpperCase().replace("0X", "0x")],
    });

    expect(out).toEqual({ result: "0xsigned" });
  });

  it("refuses a Solana account outside the session", async () => {
    h = harness([session({ family: "solana" })]);

    const out = await h.router.handle({
      origin: ORIGIN,
      method: "solana_signTransaction",
      params: [{ tx: [1, 2, 3], account: "SoNotTheGrantedAccount11111111111111111111111" }],
    });

    expect(out).toEqual(REFUSED);
    expect(h.sign).not.toHaveBeenCalled();
  });

  it("compares a Cardano address exactly, case and all", async () => {
    h = harness([session({ family: "cardano", accounts: ["addr1qxyz"] })]);

    const out = await h.router.handle({
      origin: ORIGIN,
      method: "cardano_signData",
      params: [{ address: "ADDR1QXYZ", payload: "0xab" }],
    });

    expect(out).toEqual(REFUSED);
    expect(h.sign).not.toHaveBeenCalled();
  });

  it("refuses a BTC address the page named for itself", async () => {
    h = harness([session({ family: "btc", accounts: ["bc1qgranted"] })], {
      networks: [...NETWORKS, { id: "btc_main", family: "btc", name: "Bitcoin", wire: {} }],
    });

    const out = await h.router.handle({
      origin: ORIGIN,
      method: "btc_signMessage",
      params: [{ message: "hello", address: "bc1qattacker" }],
    });

    expect(out).toEqual(REFUSED);
    expect(h.sign).not.toHaveBeenCalled();
  });
});

describe("solana", () => {
  it("never opens UI for a silent connect with no session", async () => {
    const out = await h.router.handle({
      origin: ORIGIN,
      method: "solana_connect",
      params: [{ silent: true }],
    });

    expect(out).toEqual({ result: null });
    expect(h.connect).not.toHaveBeenCalled();
  });

  it("prompts for an explicit connect and returns address plus public key", async () => {
    h.connect.mockResolvedValue({ accounts: [SOL_ADDRESS], publicKey: [1, 2, 3] });

    const out = await h.router.handle({
      origin: ORIGIN,
      method: "solana_connect",
      params: [{ silent: false }],
    });

    expect(out).toEqual({ result: { address: SOL_ADDRESS, publicKey: [1, 2, 3] } });
  });

  it("clears the session and emits an empty account list on disconnect", async () => {
    h = harness([session({ family: "solana" })]);

    const out = await h.router.handle({ origin: ORIGIN, method: "solana_disconnect" });

    expect(out).toEqual({ result: null });
    expect(await h.sessions.get(ORIGIN, "solana")).toBeNull();
    expect(h.events).toEqual([
      { origin: ORIGIN, event: { family: "solana", event: "accountsChanged", data: [] } },
    ]);
  });
});

describe("concurrency caps", () => {
  it("lets one sign through and refuses the rest", async () => {
    h = harness([session({ family: "evm" })]);
    h.sign.mockImplementation(() => new Promise(() => {}));

    const outcomes = await Promise.all(
      Array.from({ length: 50 }, () =>
        h.router.handle({ origin: ORIGIN, method: "personal_sign", params: [MESSAGE] }),
      ).slice(1),
    );

    expect(h.sign).toHaveBeenCalledTimes(1);
    expect(outcomes).toHaveLength(49);
    expect(outcomes.every((o) => "error" in o && o.error.code === -32005)).toBe(true);
    h.router.rejectAll(ORIGIN);
  });

  it("takes the next prompt once the first is answered", async () => {
    h = harness([session({ family: "evm" })]);

    await h.router.handle({ origin: ORIGIN, method: "personal_sign", params: [MESSAGE] });
    const out = await h.router.handle({ origin: ORIGIN, method: "personal_sign", params: [MESSAGE] });

    expect(out).toEqual({ result: "0xsigned" });
    expect(h.sign).toHaveBeenCalledTimes(2);
  });

  it("counts prompts per origin, not globally", async () => {
    const other = "https://app.aave.com";
    h = harness([session({ family: "evm" }), session({ family: "evm", origin: other })]);
    h.sign.mockImplementation(() => new Promise(() => {}));

    void h.router.handle({ origin: ORIGIN, method: "personal_sign", params: [MESSAGE] });
    void h.router.handle({ origin: other, method: "personal_sign", params: [MESSAGE] });
    await flush();

    expect(h.sign).toHaveBeenCalledTimes(2);
    h.router.rejectAll(ORIGIN);
    h.router.rejectAll(other);
  });

  it("refuses anything at all past maxInFlightPerOrigin", async () => {
    h = harness([session({ family: "evm" })], {
      policy: { maxConcurrentPrompts: 4, maxInFlightPerOrigin: 2 },
    });
    h.sign.mockImplementation(() => new Promise(() => {}));

    void h.router.handle({ origin: ORIGIN, method: "personal_sign", params: [MESSAGE] });
    void h.router.handle({ origin: ORIGIN, method: "personal_sign", params: [MESSAGE] });
    await flush();
    const out = await h.router.handle({ origin: ORIGIN, method: "eth_accounts" });

    expect(out).toEqual({ error: { code: -32005, message: "Request limit exceeded" } });
    h.router.rejectAll(ORIGIN);
  });
});

describe("unknown and unregistered", () => {
  it("answers EIP-1193 4200 for a method it does not know", async () => {
    expect(await h.router.handle({ origin: ORIGIN, method: "eth_nonsense" })).toEqual({
      error: { code: 4200, message: "Unsupported method: eth_nonsense" },
    });
  });

  it("truncates a method name it echoes back", async () => {
    const out = await h.router.handle({ origin: ORIGIN, method: "z".repeat(500) });

    expect((out as { error: { message: string } }).error.message.length).toBeLessThan(100);
  });

  it("answers 4200 for a family the host did not register", async () => {
    expect(await h.router.handle({ origin: ORIGIN, method: "btc_accounts" })).toEqual({
      error: { code: 4200, message: "Unsupported method: btc_accounts" },
    });
  });
});

describe("disconnect and tab close", () => {
  it("clears, emits and rejects everything in flight", async () => {
    h = harness([session({ family: "evm" })]);
    h.sign.mockImplementation(() => new Promise(() => {}));

    const pending = h.router.handle({ origin: ORIGIN, method: "personal_sign", params: [MESSAGE] });
    await h.router.disconnect(ORIGIN, "evm");

    expect(await pending).toEqual({ error: { code: 4001, message: "User rejected the request" } });
    expect(await h.sessions.get(ORIGIN, "evm")).toBeNull();
    expect(h.events).toEqual([
      { origin: ORIGIN, event: { family: "evm", event: "accountsChanged", data: [] } },
      { origin: ORIGIN, event: { family: "evm", event: "disconnect", data: null } },
    ]);
  });

  it("rejectAll answers waiting requests and reports how many", async () => {
    h = harness([session({ family: "evm" })], { policy: { maxConcurrentPrompts: 2 } });
    h.sign.mockImplementation(() => new Promise(() => {}));

    const a = h.router.handle({ origin: ORIGIN, method: "personal_sign", params: [MESSAGE] });
    const b = h.router.handle({ origin: ORIGIN, method: "eth_sign", params: [EVM_ADDRESS, MESSAGE] });

    expect(h.router.rejectAll(ORIGIN)).toBe(2);
    expect(await a).toMatchObject({ error: { code: 4001 } });
    expect(await b).toMatchObject({ error: { code: 4001 } });
    expect(h.router.rejectAll(ORIGIN)).toBe(0);
  });

  it("ignores a connect decision that arrives after rejectAll", async () => {
    let release!: (decision: ConnectDecision) => void;
    h.connect.mockImplementation(
      () =>
        new Promise<ConnectDecision>((resolve) => {
          release = resolve;
        }),
    );

    const pending = h.router.handle({ origin: ORIGIN, method: "eth_requestAccounts" });
    await flush();
    expect(h.router.rejectAll(ORIGIN)).toBe(1);
    release({ accounts: [EVM_ADDRESS] });

    expect(await pending).toMatchObject({ error: { code: 4001 } });
    await flush();
    expect(await h.sessions.get(ORIGIN, "evm")).toBeNull();
    expect(h.events).toEqual([]);
  });

  it("ignores a signature that arrives after disconnect", async () => {
    h = harness([session({ family: "evm" })]);
    let release!: (signature: string) => void;
    h.sign.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );

    const pending = h.router.handle({ origin: ORIGIN, method: "personal_sign", params: [MESSAGE] });
    await flush();
    await h.router.disconnect(ORIGIN, "evm");
    release("0xsigned");

    expect(await pending).toMatchObject({ error: { code: 4001 } });
    await flush();
    // A resurrected session is how a late lastUsedAt write would show up.
    expect(await h.sessions.get(ORIGIN, "evm")).toBeNull();
  });

  it("aborts the signal it handed the modal when the tab closes", async () => {
    h.connect.mockImplementation(() => new Promise<ConnectDecision>(() => {}));

    const pending = h.router.handle({ origin: ORIGIN, method: "eth_requestAccounts" });
    await flush();
    const req = h.connect.mock.calls[0]?.[0] as ConnectRequest;
    expect(req.signal.aborted).toBe(false);

    h.router.rejectAll(ORIGIN);

    expect(req.signal.aborted).toBe(true);
    expect(await pending).toMatchObject({ error: { code: 4001 } });
  });

  it("aborts the signal when the policy timeout fires", async () => {
    vi.useFakeTimers();
    try {
      h = harness([], { policy: { requestTimeoutMs: 1000 } });
      h.connect.mockImplementation(() => new Promise<ConnectDecision>(() => {}));

      const pending = h.router.handle({ origin: ORIGIN, method: "eth_requestAccounts" });
      await vi.advanceTimersByTimeAsync(0);
      const req = h.connect.mock.calls[0]?.[0] as ConnectRequest;
      await vi.advanceTimersByTimeAsync(1000);

      expect(req.signal.aborted).toBe(true);
      expect(await pending).toMatchObject({ error: { code: 4001 } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits disconnect when the store reports a session that ended elsewhere", async () => {
    h = harness([session({ family: "evm" })]);

    await h.sessions.clear(ORIGIN, "evm");

    expect(h.events).toEqual([
      { origin: ORIGIN, event: { family: "evm", event: "accountsChanged", data: [] } },
      { origin: ORIGIN, event: { family: "evm", event: "disconnect", data: null } },
    ]);
    h.router.dispose();
  });
});
