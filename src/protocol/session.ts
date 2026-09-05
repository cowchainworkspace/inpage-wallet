import type { ChainFamily } from "./networks";

/** One dApp connection: an origin, a family, and the accounts granted to it. */
export type Session = {
  origin: string;
  family: ChainFamily;
  /** A NetworkDef.id owned by the host. */
  networkId: string;
  accounts: string[];
  /** Host's wallet / vault reference, opaque to the package. */
  walletId?: string;
  /** Backend session id once persisted remotely. */
  id?: string;
  /** Solana public key bytes, JSON-safe. */
  publicKey?: number[];
  createdAt: number;
  lastUsedAt: number;
};

export function sessionKey(origin: string, family: ChainFamily): string {
  return `${origin}|${family}`;
}
