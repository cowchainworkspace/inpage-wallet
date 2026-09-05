import type { RpcError } from "./errors";
import type { ChainFamily } from "./networks";

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

export type PageToHostEnvelope = { channel: string; direction: "page-to-host" } & PageToHost;
export type HostToPageEnvelope = { channel: string; direction: "host-to-page" } & HostToPage;
export type Envelope = PageToHostEnvelope | HostToPageEnvelope;

export function pageToHost(channel: string, message: PageToHost): PageToHostEnvelope {
  return { channel, direction: "page-to-host", ...message };
}

export function hostToPage(channel: string, message: HostToPage): HostToPageEnvelope {
  return { channel, direction: "host-to-page", ...message };
}

function isEnvelopeShape(value: unknown, channel: string, direction: Direction): boolean {
  if (!value || typeof value !== "object") return false;
  const env = value as { channel?: unknown; direction?: unknown; kind?: unknown };
  return env.channel === channel && env.direction === direction && typeof env.kind === "string";
}

export function isPageToHost(value: unknown, channel: string): value is PageToHostEnvelope {
  return isEnvelopeShape(value, channel, "page-to-host");
}

export function isHostToPage(value: unknown, channel: string): value is HostToPageEnvelope {
  return isEnvelopeShape(value, channel, "host-to-page");
}
