import type { ProviderEvent } from "../protocol/envelope";
import {
  RPC_CHAIN_NOT_ADDED,
  RPC_INTERNAL,
  RPC_UNAUTHORIZED,
  invalidParams,
  limitExceeded,
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
  /** The session `policy.canReuseSession` declined to reuse silently, if any. */
  existing: Session | null;
  /** Aborts when the request is cancelled or times out: close the modal. */
  signal: AbortSignal;
};

export type ConnectDecision = {
  accounts: string[];
  /** A NetworkDef.id; the family default when omitted. */
  networkId?: string | undefined;
  walletId?: string | undefined;
  /** Account public key bytes, JSON-safe. Solana and BTC surface it to the page. */
  publicKey?: number[] | undefined;
  /** BTC only, e.g. "p2wpkh". */
  addressType?: string | undefined;
  /** With `ConnectRequest.existing` present, keep that session instead of writing a new one. */
  reuse?: boolean | undefined;
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
  /** Aborts when the request is cancelled or times out: close the modal. */
  signal: AbortSignal;
};

/** One signed transaction on its way to the network. Requires a session. */
export type SubmitRequest = {
  origin: string;
  family: ChainFamily;
  method: string;
  session: Session;
  network: NetworkDef | null;
  raw: unknown[];
  /** Aborts when the request is cancelled or times out: close the modal. */
  signal: AbortSignal;
};

export type AddChainRequest = {
  origin: string;
  method: string;
  chainId: string;
  raw: unknown[];
  /** Aborts when the request is cancelled or times out: close the modal. */
  signal: AbortSignal;
};

type SignBase = {
  origin: string;
  session: Session;
  network: NetworkDef | null;
  /**
   * The one value the parsed model was built from. Sign this — never re-derive a
   * payload from `raw`, or a page that sends two candidates gets one rendered
   * and the other signed.
   */
  payload: unknown;
  /** The params as they arrived. Diagnostic only: it is not what was parsed. */
  raw: unknown[];
  /** Aborts when the request is cancelled or times out: close the modal. */
  signal: AbortSignal;
};

export type SignRequest =
  | (SignBase & {
      family: "evm";
      method: "eth_signTypedData" | "eth_signTypedData_v3" | "eth_signTypedData_v4";
      typedData: Eip712Tree;
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
  switchChain?: ((req: SwitchChainRequest) => Promise<boolean>) | undefined;
  /** Default: 4902. Return a NetworkDef to register it and complete the switch. */
  addChain?: ((req: AddChainRequest) => Promise<NetworkDef | null>) | undefined;
  /** Default: forward to `rpc`. Broadcasting is not a read, so it can be gated. */
  submit?: ((req: SubmitRequest) => Promise<unknown>) | undefined;
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
  readRpc?: ReadRpcPolicy | undefined;
  /**
   * Refuse reads for an origin with no session. Default true: an allow-listed
   * read still spends the host's node quota and tells the page the wallet is here.
   */
  readRpcRequiresSession?: boolean | undefined;
  /** Answer a connect from an existing session without opening UI. Default true. */
  silentReconnect?: boolean | undefined;
  /**
   * Called instead of `silentReconnect` when an existing session with accounts is
   * found on a connect. `true` answers from the session with no UI, `false` opens
   * `ui.connect` exactly as if no session existed, with `existing` carrying it.
   * Ignored (falls back to `silentReconnect`) when absent. A throw is treated as
   * `false`.
   */
  canReuseSession?:
    | ((
        session: Session,
        req: { origin: string; family: ChainFamily; method: string; raw: unknown[] },
      ) => boolean | Promise<boolean>)
    | undefined;
  requestTimeoutMs?: number | undefined;
  /** Hex ids. Default: every registered EVM network. */
  supportedEvmChainIds?: ReadonlySet<string> | undefined;
  /**
   * Prompts one origin may have open at once — sign, switch, addChain, submit.
   * Default 1: a second sheet is a second thing to misread. Connect is coalesced
   * and never counted.
   */
  maxConcurrentPrompts?: number | undefined;
  /** Requests of any kind one origin may have waiting. Default 256. */
  maxInFlightPerOrigin?: number | undefined;
};

export type RouterDeps = {
  networks: NetworkDef[];
  sessions: SessionStore;
  ui: UiHandlers;
  rpc?: RpcClient | undefined;
  emit(origin: string, event: ProviderEvent): void;
  policy?: Policy | undefined;
};

export type ProviderRequest = {
  origin: string;
  method: string;
  params?: unknown[] | undefined;
};

export interface DappRouter {
  handle(req: ProviderRequest): Promise<RouterOutcome>;
  /**
   * Add a network every origin can see. A chain accepted through `ui.addChain`
   * is scoped to the origin that asked; this is how a host promotes one.
   */
  registerNetwork(network: NetworkDef): void;
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

function asBytes(value: unknown): number[] {
  return Array.isArray(value) ? (value as number[]) : [];
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * The account the page named for itself. The page picks it freely, so it is a
 * claim, not a fact: it has to be checked against the session before anything
 * reaches the UI, or a dApp can have the wallet sign with an account the user
 * never granted it.
 */
function accountClaimedBy(method: string, params: unknown[]): string | null {
  switch (method) {
    case "personal_sign":
      return nonEmptyString(params[1]);
    case "eth_sign":
      return nonEmptyString(params[0]);
    case "eth_signTypedData":
    case "eth_signTypedData_v3":
    case "eth_signTypedData_v4": {
      // Wallets receive [address, json]; a few dApps still send [json, address].
      const first = nonEmptyString(params[0]);
      if (first && EVM_ADDRESS.test(first)) return first;
      const second = nonEmptyString(params[1]);
      return second && EVM_ADDRESS.test(second) ? second : null;
    }
    case "eth_sendTransaction":
    case "eth_signTransaction":
      return nonEmptyString(asRecord(params[0]).from);
    default: {
      const p0 = asRecord(params[0]);
      return nonEmptyString(p0.account) ?? nonEmptyString(p0.address);
    }
  }
}

/** EVM addresses are case-insensitive; every other family's are not. */
function sessionHasAccount(session: Session, family: ChainFamily, account: string): boolean {
  if (family !== "evm") return session.accounts.includes(account);
  const wanted = account.toLowerCase();
  return session.accounts.some((a) => a.toLowerCase() === wanted);
}

export function createDappRouter(deps: RouterDeps): DappRouter {
  const networks: NetworkDef[] = [...deps.networks];
  const policy = deps.policy ?? {};
  const readRpc: ReadRpcPolicy = policy.readRpc ?? "allowlist";
  const readRpcRequiresSession = policy.readRpcRequiresSession !== false;
  const silentReconnect = policy.silentReconnect !== false;
  const timeoutMs = policy.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxPrompts = policy.maxConcurrentPrompts ?? 1;
  const maxInFlight = policy.maxInFlightPerOrigin ?? 256;

  const inFlight = new Map<string, Set<Cancellable>>();
  const connecting = new Map<string, Promise<RouterOutcome>>();
  const prompts = new Map<string, number>();

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

  const decide = <T>(controller: AbortController, work: () => Promise<T>): Promise<T> =>
    withTimeout(work, timeoutMs, controller);

  /**
   * Every request is registered from the moment it arrives, not from the moment
   * it reaches the modal: a tab closing mid-lookup must still get an answer. The
   * controller is how the answer reaches the UI the request already opened.
   */
  function guard(
    origin: string,
    work: (controller: AbortController) => Promise<RouterOutcome>,
  ): Promise<RouterOutcome> {
    return new Promise<RouterOutcome>((resolve) => {
      const controller = new AbortController();
      let settled = false;
      const finish = (outcome: RouterOutcome): void => {
        if (settled) return;
        settled = true;
        untrack(origin)(control);
        resolve(outcome);
      };
      const control: Cancellable = {
        cancel: (reason) => {
          controller.abort();
          finish({ error: reason });
        },
      };
      track(origin)(control);
      work(controller).then(
        (outcome) => finish(outcome),
        (error: unknown) => finish({ error: toRpcError(error) }),
      );
    });
  }

  /**
   * A chain one origin talked the user into adding is that origin's, not the
   * router's: registering it globally lets any other page switch to a network
   * whose RPC and explorer the first page chose.
   */
  const addedByOrigin = new Map<string, NetworkDef[]>();
  const MAX_ADDED_PER_ORIGIN = 16;

  const visible = (origin: string): NetworkDef[] => {
    const extra = addedByOrigin.get(origin);
    return extra ? [...networks, ...extra] : networks;
  };

  const familyRegistered = (family: ChainFamily): boolean =>
    networks.some((n) => n.family === family);

  const defaultNetwork = (origin: string, family: ChainFamily): NetworkDef | null =>
    defaultNetworkFor(visible(origin), family);

  const networkOf = (
    origin: string,
    session: Session | null,
    family: ChainFamily,
  ): NetworkDef | null =>
    (session ? networkById(visible(origin), session.networkId) : null) ??
    defaultNetwork(origin, family);

  const emitFor = (origin: string, family: ChainFamily, event: ProviderEvent["event"], data: unknown): void => {
    deps.emit(origin, { family, event, data });
  };

  async function callRpc(
    family: ChainFamily,
    network: NetworkDef,
    method: string,
    params: unknown[],
  ): Promise<RouterOutcome> {
    const rpc = deps.rpc;
    if (!rpc) return { error: unsupportedMethod(method) };
    try {
      return {
        result: await rpc({
          family,
          networkId: network.id,
          chainId: network.wire.evmChainId ?? null,
          method,
          params,
        }),
      };
    } catch (error) {
      return {
        error: rpcError(RPC_INTERNAL, error instanceof Error ? error.message : "RPC request failed"),
      };
    }
  }

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

  async function reuseExisting(
    session: Session,
    req: { origin: string; family: ChainFamily; method: string; raw: unknown[] },
  ): Promise<boolean> {
    const hook = policy.canReuseSession;
    if (!hook) return silentReconnect;
    try {
      return await hook(session, req);
    } catch {
      return false;
    }
  }

  async function runConnect(
    origin: string,
    family: ChainFamily,
    method: string,
    params: unknown[],
    controller: AbortController,
  ): Promise<RouterOutcome> {
    const existing = await deps.sessions.get(origin, family);
    if (existing && existing.accounts.length > 0) {
      const reuse = await reuseExisting(existing, { origin, family, method, raw: params });
      if (reuse) {
        return { result: connectResult(family, existing, networkOf(origin, existing, family)) };
      }
    }

    // An eager reconnect must never open UI when there is nothing to reconnect to.
    const silent = Boolean(firstParam<{ silent?: boolean }>(params)?.silent);
    if (silent) return { result: null };

    const fallback = defaultNetwork(origin, family);
    const decision = await decide(controller, () =>
      deps.ui.connect({
        origin,
        family,
        method,
        network: fallback,
        raw: params,
        existing,
        signal: controller.signal,
      }),
    );
    // A decision that arrives after the request was cancelled changes nothing.
    if (controller.signal.aborted) return { error: userRejected() };
    if (!decision || decision.accounts.length === 0) return { error: userRejected() };

    if (decision.reuse && existing) {
      const kept: Session = { ...existing, lastUsedAt: Date.now() };
      await deps.sessions.set(kept);
      return { result: connectResult(family, kept, networkOf(origin, kept, family)) };
    }

    const chosen = networkById(visible(origin), decision.networkId) ?? fallback;
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
    controller: AbortController,
  ): Promise<RouterOutcome> {
    const key = `${origin}|${family}`;
    const running = connecting.get(key);
    if (running) return running;
    const started = runConnect(origin, family, method, params, controller).finally(() => {
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
    controller: AbortController,
  ): Promise<RouterOutcome> {
    const target = firstParam<{ chainId?: string }>(params)?.chainId?.toLowerCase();
    if (!target) return { error: rpcError(RPC_CHAIN_NOT_ADDED, "Unrecognized chain ID") };

    const supported = policy.supportedEvmChainIds;
    if (supported && !supported.has(target)) {
      return { error: rpcError(RPC_CHAIN_NOT_ADDED, "Unrecognized chain ID") };
    }

    // Nothing to switch, and no reason to prompt: an origin that never connected
    // is asking about a chain it has no session on.
    const session = await deps.sessions.get(origin, "evm");
    if (!session || session.accounts.length === 0) {
      return { error: rpcError(RPC_CHAIN_NOT_ADDED, "Unrecognized chain ID") };
    }

    let network = networkByEvmChainId(visible(origin), target);

    if (!network) {
      if (!deps.ui.addChain) {
        return { error: rpcError(RPC_CHAIN_NOT_ADDED, "Unrecognized chain ID") };
      }
      const askToAdd = deps.ui.addChain;
      const added = await decide(controller, () =>
        askToAdd({ origin, method, chainId: target, raw: params, signal: controller.signal }),
      );
      if (controller.signal.aborted) return { error: userRejected() };
      if (!added) return { error: rpcError(RPC_CHAIN_NOT_ADDED, "Unrecognized chain ID") };
      const own = addedByOrigin.get(origin) ?? [];
      if (own.length >= MAX_ADDED_PER_ORIGIN) {
        return { error: rpcError(RPC_CHAIN_NOT_ADDED, "Unrecognized chain ID") };
      }
      addedByOrigin.set(origin, [...own, added]);
      network = added;
    }

    const askToSwitch = deps.ui.switchChain;
    if (askToSwitch) {
      const resolved = network;
      const approved = await decide(controller, () =>
        askToSwitch({
          origin,
          method,
          chainId: target,
          network: resolved,
          session,
          raw: params,
          signal: controller.signal,
        }),
      );
      if (controller.signal.aborted) return { error: userRejected() };
      if (!approved) return { error: userRejected() };
    }

    if (session && session.networkId !== network.id) {
      await deps.sessions.set({ ...session, networkId: network.id, lastUsedAt: Date.now() });
      emitFor(origin, "evm", "chainChanged", network.wire.evmChainId ?? target);
    }
    return { result: null };
  }

  // --- sign -----------------------------------------------------------------

  type SignBuild = { request: SignRequest } | { error: RpcError };

  /**
   * A model built from a value the host cannot point back at is a sheet showing
   * one thing and a signature over another, so every branch either names its
   * payload or refuses. A missing or mistyped param is -32602, never an empty
   * string standing in for one.
   */
  function buildSignRequest(
    method: string,
    base: Omit<SignBase, "payload">,
    params: unknown[],
  ): SignBuild {
    const p0 = asRecord(params[0]);
    const bad = { error: invalidParams(`Invalid params for ${method}`) };
    const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

    switch (method) {
      case "eth_signTypedData":
      case "eth_signTypedData_v3":
      case "eth_signTypedData_v4": {
        // Wallets receive [address, json]; a few dApps still send [json, address].
        const second = typeof params[1] === "string" ? parseTypedData(params[1]) : null;
        const payload = second ? params[1] : params[0];
        const typedData = second ?? parseTypedData(params[0]);
        if (!typedData) return bad;
        return { request: { ...base, payload, family: "evm", method, typedData } };
      }
      case "eth_sendTransaction":
      case "eth_signTransaction": {
        const payload = params[0];
        if (!payload || typeof payload !== "object") return bad;
        return {
          request: {
            ...base,
            payload,
            family: "evm",
            method,
            tx: summarizeEvmTx(payload, base.network?.wire.evmChainId ?? null),
          },
        };
      }
      case "personal_sign": {
        const message = text(params[0]);
        if (message === null) return bad;
        return { request: { ...base, payload: message, family: "evm", method, message } };
      }
      case "eth_sign": {
        const message = text(params[1]);
        if (message === null) return bad;
        return { request: { ...base, payload: message, family: "evm", method, message } };
      }
      case "solana_signTransaction":
      case "solana_signAndSendTransaction": {
        const account = text(p0.account);
        if (!Array.isArray(p0.tx) || account === null) return bad;
        return {
          request: {
            ...base,
            payload: p0.tx,
            family: "solana",
            method,
            txBytes: asBytes(p0.tx),
            account,
          },
        };
      }
      case "solana_signMessage": {
        const account = text(p0.account);
        if (!Array.isArray(p0.message) || account === null) return bad;
        return {
          request: {
            ...base,
            payload: p0.message,
            family: "solana",
            method,
            messageBytes: asBytes(p0.message),
            account,
          },
        };
      }
      case "cardano_signTx": {
        const tx = text(p0.tx);
        if (tx === null) return bad;
        return {
          request: {
            ...base,
            payload: tx,
            family: "cardano",
            method,
            tx,
            partialSign: Boolean(p0.partialSign),
          },
        };
      }
      case "cardano_signData": {
        const address = text(p0.address);
        const payload = text(p0.payload);
        if (address === null || payload === null) return bad;
        // The CIP-30 payload is the signed value: SignBase.payload names the same one.
        return { request: { ...base, family: "cardano", method, address, payload } };
      }
      case "tron_signTransaction": {
        const transaction = p0.transaction;
        if (transaction === undefined || transaction === null) return bad;
        return { request: { ...base, payload: transaction, family: "tron", method, transaction } };
      }
      case "tron_signMessage": {
        const message = text(p0.message);
        if (message === null) return bad;
        return { request: { ...base, payload: message, family: "tron", method, message } };
      }
      case "xrpl_signTransaction": {
        const txJson = p0.tx_json;
        if (!txJson || typeof txJson !== "object") return bad;
        return {
          request: {
            ...base,
            payload: txJson,
            family: "xrp",
            method,
            txJson: asRecord(txJson),
            submit: Boolean(p0.submit),
          },
        };
      }
      case "xrpl_signMessage": {
        const message = text(p0.message);
        if (message === null) return bad;
        return { request: { ...base, payload: message, family: "xrp", method, message } };
      }
      case "btc_signPsbt": {
        const psbt = text(p0.psbt);
        if (psbt === null) return bad;
        return { request: { ...base, payload: psbt, family: "btc", method, psbt } };
      }
      case "btc_signMessage": {
        const message = text(p0.message);
        if (message === null) return bad;
        return { request: { ...base, payload: message, family: "btc", method, message } };
      }
      default:
        return { error: unsupportedMethod(method) };
    }
  }

  async function sign(
    origin: string,
    family: ChainFamily,
    method: string,
    params: unknown[],
    controller: AbortController,
  ): Promise<RouterOutcome> {
    const session = await deps.sessions.get(origin, family);
    if (!session || session.accounts.length === 0) return { error: unauthorized() };

    const claimed = accountClaimedBy(method, params);
    if (claimed !== null && !sessionHasAccount(session, family, claimed)) {
      return { error: rpcError(RPC_UNAUTHORIZED, "Account is not in this session") };
    }

    const built = buildSignRequest(method, {
      origin,
      session,
      network: networkOf(origin, session, family),
      raw: params,
      signal: controller.signal,
    }, params);
    if ("error" in built) return { error: built.error };
    const request = built.request;

    try {
      const result = await decide(controller, () => deps.ui.sign(request));
      if (controller.signal.aborted) return { error: userRejected() };
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

  async function route(
    req: ProviderRequest,
    controller: AbortController,
  ): Promise<RouterOutcome> {
    const params = req.params ?? [];
    const { kind, family } = classifyForHost(req.method, readRpc);

    if (kind === "unsupported" || !familyRegistered(family)) {
      return { error: unsupportedMethod(req.method) };
    }

    switch (kind) {
      case "readOnly": {
        const session = await deps.sessions.get(req.origin, family);
        return answerReadOnly(req.method, session, networkOf(req.origin, session, family));
      }
      case "readRpc": {
        if (!deps.rpc) return { error: unsupportedMethod(req.method) };
        const session = await deps.sessions.get(req.origin, family);
        if (readRpcRequiresSession && (!session || session.accounts.length === 0)) {
          return { error: unauthorized() };
        }
        const network = networkOf(req.origin, session, family);
        if (!network) return { error: unsupportedMethod(req.method) };
        return callRpc(family, network, req.method, params);
      }
      case "submit": {
        const session = await deps.sessions.get(req.origin, family);
        if (!session || session.accounts.length === 0) return { error: unauthorized() };
        const network = networkOf(req.origin, session, family);
        const ask = deps.ui.submit;
        if (ask) {
          const result = await decide(controller, () =>
            ask({
              origin: req.origin,
              family,
              method: req.method,
              session,
              network,
              raw: params,
              signal: controller.signal,
            }),
          );
          if (controller.signal.aborted) return { error: userRejected() };
          return { result };
        }
        if (!deps.rpc || !network) return { error: unsupportedMethod(req.method) };
        return callRpc(family, network, req.method, params);
      }
      case "connect":
        return connect(req.origin, family, req.method, params, controller);
      case "disconnect":
        await clearSession(req.origin, family);
        emitFor(req.origin, family, "accountsChanged", []);
        return { result: null };
      case "switch":
        return switchChain(req.origin, req.method, params, controller);
      case "sign":
        return sign(req.origin, family, req.method, params, controller);
    }
  }

  /** Every kind that opens UI of its own. Connect is coalesced into one prompt. */
  const PROMPT_KINDS: ReadonlySet<string> = new Set(["sign", "switch", "submit"]);

  function releasePrompt(origin: string): void {
    const open = (prompts.get(origin) ?? 1) - 1;
    if (open > 0) prompts.set(origin, open);
    else prompts.delete(origin);
  }

  return {
    // Counted before anything is allocated: a page that fires a thousand signs
    // must not cost a thousand timers, controllers and modals to refuse.
    handle(req) {
      if ((inFlight.get(req.origin)?.size ?? 0) >= maxInFlight) {
        return Promise.resolve({ error: limitExceeded() });
      }
      const { kind } = classifyForHost(req.method, readRpc);
      if (!PROMPT_KINDS.has(kind)) {
        return guard(req.origin, (controller) => route(req, controller));
      }
      const open = prompts.get(req.origin) ?? 0;
      if (open >= maxPrompts) return Promise.resolve({ error: limitExceeded() });
      prompts.set(req.origin, open + 1);
      return guard(req.origin, (controller) => route(req, controller)).finally(() => {
        releasePrompt(req.origin);
      });
    },

    async disconnect(origin, family) {
      rejectAll(origin);
      await clearSession(origin, family);
      emitFor(origin, family, "accountsChanged", []);
      emitFor(origin, family, "disconnect", null);
    },

    rejectAll,

    registerNetwork(network) {
      if (networks.some((n) => n.id === network.id)) return;
      networks.push(network);
    },

    dispose() {
      unsubscribe?.();
    },
  };
}
