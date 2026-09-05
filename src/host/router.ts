import type { ProviderEvent } from "../protocol/envelope";
import {
  RPC_CHAIN_NOT_ADDED,
  RPC_INTERNAL,
  rpcError,
  toRpcError,
  unauthorized,
  unsupportedMethod,
  userRejected,
  type RpcError,
} from "../protocol/errors";
import type { ChainFamily, NetworkDef } from "../protocol/networks";
import { defaultNetworkFor, networkByEvmChainId, networkById } from "../protocol/networks";
import type { Session } from "../protocol/session";
import { classifyForHost, type ReadRpcPolicy } from "./classify";
import { parseTypedData, type Eip712Tree } from "./models/eip712";
import { summarizeEvmTx, type EvmTxSummary } from "./models/evm-tx";
import type { SessionStore } from "./session-store";
import { withTimeout, type Cancellable } from "./timeout";

export type RouterOutcome = { result: unknown } | { error: RpcError };

export type ConnectRequest = {
  origin: string;
  family: ChainFamily;
  method: string;
  /** The network that will back the session unless the decision names another. */
  network: NetworkDef | null;
  raw: unknown[];
};

export type ConnectDecision = {
  accounts: string[];
  /** A NetworkDef.id; the family default when omitted. */
  networkId?: string;
  walletId?: string;
  /** Account public key bytes, JSON-safe. Solana and BTC surface it to the page. */
  publicKey?: number[];
  /** BTC only, e.g. "p2wpkh". */
  addressType?: string;
};

export type SwitchChainRequest = {
  origin: string;
  method: string;
  /** The hex chain id the dApp asked for. */
  chainId: string;
  /** The registered network it resolves to, or null when unknown. */
  network: NetworkDef | null;
  session: Session | null;
  raw: unknown[];
};

export type AddChainRequest = {
  origin: string;
  method: string;
  chainId: string;
  raw: unknown[];
};

type SignBase = {
  origin: string;
  session: Session;
  network: NetworkDef | null;
  raw: unknown[];
};

export type SignRequest =
  | (SignBase & {
      family: "evm";
      method: "eth_signTypedData" | "eth_signTypedData_v3" | "eth_signTypedData_v4";
      typedData: Eip712Tree | null;
    })
  | (SignBase & {
      family: "evm";
      method: "eth_sendTransaction" | "eth_signTransaction";
      tx: EvmTxSummary;
    })
  | (SignBase & { family: "evm"; method: "personal_sign" | "eth_sign"; message: string })
  | (SignBase & {
      family: "solana";
      method: "solana_signTransaction" | "solana_signAndSendTransaction";
      txBytes: number[];
      account: string;
    })
  | (SignBase & {
      family: "solana";
      method: "solana_signMessage";
      messageBytes: number[];
      account: string;
    })
  | (SignBase & { family: "cardano"; method: "cardano_signTx"; tx: string; partialSign: boolean })
  | (SignBase & {
      family: "cardano";
      method: "cardano_signData";
      address: string;
      payload: string;
    })
  | (SignBase & { family: "tron"; method: "tron_signTransaction"; transaction: unknown })
  | (SignBase & { family: "tron"; method: "tron_signMessage"; message: string })
  | (SignBase & {
      family: "xrp";
      method: "xrpl_signTransaction";
      txJson: Record<string, unknown>;
      submit: boolean;
    })
  | (SignBase & { family: "xrp"; method: "xrpl_signMessage"; message: string })
  | (SignBase & { family: "btc"; method: "btc_signPsbt"; psbt: string })
  | (SignBase & { family: "btc"; method: "btc_signMessage"; message: string });

export type UiHandlers = {
  /** Resolve with the granted accounts, or null when the user declines. */
  connect(req: ConnectRequest): Promise<ConnectDecision | null>;
  /** Resolve with the signature / signed bytes / tx hash, or throw an RpcError. */
  sign(req: SignRequest): Promise<unknown>;
  /** Default: switch silently when the chain is registered, 4902 otherwise. */
  switchChain?(req: SwitchChainRequest): Promise<boolean>;
  /** Default: 4902. Return a NetworkDef to register it and complete the switch. */
  addChain?(req: AddChainRequest): Promise<NetworkDef | null>;
};

export type RpcRequest = {
  family: ChainFamily;
  networkId: string;
  /** Hex chain id for EVM networks, so an EIP-1193 client can use it directly. */
  chainId: string | null;
  method: string;
  params: unknown[];
};

export type RpcClient = (req: RpcRequest) => Promise<unknown>;

export type Policy = {
  readRpc?: ReadRpcPolicy;
  /** Answer a connect from an existing session without opening UI. Default true. */
  silentReconnect?: boolean;
  requestTimeoutMs?: number;
  /** Hex ids. Default: every registered EVM network. */
  supportedEvmChainIds?: ReadonlySet<string>;
};

export type RouterDeps = {
  networks: NetworkDef[];
  sessions: SessionStore;
  ui: UiHandlers;
  rpc?: RpcClient;
  emit(origin: string, event: ProviderEvent): void;
  policy?: Policy;
};

export type ProviderRequest = {
  origin: string;
  method: string;
  params?: unknown[];
};

export interface DappRouter {
  handle(req: ProviderRequest): Promise<RouterOutcome>;
  /** Clears the session, emits, and rejects everything in flight for it. */
  disconnect(origin: string, family: ChainFamily): Promise<void>;
  /** On tab close. Returns how many waiting requests were answered. */
  rejectAll(origin: string): number;
  /** Stops listening to the session store. */
  dispose(): void;
}

const DEFAULT_TIMEOUT_MS = 120_000;

function firstParam<T>(params: unknown[]): T | undefined {
  return params[0] as T | undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asBytes(value: unknown): number[] {
  return Array.isArray(value) ? (value as number[]) : [];
}

export function createDappRouter(deps: RouterDeps): DappRouter {
  const networks: NetworkDef[] = [...deps.networks];
  const policy = deps.policy ?? {};
  const readRpc: ReadRpcPolicy = policy.readRpc ?? "allowlist";
  const silentReconnect = policy.silentReconnect !== false;
  const timeoutMs = policy.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  const inFlight = new Map<string, Set<Cancellable>>();
  const connecting = new Map<string, Promise<RouterOutcome>>();

  const track = (origin: string) => (control: Cancellable) => {
    let set = inFlight.get(origin);
    if (!set) {
      set = new Set();
      inFlight.set(origin, set);
    }
    set.add(control);
  };

  const untrack = (origin: string) => (control: Cancellable) => {
    const set = inFlight.get(origin);
    if (!set) return;
    set.delete(control);
    if (set.size === 0) inFlight.delete(origin);
  };

  const decide = <T>(_origin: string, work: () => Promise<T>): Promise<T> =>
    withTimeout(work, timeoutMs);

  /**
   * Every request is registered from the moment it arrives, not from the moment
   * it reaches the modal: a tab closing mid-lookup must still get an answer.
   */
  function guard(origin: string, work: () => Promise<RouterOutcome>): Promise<RouterOutcome> {
    return new Promise<RouterOutcome>((resolve) => {
      let settled = false;
      const finish = (outcome: RouterOutcome): void => {
        if (settled) return;
        settled = true;
        untrack(origin)(control);
        resolve(outcome);
      };
      const control: Cancellable = { cancel: (reason) => finish({ error: reason }) };
      track(origin)(control);
      work().then(
        (outcome) => finish(outcome),
        (error: unknown) => finish({ error: toRpcError(error) }),
      );
    });
  }

  const familyRegistered = (family: ChainFamily): boolean =>
    networks.some((n) => n.family === family);

  const defaultNetwork = (family: ChainFamily): NetworkDef | null =>
    defaultNetworkFor(networks, family);

  const networkOf = (session: Session | null, family: ChainFamily): NetworkDef | null =>
    (session ? networkById(networks, session.networkId) : null) ?? defaultNetwork(family);

  const emitFor = (origin: string, family: ChainFamily, event: ProviderEvent["event"], data: unknown): void => {
    deps.emit(origin, { family, event, data });
  };

  // --- read-only ------------------------------------------------------------

  function answerReadOnly(method: string, session: Session | null, network: NetworkDef | null): RouterOutcome {
    const accounts = session?.accounts ?? [];
    switch (method) {
      case "eth_chainId":
        return { result: network?.wire.evmChainId ?? "0x0" };
      case "net_version":
        return { result: String(parseInt(network?.wire.evmChainId ?? "0x0", 16)) };
      case "eth_accounts":
      case "cardano_getUsedAddresses":
      case "tron_accounts":
      case "xrpl_accounts":
      case "btc_accounts":
        return { result: accounts };
      case "wallet_getPermissions":
        return { result: session ? [{ parentCapability: "eth_accounts" }] : [] };
      case "cardano_isEnabled":
        return { result: accounts.length > 0 };
      case "cardano_getNetworkId":
        return { result: network?.wire.cardanoNetworkId ?? 0 };
      case "cardano_getChangeAddress":
        return { result: accounts[0] ?? null };
      default:
        // cardano_getUnusedAddresses, cardano_getRewardAddresses
        return { result: [] };
    }
  }

  // --- connect --------------------------------------------------------------

  function connectResult(family: ChainFamily, session: Session, network: NetworkDef | null): unknown {
    switch (family) {
      case "evm":
        return session.accounts;
      case "solana": {
        const address = session.accounts[0];
        if (!address) return null;
        return { address, publicKey: session.publicKey ?? [] };
      }
      case "cardano":
        return { networkId: network?.wire.cardanoNetworkId ?? 0 };
      case "btc": {
        const address = session.accounts[0];
        if (!address) return null;
        return {
          address,
          publicKey: session.publicKey ?? [],
          addressType: session.addressType ?? null,
        };
      }
      default: {
        const address = session.accounts[0];
        return address ? { address } : null;
      }
    }
  }

  async function runConnect(
    origin: string,
    family: ChainFamily,
    method: string,
    params: unknown[],
  ): Promise<RouterOutcome> {
    const existing = await deps.sessions.get(origin, family);
    if (silentReconnect && existing && existing.accounts.length > 0) {
      return { result: connectResult(family, existing, networkOf(existing, family)) };
    }

    // An eager reconnect must never open UI when there is nothing to reconnect to.
    const silent = Boolean(firstParam<{ silent?: boolean }>(params)?.silent);
    if (silent) return { result: null };

    const fallback = defaultNetwork(family);
    const decision = await decide(origin, () =>
      deps.ui.connect({ origin, family, method, network: fallback, raw: params }),
    );
    if (!decision || decision.accounts.length === 0) return { error: userRejected() };

    const chosen = networkById(networks, decision.networkId) ?? fallback;
    if (!chosen) {
      return { error: rpcError(RPC_INTERNAL, `No ${family} network is registered`) };
    }

    const now = Date.now();
    const session: Session = {
      origin,
      family,
      networkId: chosen.id,
      accounts: decision.accounts,
      createdAt: existing?.createdAt ?? now,
      lastUsedAt: now,
    };
    if (existing?.id !== undefined) session.id = existing.id;
    if (decision.walletId !== undefined) session.walletId = decision.walletId;
    if (decision.publicKey !== undefined) session.publicKey = decision.publicKey;
    if (decision.addressType !== undefined) session.addressType = decision.addressType;

    await deps.sessions.set(session);
    emitFor(origin, family, "accountsChanged", session.accounts);
    return { result: connectResult(family, session, chosen) };
  }

  /** Two connect prompts for one origin and family would be two modals. */
  function connect(
    origin: string,
    family: ChainFamily,
    method: string,
    params: unknown[],
  ): Promise<RouterOutcome> {
    const key = `${origin}|${family}`;
    const running = connecting.get(key);
    if (running) return running;
    const started = runConnect(origin, family, method, params).finally(() => {
      connecting.delete(key);
    });
    connecting.set(key, started);
    return started;
  }

  // --- switch ---------------------------------------------------------------

  async function switchChain(
    origin: string,
    method: string,
    params: unknown[],
  ): Promise<RouterOutcome> {
    const target = firstParam<{ chainId?: string }>(params)?.chainId?.toLowerCase();
    if (!target) return { error: rpcError(RPC_CHAIN_NOT_ADDED, "Unrecognized chain ID") };

    const supported = policy.supportedEvmChainIds;
    if (supported && !supported.has(target)) {
      return { error: rpcError(RPC_CHAIN_NOT_ADDED, "Unrecognized chain ID") };
    }

    const session = await deps.sessions.get(origin, "evm");
    let network = networkByEvmChainId(networks, target);

    if (!network) {
      if (!deps.ui.addChain) {
        return { error: rpcError(RPC_CHAIN_NOT_ADDED, "Unrecognized chain ID") };
      }
      const askToAdd = deps.ui.addChain;
      const added = await decide(origin, () =>
        askToAdd({ origin, method, chainId: target, raw: params }),
      );
      if (!added) return { error: rpcError(RPC_CHAIN_NOT_ADDED, "Unrecognized chain ID") };
      networks.push(added);
      network = added;
    }

    const askToSwitch = deps.ui.switchChain;
    if (askToSwitch) {
      const resolved = network;
      const approved = await decide(origin, () =>
        askToSwitch({ origin, method, chainId: target, network: resolved, session, raw: params }),
      );
      if (!approved) return { error: userRejected() };
    }

    if (session && session.networkId !== network.id) {
      await deps.sessions.set({ ...session, networkId: network.id, lastUsedAt: Date.now() });
      emitFor(origin, "evm", "chainChanged", network.wire.evmChainId ?? target);
    }
    return { result: null };
  }

  // --- sign -----------------------------------------------------------------

  function buildSignRequest(
    method: string,
    base: SignBase,
    params: unknown[],
  ): SignRequest | null {
    const p0 = asRecord(params[0]);
    switch (method) {
      case "eth_signTypedData":
      case "eth_signTypedData_v3":
      case "eth_signTypedData_v4": {
        // Wallets receive [address, json]; a few dApps still send [json, address].
        const candidate = typeof params[1] === "string" ? params[1] : params[0];
        return { ...base, family: "evm", method, typedData: parseTypedData(candidate) };
      }
      case "eth_sendTransaction":
      case "eth_signTransaction":
        return {
          ...base,
          family: "evm",
          method,
          tx: summarizeEvmTx(params[0], base.network?.wire.evmChainId ?? null),
        };
      case "personal_sign":
        return { ...base, family: "evm", method, message: asString(params[0]) };
      case "eth_sign":
        return { ...base, family: "evm", method, message: asString(params[1]) };
      case "solana_signTransaction":
      case "solana_signAndSendTransaction":
        return {
          ...base,
          family: "solana",
          method,
          txBytes: asBytes(p0.tx),
          account: asString(p0.account),
        };
      case "solana_signMessage":
        return {
          ...base,
          family: "solana",
          method,
          messageBytes: asBytes(p0.message),
          account: asString(p0.account),
        };
      case "cardano_signTx":
        return {
          ...base,
          family: "cardano",
          method,
          tx: asString(p0.tx),
          partialSign: Boolean(p0.partialSign),
        };
      case "cardano_signData":
        return {
          ...base,
          family: "cardano",
          method,
          address: asString(p0.address),
          payload: asString(p0.payload),
        };
      case "tron_signTransaction":
        return { ...base, family: "tron", method, transaction: p0.transaction };
      case "tron_signMessage":
        return { ...base, family: "tron", method, message: asString(p0.message) };
      case "xrpl_signTransaction":
        return {
          ...base,
          family: "xrp",
          method,
          txJson: asRecord(p0.tx_json),
          submit: Boolean(p0.submit),
        };
      case "xrpl_signMessage":
        return { ...base, family: "xrp", method, message: asString(p0.message) };
      case "btc_signPsbt":
        return { ...base, family: "btc", method, psbt: asString(p0.psbt) };
      case "btc_signMessage":
        return { ...base, family: "btc", method, message: asString(p0.message) };
      default:
        return null;
    }
  }

  async function sign(
    origin: string,
    family: ChainFamily,
    method: string,
    params: unknown[],
  ): Promise<RouterOutcome> {
    const session = await deps.sessions.get(origin, family);
    if (!session || session.accounts.length === 0) return { error: unauthorized() };

    const request = buildSignRequest(method, {
      origin,
      session,
      network: networkOf(session, family),
      raw: params,
    }, params);
    if (!request) return { error: unsupportedMethod(method) };

    try {
      const result = await decide(origin, () => deps.ui.sign(request));
      await deps.sessions.set({ ...session, lastUsedAt: Date.now() });
      return { result };
    } catch (error) {
      return { error: toRpcError(error) };
    }
  }

  // --- store subscription ---------------------------------------------------

  // The router already emits for clears it performs itself; the subscription is
  // there for the ones it does not know about, such as a backend revoke.
  let selfClearing = 0;
  async function clearSession(origin: string, family: ChainFamily): Promise<void> {
    selfClearing += 1;
    try {
      await deps.sessions.clear(origin, family);
    } finally {
      selfClearing -= 1;
    }
  }

  const unsubscribe = deps.sessions.subscribe?.((change) => {
    if (change.session || selfClearing > 0) return;
    emitFor(change.origin, change.family, "accountsChanged", []);
    emitFor(change.origin, change.family, "disconnect", null);
  });

  function rejectAll(origin: string): number {
    const set = inFlight.get(origin);
    if (!set) return 0;
    const doomed = [...set];
    inFlight.delete(origin);
    for (const control of doomed) control.cancel(userRejected());
    return doomed.length;
  }

  async function route(req: ProviderRequest): Promise<RouterOutcome> {
    const params = req.params ?? [];
    const { kind, family } = classifyForHost(req.method, readRpc);

    if (kind === "unsupported" || !familyRegistered(family)) {
      return { error: unsupportedMethod(req.method) };
    }

    switch (kind) {
      case "readOnly": {
        const session = await deps.sessions.get(req.origin, family);
        return answerReadOnly(req.method, session, networkOf(session, family));
      }
      case "readRpc": {
        if (!deps.rpc) return { error: unsupportedMethod(req.method) };
        const session = await deps.sessions.get(req.origin, family);
        const network = networkOf(session, family);
        if (!network) return { error: unsupportedMethod(req.method) };
        try {
          return {
            result: await deps.rpc({
              family,
              networkId: network.id,
              chainId: network.wire.evmChainId ?? null,
              method: req.method,
              params,
            }),
          };
        } catch (error) {
          return {
            error: rpcError(
              RPC_INTERNAL,
              error instanceof Error ? error.message : "RPC request failed",
            ),
          };
        }
      }
      case "connect":
        return connect(req.origin, family, req.method, params);
      case "disconnect":
        await clearSession(req.origin, family);
        emitFor(req.origin, family, "accountsChanged", []);
        return { result: null };
      case "switch":
        return switchChain(req.origin, req.method, params);
      case "sign":
        return sign(req.origin, family, req.method, params);
    }
  }

  return {
    handle(req) {
      return guard(req.origin, () => route(req));
    },

    async disconnect(origin, family) {
      rejectAll(origin);
      await clearSession(origin, family);
      emitFor(origin, family, "accountsChanged", []);
      emitFor(origin, family, "disconnect", null);
    },

    rejectAll,

    dispose() {
      unsubscribe?.();
    },
  };
}
