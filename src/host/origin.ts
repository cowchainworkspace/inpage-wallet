export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

// A new document's injected script runs before its navigation commits. Holding the
// previous page's origin across that window would let one site's messages be
// attributed to another site's session, so the origin goes null in between and
// requests arriving there are dropped.
export function nextCommittedOrigin(
  current: string | null,
  nav: { url: string; loading: boolean },
): string | null {
  const target = originOf(nav.url);
  if (!nav.loading) return target;
  return target === current ? current : null;
}

/** Unguessable per-document token; the page never gets to read it back. */
export function createNonce(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  if (c && typeof c.getRandomValues === "function") {
    let out = "";
    for (const byte of c.getRandomValues(new Uint8Array(16))) {
      out += byte.toString(16).padStart(2, "0");
    }
    return out;
  }
  return `n-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

/** What the host attributes a message to: an origin and the nonce that proves it. */
export type CommittedNavigation = { origin: string; nonce: string };

/**
 * Origin and nonce move together — a host that commits one without the other has
 * no attribution at all. `nonce` is the one the document about to load was
 * injected with; pass it when the host minted it before starting the load, and a
 * fresh one is generated otherwise. Same-origin navigation keeps the pair.
 */
export function nextCommittedNavigation(
  current: CommittedNavigation | null,
  nav: { url: string; loading: boolean },
  nonce?: string,
): CommittedNavigation | null {
  const origin = nextCommittedOrigin(current?.origin ?? null, nav);
  if (!origin) return null;
  if (current && current.origin === origin) return current;
  return { origin, nonce: nonce ?? createNonce() };
}
