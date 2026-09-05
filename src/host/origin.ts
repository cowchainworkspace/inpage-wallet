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
