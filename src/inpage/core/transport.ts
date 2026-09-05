import type { HostToPageEnvelope, PageToHostEnvelope } from "../../protocol/envelope";

/** Page side of the boundary: what the injected providers call. */
export interface PageTransport {
  post(env: PageToHostEnvelope): void;
  onMessage(handler: (env: HostToPageEnvelope) => void): void;
}

/** Host side of the boundary: what the router is wired to. */
export interface HostTransport {
  deliver(origin: string, env: HostToPageEnvelope): void;
  onMessage(handler: (origin: string, env: PageToHostEnvelope) => void): void;
}
