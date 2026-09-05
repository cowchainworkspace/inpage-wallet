import { describe, expect, it } from "vitest";

import { classify, familyOf } from "../../src/protocol/methods";
import {
  defaultNetworkFor,
  familiesOf,
  networkByEvmChainId,
  networkById,
  type NetworkDef,
} from "../../src/protocol/networks";

const NETWORKS: NetworkDef[] = [
  { id: "1", family: "evm", name: "Ethereum", wire: { evmChainId: "0x1", caip2: "eip155:1" } },
  { id: "11155111", family: "evm", name: "Sepolia", wire: { evmChainId: "0xaa36a7" } },
  {
    id: "sol_mainnet",
    family: "solana",
    name: "Solana",
    wire: { walletStandardChain: "solana:mainnet" },
  },
];

describe("classify", () => {
  it("routes each kind of method", () => {
    expect(classify("eth_chainId")).toBe("readOnly");
    expect(classify("eth_getBalance")).toBe("readRpc");
    expect(classify("eth_requestAccounts")).toBe("connect");
    expect(classify("solana_disconnect")).toBe("disconnect");
    expect(classify("wallet_switchEthereumChain")).toBe("switch");
    expect(classify("eth_signTypedData_v4")).toBe("sign");
    expect(classify("cardano_submitTx")).toBe("submit");
    expect(classify("eth_nonsense")).toBe("unsupported");
  });

  it("keeps eth_sendRawTransaction off the read allow-list", () => {
    expect(classify("eth_sendRawTransaction")).toBe("unsupported");
  });

  it("stays total on input that is not a method name", () => {
    const junk = [null, undefined, 42, {}, [], Symbol("x")];

    for (const value of junk) {
      expect(classify(value as unknown as string)).toBe("unsupported");
      expect(familyOf(value as unknown as string)).toBe("evm");
    }
  });
});

describe("familyOf", () => {
  it("derives the family from the method prefix, EVM by default", () => {
    expect(familyOf("eth_accounts")).toBe("evm");
    expect(familyOf("wallet_switchEthereumChain")).toBe("evm");
    expect(familyOf("solana_connect")).toBe("solana");
    expect(familyOf("cardano_signTx")).toBe("cardano");
    expect(familyOf("tron_accounts")).toBe("tron");
    expect(familyOf("xrpl_signMessage")).toBe("xrp");
    expect(familyOf("btc_signPsbt")).toBe("btc");
  });
});

describe("network lookups", () => {
  it("finds by host id", () => {
    expect(networkById(NETWORKS, "sol_mainnet")?.name).toBe("Solana");
    expect(networkById(NETWORKS, "nope")).toBeNull();
    expect(networkById(NETWORKS, undefined)).toBeNull();
  });

  it("finds an EVM network by hex chain id, case-insensitively", () => {
    expect(networkByEvmChainId(NETWORKS, "0xAA36A7")?.id).toBe("11155111");
    expect(networkByEvmChainId(NETWORKS, "0xdead")).toBeNull();
  });

  it("prefers the configured default and falls back to the first of the family", () => {
    expect(defaultNetworkFor(NETWORKS, "evm")?.id).toBe("1");
    expect(defaultNetworkFor(NETWORKS, "evm", { evm: "11155111" })?.id).toBe("11155111");
    expect(defaultNetworkFor(NETWORKS, "evm", { evm: "sol_mainnet" })?.id).toBe("1");
    expect(defaultNetworkFor(NETWORKS, "btc")).toBeNull();
  });

  it("lists the families a registry covers, in order, without repeats", () => {
    expect(familiesOf(NETWORKS)).toEqual(["evm", "solana"]);
  });
});
