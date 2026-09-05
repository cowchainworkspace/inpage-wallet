import { describe, expect, it } from "vitest";

import { createNonce, nextCommittedNavigation, nextCommittedOrigin, originOf } from "../../src/host/origin";

describe("originOf", () => {
  it("accepts https and drops everything else", () => {
    expect(originOf("https://app.uniswap.org/swap?a=1")).toBe("https://app.uniswap.org");
    expect(originOf("http://app.uniswap.org")).toBeNull();
    expect(originOf("file:///etc/passwd")).toBeNull();
    expect(originOf("javascript:alert(1)")).toBeNull();
    expect(originOf("not a url")).toBeNull();
  });

  it("keeps the port in the origin", () => {
    expect(originOf("https://localhost:8443/app")).toBe("https://localhost:8443");
  });
});

describe("nextCommittedOrigin", () => {
  const A = "https://app.uniswap.org";
  const B = "https://evil.example";

  it("commits the origin once the navigation lands", () => {
    expect(nextCommittedOrigin(null, { url: `${A}/swap`, loading: false })).toBe(A);
  });

  it("drops the origin while navigating to a different one", () => {
    // The window where evil.example's injected script runs but its navigation has
    // not committed: it must not inherit uniswap's session.
    expect(nextCommittedOrigin(A, { url: `${B}/`, loading: true })).toBeNull();
  });

  it("keeps the origin while navigating within the same site", () => {
    expect(nextCommittedOrigin(A, { url: `${A}/pool`, loading: true })).toBe(A);
  });

  it("drops the origin when a load starts on a non-https url", () => {
    expect(nextCommittedOrigin(A, { url: "about:blank", loading: true })).toBeNull();
  });

  it("clears the origin when a non-https navigation commits", () => {
    expect(nextCommittedOrigin(A, { url: "about:blank", loading: false })).toBeNull();
  });
});

describe("createNonce", () => {
  it("does not repeat itself", () => {
    const seen = new Set(Array.from({ length: 64 }, () => createNonce()));

    expect(seen.size).toBe(64);
    expect([...seen].every((n) => n.length >= 16)).toBe(true);
  });
});

describe("nextCommittedNavigation", () => {
  const A = "https://app.uniswap.org";
  const B = "https://evil.example";

  it("commits origin and nonce together", () => {
    const next = nextCommittedNavigation(null, { url: `${A}/swap`, loading: false }, "n1");

    expect(next).toEqual({ origin: A, nonce: "n1" });
  });

  it("mints a nonce when the host did not supply one", () => {
    const next = nextCommittedNavigation(null, { url: A, loading: false });

    expect(next?.nonce).toBeTypeOf("string");
    expect(next?.nonce.length).toBeGreaterThan(0);
  });

  it("keeps the pair while navigating within the same site", () => {
    const current = { origin: A, nonce: "n1" };

    expect(nextCommittedNavigation(current, { url: `${A}/pool`, loading: true }, "n2")).toBe(current);
  });

  it("has no attribution at all while a cross-origin navigation is in flight", () => {
    expect(nextCommittedNavigation({ origin: A, nonce: "n1" }, { url: B, loading: true })).toBeNull();
  });

  it("gives the next document its own nonce", () => {
    const first = nextCommittedNavigation(null, { url: A, loading: false });
    const inFlight = nextCommittedNavigation(first, { url: B, loading: true });
    const second = nextCommittedNavigation(inFlight, { url: B, loading: false });

    expect(second?.origin).toBe(B);
    expect(second?.nonce).not.toBe(first?.nonce);
  });
});
