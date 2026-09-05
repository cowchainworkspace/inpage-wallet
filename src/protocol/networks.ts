/** One family per dApp-facing provider standard the package can speak. */
export type ChainFamily = "evm" | "solana" | "cardano" | "tron" | "xrp" | "btc";

export const CHAIN_FAMILIES: readonly ChainFamily[] = [
  "evm",
  "solana",
  "cardano",
  "tron",
  "xrp",
  "btc",
];

export function isChainFamily(value: unknown): value is ChainFamily {
  return typeof value === "string" && (CHAIN_FAMILIES as readonly string[]).includes(value);
}

/** What each dApp-facing standard needs on the wire for a given network. */
export type NetworkWire = {
  /** Hex, for eth_chainId and EIP-3326. */
  evmChainId?: string | undefined;
  /** Wallet Standard moniker, e.g. "solana:mainnet" or "bitcoin:testnet". */
  walletStandardChain?: string | undefined;
  cardanoNetworkId?: 0 | 1 | undefined;
  /** CAIP-2, surfaced in parsed models and events. */
  caip2?: string | undefined;
};

/** A network the host registers. Ids are the host's own, never the package's. */
export type NetworkDef = {
  id: string;
  family: ChainFamily;
  name: string;
  wire: NetworkWire;
};

export function networkById(
  networks: readonly NetworkDef[],
  id: string | undefined,
): NetworkDef | null {
  if (!id) return null;
  return networks.find((n) => n.id === id) ?? null;
}

export function networkByEvmChainId(
  networks: readonly NetworkDef[],
  chainId: string | undefined,
): NetworkDef | null {
  if (!chainId) return null;
  const wanted = chainId.toLowerCase();
  return (
    networks.find((n) => n.family === "evm" && n.wire.evmChainId?.toLowerCase() === wanted) ?? null
  );
}

export function networksFor(
  networks: readonly NetworkDef[],
  family: ChainFamily,
): NetworkDef[] {
  return networks.filter((n) => n.family === family);
}

/**
 * The network that answers before a session exists. `preferred` is the host's
 * `defaultNetwork` map; the first registered network of the family otherwise.
 */
export function defaultNetworkFor(
  networks: readonly NetworkDef[],
  family: ChainFamily,
  preferred?: Partial<Record<ChainFamily, string>>,
): NetworkDef | null {
  const wanted = preferred?.[family];
  if (wanted) {
    const hit = networks.find((n) => n.id === wanted && n.family === family);
    if (hit) return hit;
  }
  return networks.find((n) => n.family === family) ?? null;
}

export function familiesOf(networks: readonly NetworkDef[]): ChainFamily[] {
  const seen: ChainFamily[] = [];
  for (const n of networks) if (!seen.includes(n.family)) seen.push(n.family);
  return seen;
}
