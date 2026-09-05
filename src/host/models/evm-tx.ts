/**
 * What a confirmation sheet needs from an EVM transaction, without an ABI decoder.
 * Presence is modelled, never dropped: a field the sheet does not show is a field
 * the user did not agree to.
 */
export type EvmTxSummary = {
  from: string | null;
  to: string | null;
  /** Hex wei, "0x0" when the dApp omitted it. */
  value: string;
  /** Calldata size in bytes; 0 is a plain transfer. */
  dataLength: number;
  data: string | null;
  chainId: string | null;
  gas: string | null;
  gasPrice: string | null;
  maxFeePerGas: string | null;
  maxPriorityFeePerGas: string | null;
  nonce: string | null;
  type: string | null;
  /**
   * EIP-7702 delegations. A non-empty list hands the account's code to a
   * contract: it is the whole account, not one transfer.
   */
  authorizationList: unknown[] | null;
  /** Every key of the request this model does not cover, in the order sent. */
  unknownFields: string[];
};

const MODELLED: ReadonlySet<string> = new Set([
  "from",
  "to",
  "value",
  "data",
  "input",
  "chainId",
  "gas",
  "gasPrice",
  "maxFeePerGas",
  "maxPriorityFeePerGas",
  "nonce",
  "type",
  "authorizationList",
]);

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function byteLength(data: string | null): number {
  if (!data) return 0;
  const body = data.startsWith("0x") ? data.slice(2) : data;
  return Math.floor(body.length / 2);
}

export function summarizeEvmTx(raw: unknown, chainId?: string | null): EvmTxSummary {
  const tx = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const data = str(tx.data) ?? str(tx.input);
  return {
    from: str(tx.from),
    to: str(tx.to),
    value: str(tx.value) ?? "0x0",
    dataLength: byteLength(data),
    data,
    chainId: str(tx.chainId) ?? chainId ?? null,
    gas: str(tx.gas),
    gasPrice: str(tx.gasPrice),
    maxFeePerGas: str(tx.maxFeePerGas),
    maxPriorityFeePerGas: str(tx.maxPriorityFeePerGas),
    nonce: str(tx.nonce),
    type: str(tx.type),
    authorizationList: Array.isArray(tx.authorizationList) ? tx.authorizationList : null,
    unknownFields: Object.keys(tx).filter((key) => !MODELLED.has(key)),
  };
}
