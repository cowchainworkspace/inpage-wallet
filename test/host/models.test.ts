import { describe, expect, it } from "vitest";

import { parseTypedData } from "../../src/host/models/eip712";
import { summarizeEvmTx } from "../../src/host/models/evm-tx";

describe("parseTypedData", () => {
  it("flattens every leaf of domain and message", () => {
    const tree = parseTypedData(
      JSON.stringify({
        primaryType: "Permit",
        domain: { name: "USDC", chainId: 1 },
        message: { owner: "0xabc", details: { amount: "1000", expiry: 99 } },
      }),
    );

    expect(tree?.primaryType).toBe("Permit");
    expect(tree?.domain).toEqual([
      { path: "name", label: "name", value: "USDC", depth: 1 },
      { path: "chainId", label: "chainId", value: "1", depth: 1 },
    ]);
    expect(tree?.message.map((f) => f.path)).toEqual([
      "owner",
      "details",
      "details.amount",
      "details.expiry",
    ]);
    expect(tree?.truncated).toBe(false);
  });

  it("keeps the enclosing struct name so counterparties stay distinguishable", () => {
    const tree = parseTypedData({
      message: { from: { wallet: "0xa" }, to: { wallet: "0xb" } },
    });

    const leaves = tree?.message.filter((f) => f.value !== undefined) ?? [];
    expect(leaves.map((f) => f.path)).toEqual(["from.wallet", "to.wallet"]);
  });

  it("truncates a structure nested past the render budget", () => {
    let node: Record<string, unknown> = { leaf: "deep" };
    for (let i = 0; i < 10; i += 1) node = { nest: node };

    const tree = parseTypedData({ message: node });

    expect(tree?.truncated).toBe(true);
  });

  it("returns null for anything that is not typed data", () => {
    expect(parseTypedData("not json")).toBeNull();
    expect(parseTypedData("null")).toBeNull();
    expect(parseTypedData(JSON.stringify({ types: {} }))).toBeNull();
    expect(parseTypedData(42)).toBeNull();
  });
});

describe("summarizeEvmTx", () => {
  it("summarises a contract call", () => {
    expect(summarizeEvmTx({ from: "0xa", to: "0xb", value: "0x0", data: "0xdeadbeef" }, "0x1")).toEqual(
      {
        from: "0xa",
        to: "0xb",
        value: "0x0",
        dataLength: 4,
        data: "0xdeadbeef",
        chainId: "0x1",
      },
    );
  });

  it("defaults a plain transfer and falls back to the session chain id", () => {
    expect(summarizeEvmTx({ to: "0xb" }, "0x89")).toEqual({
      from: null,
      to: "0xb",
      value: "0x0",
      dataLength: 0,
      data: null,
      chainId: "0x89",
    });
  });

  it("reads calldata from `input` when a dApp uses that name", () => {
    expect(summarizeEvmTx({ input: "0xabcd" }).dataLength).toBe(2);
  });

  it("survives a param that is not an object", () => {
    expect(summarizeEvmTx(undefined)).toMatchObject({ to: null, value: "0x0", dataLength: 0 });
  });

  it("prefers the transaction's own chain id", () => {
    expect(summarizeEvmTx({ chainId: "0xa" }, "0x1").chainId).toBe("0xa");
  });
});
