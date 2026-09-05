import {
  hostToPage,
  type HostToPage,
  type HostToPageEnvelope,
  type PageToHostEnvelope,
} from "../../src/protocol/envelope";
import type { PageTransport } from "../../src/inpage/core/transport";
import type { InjectedConfig } from "../../src/inpage/core/config";
import type { NetworkDef } from "../../src/protocol/networks";

export const IDENTITY = {
  name: "Example Wallet",
  rdns: "com.example.wallet",
  uuid: "11111111-2222-4333-8444-555555555555",
};

export const NETWORKS: Record<string, NetworkDef> = {
  evm: { id: "1", family: "evm", name: "Ethereum", wire: { evmChainId: "0x1", caip2: "eip155:1" } },
  solana: {
    id: "sol_mainnet",
    family: "solana",
    name: "Solana",
    wire: { walletStandardChain: "solana:mainnet" },
  },
  cardano: { id: "ada_mainnet", family: "cardano", name: "Cardano", wire: { cardanoNetworkId: 1 } },
  tron: { id: "tron_shasta", family: "tron", name: "Tron Shasta", wire: {} },
  xrp: { id: "xrpl_main", family: "xrp", name: "XRPL", wire: { walletStandardChain: "xrpl:0" } },
  btc: {
    id: "btc_mainnet",
    family: "btc",
    name: "Bitcoin",
    wire: { walletStandardChain: "bitcoin:mainnet" },
  },
};

export function configFor(families: (keyof typeof NETWORKS)[]): InjectedConfig {
  return {
    identity: IDENTITY,
    networks: families.map((f) => {
      const net = NETWORKS[f];
      if (!net) throw new Error(`no fixture network for ${f}`);
      return net;
    }),
  };
}

export type FakeTransport = PageTransport & {
  sent: PageToHostEnvelope[];
  /** Everything the page asked for, oldest first. */
  requests(): { id: string; method: string; params?: unknown[] }[];
  lastRequest(): { id: string; method: string; params?: unknown[] };
  deliver(message: HostToPage): void;
  /** Answer the newest outstanding request. */
  respond(result: unknown): void;
  fail(error: { code: number; message: string }): void;
};

export function fakeTransport(channel: string): FakeTransport {
  const sent: PageToHostEnvelope[] = [];
  const handlers: ((env: HostToPageEnvelope) => void)[] = [];

  const requests = (): { id: string; method: string; params?: unknown[] }[] =>
    sent.filter((e): e is PageToHostEnvelope & { kind: "request" } => e.kind === "request");

  const lastRequest = (): { id: string; method: string; params?: unknown[] } => {
    const all = requests();
    const last = all[all.length - 1];
    if (!last) throw new Error("no request was sent");
    return last;
  };

  const deliver = (message: HostToPage): void => {
    const env = hostToPage(channel, message);
    for (const handler of handlers) handler(env);
  };

  return {
    sent,
    requests,
    lastRequest,
    deliver,
    post: (env) => {
      sent.push(env);
    },
    onMessage: (handler) => {
      handlers.push(handler);
    },
    respond: (result) => deliver({ kind: "response", id: lastRequest().id, result }),
    fail: (error) => deliver({ kind: "response", id: lastRequest().id, error }),
  };
}
