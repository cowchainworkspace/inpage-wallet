import type { ChainFamily } from "./networks";

export type EvmTxRequest = {
  from?: string;
  to?: string;
  value?: string;
  data?: string;
  gas?: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  nonce?: string;
  chainId?: string;
};

export type SolanaConnectResult = { address: string; publicKey: number[] } | null;

/**
 * Every method the package routes, with the shape each side must speak. Bytes
 * cross as number[]; Cardano, XRPL and BTC payloads are already string/JSON native.
 */
export interface MethodMap {
  // --- EVM, EIP-1193 ---
  eth_chainId: { params: []; result: string };
  net_version: { params: []; result: string };
  eth_accounts: { params: []; result: string[] };
  wallet_getPermissions: { params: []; result: { parentCapability: string }[] };
  eth_requestAccounts: { params: []; result: string[] };
  wallet_requestPermissions: { params: [Record<string, unknown>]; result: string[] };
  wallet_switchEthereumChain: { params: [{ chainId: string }]; result: null };
  wallet_addEthereumChain: { params: [{ chainId: string }]; result: null };
  personal_sign: { params: [string, string]; result: string };
  eth_sign: { params: [string, string]; result: string };
  eth_signTypedData: { params: [string, string]; result: string };
  eth_signTypedData_v3: { params: [string, string]; result: string };
  eth_signTypedData_v4: { params: [string, string]; result: string };
  eth_sendTransaction: { params: [EvmTxRequest]; result: string };
  eth_signTransaction: { params: [EvmTxRequest]; result: string };

  // --- Solana, Wallet Standard ---
  solana_connect: { params: [{ silent?: boolean }]; result: SolanaConnectResult };
  solana_disconnect: { params: [Record<string, never>]; result: null };
  solana_signTransaction: {
    params: [{ tx: number[]; account: string }];
    result: { signedTx: number[] };
  };
  solana_signAndSendTransaction: {
    params: [{ tx: number[]; account: string }];
    result: { signature: number[] };
  };
  solana_signMessage: {
    params: [{ message: number[]; account: string }];
    result: { signedMessage: number[]; signature: number[] };
  };

  // --- Cardano, CIP-30 ---
  cardano_enable: { params: [Record<string, never>]; result: { networkId: 0 | 1 } | null };
  cardano_disconnect: { params: []; result: null };
  cardano_isEnabled: { params: []; result: boolean };
  cardano_getNetworkId: { params: []; result: number };
  cardano_getUsedAddresses: { params: []; result: string[] };
  cardano_getUnusedAddresses: { params: []; result: string[] };
  cardano_getChangeAddress: { params: []; result: string | null };
  cardano_getRewardAddresses: { params: []; result: string[] };
  cardano_getBalance: { params: []; result: string };
  cardano_getUtxos: { params: []; result: string[] | null };
  cardano_getCollateral: { params: []; result: string[] };
  cardano_submitTx: { params: [{ tx: string }]; result: string };
  cardano_signTx: { params: [{ tx: string; partialSign: boolean }]; result: string };
  cardano_signData: {
    params: [{ address: string; payload: string }];
    result: { signature: string; key: string };
  };

  // --- Tron, TronLink ---
  tron_requestAccounts: { params: [Record<string, never>]; result: { address: string } | null };
  tron_disconnect: { params: []; result: null };
  tron_accounts: { params: []; result: string[] };
  tron_signTransaction: { params: [{ transaction: unknown }]; result: unknown };
  tron_signMessage: { params: [{ message: string }]; result: string };

  // --- XRPL ---
  xrpl_requestAccounts: {
    params: [{ silent?: boolean }];
    result: { address: string } | null;
  };
  xrpl_disconnect: { params: []; result: null };
  xrpl_accounts: { params: []; result: string[] };
  xrpl_signTransaction: {
    params: [{ tx_json: Record<string, unknown>; submit: boolean }];
    result: { tx_blob?: string; hash?: string } & Record<string, unknown>;
  };
  xrpl_signMessage: { params: [{ message: string }]; result: string };

  // --- Bitcoin, Wallet Standard ---
  btc_requestAccounts: {
    params: [Record<string, never>];
    result: { address: string; publicKey?: string; addressType?: string } | null;
  };
  btc_disconnect: { params: []; result: null };
  btc_accounts: { params: []; result: string[] };
  btc_signPsbt: { params: [{ psbt: string }]; result: string };
  btc_signMessage: { params: [{ message: string }]; result: string };
}

export type Method = keyof MethodMap;

export type MethodKind =
  | "readOnly"
  | "readRpc"
  | "connect"
  | "disconnect"
  | "switch"
  | "sign"
  | "unsupported";

/** Answered from the session with no UI — dApps poll these on every page load. */
export const READ_ONLY_METHODS: ReadonlySet<string> = new Set([
  "eth_chainId",
  "net_version",
  "eth_accounts",
  "wallet_getPermissions",
  "cardano_isEnabled",
  "cardano_getNetworkId",
  "cardano_getUsedAddresses",
  "cardano_getUnusedAddresses",
  "cardano_getChangeAddress",
  "cardano_getRewardAddresses",
  "tron_accounts",
  "xrpl_accounts",
  "btc_accounts",
]);

/**
 * Proxied to the host's node client. An allow-list, never a passthrough: an
 * unlisted method must not become a way to drive an arbitrary node.
 */
export const DEFAULT_READ_RPC_METHODS: ReadonlySet<string> = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getBlockByNumber",
  "eth_getCode",
  "eth_getLogs",
  "eth_getStorageAt",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_maxPriorityFeePerGas",
  "cardano_getBalance",
  "cardano_getUtxos",
  "cardano_getCollateral",
  "cardano_submitTx",
]);

export const CONNECT_METHODS: ReadonlySet<string> = new Set([
  "eth_requestAccounts",
  "wallet_requestPermissions",
  "solana_connect",
  "cardano_enable",
  "tron_requestAccounts",
  "xrpl_requestAccounts",
  "btc_requestAccounts",
]);

export const DISCONNECT_METHODS: ReadonlySet<string> = new Set([
  "solana_disconnect",
  "cardano_disconnect",
  "tron_disconnect",
  "xrpl_disconnect",
  "btc_disconnect",
]);

export const SWITCH_METHODS: ReadonlySet<string> = new Set([
  "wallet_switchEthereumChain",
  "wallet_addEthereumChain",
]);

export const SIGN_METHODS: ReadonlySet<string> = new Set([
  "personal_sign",
  "eth_sign",
  "eth_signTypedData",
  "eth_signTypedData_v3",
  "eth_signTypedData_v4",
  "eth_sendTransaction",
  "eth_signTransaction",
  "solana_signTransaction",
  "solana_signMessage",
  "solana_signAndSendTransaction",
  "cardano_signTx",
  "cardano_signData",
  "tron_signTransaction",
  "tron_signMessage",
  "xrpl_signTransaction",
  "xrpl_signMessage",
  "btc_signPsbt",
  "btc_signMessage",
]);

const FAMILY_PREFIXES: readonly [string, ChainFamily][] = [
  ["solana_", "solana"],
  ["cardano_", "cardano"],
  ["tron_", "tron"],
  ["xrpl_", "xrp"],
  ["btc_", "btc"],
];

/** The family a method belongs to; EVM is the un-prefixed default. */
export function familyOf(method: string): ChainFamily {
  for (const [prefix, family] of FAMILY_PREFIXES) {
    if (method.startsWith(prefix)) return family;
  }
  return "evm";
}

export function classify(method: string): MethodKind {
  if (READ_ONLY_METHODS.has(method)) return "readOnly";
  if (DEFAULT_READ_RPC_METHODS.has(method)) return "readRpc";
  if (CONNECT_METHODS.has(method)) return "connect";
  if (DISCONNECT_METHODS.has(method)) return "disconnect";
  if (SWITCH_METHODS.has(method)) return "switch";
  if (SIGN_METHODS.has(method)) return "sign";
  return "unsupported";
}
