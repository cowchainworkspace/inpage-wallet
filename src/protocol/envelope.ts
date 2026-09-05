import type { RpcError } from "./errors";
import { isChainFamily, type ChainFamily } from "./networks";

/**
 * Spoken only between a page and a host built from the same package version, so
 * it is never persisted and a major bump moves the suffix with it.
 */
export const DEFAULT_CHANNEL = "inpage-wallet-v1";

export type ProviderEventName = "accountsChanged" | "chainChanged" | "disconnect";

export type ProviderEvent = {
  family: ChainFamily;
  event: ProviderEventName;
  data: unknown;
};

export type PageToHost =
  | { kind: "ready"; families: ChainFamily[] }
  | { kind: "request"; id: string; method: string; params?: unknown[] | undefined };

export type HostToPage =
  | { kind: "init"; icon: string }
  | { kind: "response"; id: string; result?: unknown; error?: RpcError | undefined }
  | ({ kind: "event" } & ProviderEvent);

export type Direction = "page-to-host" | "host-to-page";

/**
 * `n` is the React Native per-document nonce. The preamble stamps it; every
 * other transport leaves it absent.
 */
export type PageToHostEnvelope = {
  channel: string;
  direction: "page-to-host";
  n?: string | undefined;
} & PageToHost;
export type HostToPageEnvelope = { channel: string; direction: "host-to-page" } & HostToPage;
export type Envelope = PageToHostEnvelope | HostToPageEnvelope;

export function pageToHost(channel: string, message: PageToHost): PageToHostEnvelope {
  return { channel, direction: "page-to-host", ...message };
}

export function hostToPage(channel: string, message: HostToPage): HostToPageEnvelope {
  return { channel, direction: "host-to-page", ...message };
}

/** Long enough for a UUID and a namespaced method, short enough not to be a payload. */
const MAX_FIELD = 128;

const EVENT_NAMES: ReadonlySet<string> = new Set([
  "accountsChanged",
  "chainChanged",
  "disconnect",
]);

function isEnvelopeShape(value: unknown, channel: string, direction: Direction): boolean {
  if (!value || typeof value !== "object") return false;
  const env = value as { channel?: unknown; direction?: unknown; kind?: unknown };
  return env.channel === channel && env.direction === direction && typeof env.kind === "string";
}

function bounded(value: unknown, allowEmpty = false): boolean {
  if (typeof value !== "string" || value.length > MAX_FIELD) return false;
  return allowEmpty || value.length > 0;
}

/**
 * Every field is checked, not just the envelope's outline: whatever gets past
 * this is handed to the router, and a `kind` alone says nothing about the rest.
 */
export function isPageToHost(value: unknown, channel: string): value is PageToHostEnvelope {
  if (!isEnvelopeShape(value, channel, "page-to-host")) return false;
  const env = value as Record<string, unknown>;
  if (env.n !== undefined && !bounded(env.n)) return false;
  switch (env.kind) {
    case "ready":
      return Array.isArray(env.families) && env.families.every(isChainFamily);
    case "request":
      return (
        bounded(env.id) &&
        bounded(env.method, true) &&
        (env.params === undefined || Array.isArray(env.params))
      );
    default:
      return false;
  }
}

export function isHostToPage(value: unknown, channel: string): value is HostToPageEnvelope {
  if (!isEnvelopeShape(value, channel, "host-to-page")) return false;
  const env = value as Record<string, unknown>;
  switch (env.kind) {
    case "init":
      return typeof env.icon === "string";
    case "response": {
      if (!bounded(env.id)) return false;
      if (env.error === undefined) return true;
      if (!env.error || typeof env.error !== "object") return false;
      return typeof (env.error as { code?: unknown }).code === "number";
    }
    case "event":
      return isChainFamily(env.family) && typeof env.event === "string" && EVENT_NAMES.has(env.event);
    default:
      return false;
  }
}
