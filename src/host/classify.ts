import {
  classify,
  DEFAULT_READ_RPC_METHODS,
  familyOf,
  type MethodKind,
} from "../protocol/methods";
import type { ChainFamily } from "../protocol/networks";

/** `"allowlist"` is the package's default set; a set of your own replaces it. */
export type ReadRpcPolicy = "allowlist" | "none" | ReadonlySet<string>;

export function readRpcAllows(policy: ReadRpcPolicy, method: string): boolean {
  if (policy === "none") return false;
  if (policy === "allowlist") return DEFAULT_READ_RPC_METHODS.has(method);
  return policy.has(method);
}

/**
 * What the router will do with a method, once the host's read-RPC policy is
 * applied: a read the policy refuses is not a read, it is unsupported.
 */
export function classifyForHost(
  method: string,
  policy: ReadRpcPolicy,
): { kind: MethodKind; family: ChainFamily } {
  const kind = classify(method);
  const family = familyOf(method);
  if (kind === "readRpc" && !readRpcAllows(policy, method)) {
    return { kind: "unsupported", family };
  }
  return { kind, family };
}
