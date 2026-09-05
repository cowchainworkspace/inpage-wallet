export type RpcError = { code: number; message: string };

/** EIP-1193 / EIP-1474 codes used across every family. */
export const RPC_USER_REJECTED = 4001;
export const RPC_UNAUTHORIZED = 4100;
export const RPC_UNSUPPORTED_METHOD = 4200;
export const RPC_DISCONNECTED = 4900;
export const RPC_CHAIN_NOT_ADDED = 4902;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_LIMIT_EXCEEDED = -32005;
export const RPC_INTERNAL = -32603;

export function rpcError(code: number, message: string): RpcError {
  return { code, message };
}

export function userRejected(message = "User rejected the request"): RpcError {
  return rpcError(RPC_USER_REJECTED, message);
}

export function unauthorized(message = "Unauthorized — connect the wallet first"): RpcError {
  return rpcError(RPC_UNAUTHORIZED, message);
}

export function limitExceeded(message = "Request limit exceeded"): RpcError {
  return rpcError(RPC_LIMIT_EXCEEDED, message);
}

export function invalidParams(message = "Invalid params"): RpcError {
  return rpcError(RPC_INVALID_PARAMS, message);
}

/** A method name echoed back is page-controlled text; it does not need to be long. */
function short(method: unknown): string {
  const text = typeof method === "string" ? method : String(method);
  return text.length > 64 ? `${text.slice(0, 64)}…` : text;
}

export function unsupportedMethod(method: string): RpcError {
  return rpcError(RPC_UNSUPPORTED_METHOD, `Unsupported method: ${short(method)}`);
}

/** Anything a UI callback throws becomes an RPC error; a thrown code is preserved. */
export function toRpcError(error: unknown, fallbackMessage = "Request failed"): RpcError {
  if (error && typeof error === "object" && typeof (error as RpcError).code === "number") {
    const known = error as RpcError;
    return rpcError(known.code, known.message ?? fallbackMessage);
  }
  if (error instanceof Error) return rpcError(RPC_INTERNAL, error.message);
  return rpcError(RPC_INTERNAL, fallbackMessage);
}
