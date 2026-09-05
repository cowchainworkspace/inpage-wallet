export type TypedDataField = {
  path: string;
  label: string;
  /** Absent on the header row that names an enclosing struct or array. */
  value?: string;
  depth: number;
};

export type Eip712Tree = {
  primaryType?: string;
  domain: TypedDataField[];
  message: TypedDataField[];
  truncated: boolean;
};

// A hostile dApp can nest arbitrarily deep or ship thousands of entries; render
// budgets keep the sheet usable instead of freezing on it.
const MAX_DEPTH = 6;
const MAX_FIELDS = 200;

function isLeaf(value: unknown): boolean {
  return value === null || typeof value !== "object";
}

function formatLeaf(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return JSON.stringify(value);
}

function labelFor(path: string): string {
  return path.split(".").pop() ?? path;
}

function flatten(node: unknown, prefix: string, depth: number, out: TypedDataField[]): boolean {
  if (out.length >= MAX_FIELDS) return true;

  if (isLeaf(node)) {
    const path = prefix || "value";
    out.push({ path, label: labelFor(path), value: formatLeaf(node), depth });
    return false;
  }

  if (depth >= MAX_DEPTH) {
    out.push({
      path: prefix,
      label: labelFor(prefix),
      value: Array.isArray(node) ? `[${(node as unknown[]).length} items]` : "{…}",
      depth,
    });
    return true;
  }

  // Without the enclosing struct's own name, `from.wallet` and `to.wallet` both
  // render as "wallet" and the counterparties become indistinguishable.
  if (prefix) out.push({ path: prefix, label: labelFor(prefix), depth });

  const entries: [string, unknown][] = Array.isArray(node)
    ? (node as unknown[]).map((v, i) => [String(i), v])
    : Object.entries(node as Record<string, unknown>);

  let truncated = false;
  for (const [key, value] of entries) {
    if (out.length >= MAX_FIELDS) return true;
    truncated = flatten(value, prefix ? `${prefix}.${key}` : key, depth + 1, out) || truncated;
  }
  return truncated;
}

/**
 * Every leaf of the structure, individually. Typed data must never be rendered as
 * raw JSON or as a summary — a hidden field is how a malicious permit gets signed.
 * Accepts the JSON string dApps usually send, or an already-parsed object.
 */
export function parseTypedData(raw: unknown): Eip712Tree | null {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;

  const root = parsed as Record<string, unknown>;
  const domain: TypedDataField[] = [];
  const message: TypedDataField[] = [];

  const domainTruncated = root.domain ? flatten(root.domain, "", 0, domain) : false;
  const messageTruncated = root.message ? flatten(root.message, "", 0, message) : false;

  if (domain.length === 0 && message.length === 0) return null;

  const primaryType = typeof root.primaryType === "string" ? root.primaryType : undefined;
  const tree: Eip712Tree = {
    domain,
    message,
    truncated: domainTruncated || messageTruncated,
  };
  if (primaryType !== undefined) tree.primaryType = primaryType;
  return tree;
}
