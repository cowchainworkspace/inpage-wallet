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
  /** Account public key bytes, JSON-safe. Solana and BTC surface it to the page. */
  publicKey?: number[];
  /** BTC address type, e.g. "p2wpkh". */
  addressType?: string;
  createdAt: number;
  lastUsedAt: number;
};

export function sessionKey(origin: string, family: ChainFamily): string {
  return `${origin}|${family}`;
}
