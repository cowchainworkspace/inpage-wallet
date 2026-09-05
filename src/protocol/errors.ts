export type RpcError = { code: number; message: string };

/** EIP-1193 / EIP-1474 codes used across every family. */
export const RPC_USER_REJECTED = 4001;
export const RPC_UNAUTHORIZED = 4100;
export const RPC_UNSUPPORTED_METHOD = 4200;
export const RPC_DISCONNECTED = 4900;
export const RPC_CHAIN_NOT_ADDED = 4902;
export const RPC_INVALID_PARAMS = -32602;
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

export function unsupportedMethod(method: string): RpcError {
  return rpcError(RPC_UNSUPPORTED_METHOD, `Unsupported method: ${method}`);
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
