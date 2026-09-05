import type { NetworkDef } from "inpage-wallet";
import type { WalletIdentity } from "inpage-wallet/inpage";

/**
 * The only place a brand exists. `rdns` and `uuid` are permanent: dApps key a
 * user's saved connection on them, so generate the uuid once and never change it.
 */
export const IDENTITY: WalletIdentity = {
  name: "Example Wallet",
  rdns: "com.example.wallet",
  uuid: "6f9d3c1e-0a2b-4c8d-9e1f-2a3b4c5d6e7f",
};

/** Host ids, host names. The package never knows a network until you register it. */
export const NETWORKS: NetworkDef[] = [
  { id: "1", family: "evm", name: "Ethereum", wire: { evmChainId: "0x1", caip2: "eip155:1" } },
  {
    id: "11155111",
    family: "evm",
    name: "Sepolia",
    wire: { evmChainId: "0xaa36a7", caip2: "eip155:11155111" },
  },
  {
    id: "sol_mainnet",
    family: "solana",
    name: "Solana",
    wire: { walletStandardChain: "solana:mainnet", caip2: "solana:mainnet" },
  },
];
