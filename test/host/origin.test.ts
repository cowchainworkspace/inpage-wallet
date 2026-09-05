import { describe, expect, it } from "vitest";

import { nextCommittedOrigin, originOf } from "../../src/host/origin";

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
