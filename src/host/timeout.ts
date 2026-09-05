import { RPC_USER_REJECTED, rpcError, type RpcError } from "../protocol/errors";

/** A request the host can settle early: a closed tab, a revoked session. */
export type Cancellable = { cancel(reason: RpcError): void };

export const TIMED_OUT: RpcError = rpcError(
  RPC_USER_REJECTED,
  "Request timed out without an answer",
);

/**
 * A wait on a UI callback can never outlive the policy timeout — a modal nobody
 * answers would otherwise leave the page hanging forever.
 */
export function withTimeout<T>(work: () => Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (apply: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      apply();
    };
    const timer = setTimeout(() => finish(() => reject(TIMED_OUT)), timeoutMs);

    let started: Promise<T>;
    try {
      started = work();
    } catch (error) {
      finish(() => reject(error));
      return;
    }
    started.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}
