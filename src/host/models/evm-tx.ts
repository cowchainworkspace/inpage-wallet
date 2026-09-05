/** What a confirmation sheet needs from an EVM transaction, without an ABI decoder. */
export type EvmTxSummary = {
  from: string | null;
  to: string | null;
  /** Hex wei, "0x0" when the dApp omitted it. */
  value: string;
  /** Calldata size in bytes; 0 is a plain transfer. */
  dataLength: number;
  data: string | null;
  chainId: string | null;
};

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
  };
}
