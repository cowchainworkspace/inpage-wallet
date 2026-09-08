import { networksFor } from "../../protocol/networks";
import type { Bridge } from "../core/bridge";
import type { InjectedConfig } from "../core/config";
import { claimInstall } from "../core/guard";
import {
  bytes,
  inOrder,
  registerWallet,
  STANDARD_CONNECT,
  STANDARD_DISCONNECT,
  STANDARD_EVENTS,
  toNumbers,
  type ChangeListener,
  type WalletStandardAccount,
} from "../core/wallet-standard";

const SIGN_TRANSACTION = "solana:signTransaction";
const SIGN_AND_SEND_TRANSACTION = "solana:signAndSendTransaction";
const SIGN_MESSAGE = "solana:signMessage";
const FEATURES = [SIGN_TRANSACTION, SIGN_AND_SEND_TRANSACTION, SIGN_MESSAGE];

type SignTxInput = { transaction: Uint8Array; account: { address: string } };
type SignMessageInput = { message: Uint8Array; account: { address: string } };

/** Wallet Standard wallet for Solana. No window.solana; discovery is the event. */
export function installSolana(bridge: Bridge, config: InjectedConfig): void {
  if (!claimInstall("solana")) return;

  const chains = networksFor(config.networks, "solana")
    .map((n) => n.wire.walletStandardChain)
    .filter((c): c is string => typeof c === "string");

  const changeListeners = new Set<ChangeListener>();
  let accounts: WalletStandardAccount[] = [];
  let registered = false;

  const emitChange = (): void => {
    for (const listener of changeListeners) {
      try {
        listener({ accounts });
      } catch {
        /* never let a dApp listener break the bridge */
      }
    }
  };

  const makeAccount = (r: { address: string; publicKey: number[] }): WalletStandardAccount => ({
    address: r.address,
    publicKey: bytes(r.publicKey),
    chains,
    features: FEATURES,
  });

  const wallet = {
    version: "1.0.0" as const,
    name: config.identity.name,
    get icon() {
      return bridge.icon();
    },
    chains,
    get accounts() {
      return accounts;
    },
    features: {
      [STANDARD_CONNECT]: {
        version: "1.0.0" as const,
        connect: async (input?: { silent?: boolean }) => {
          const res = (await bridge.request("solana_connect", [
            { silent: Boolean(input?.silent) },
          ])) as { address: string; publicKey?: number[] } | null;
          // A zero-length key would have the dApp build transactions for an
          // account the wallet does not hold; a connect without one has failed.
          const publicKey = res?.publicKey;
          if (res && !(publicKey && publicKey.length > 0)) {
            throw new Error("Wallet did not provide a public key for solana");
          }
          accounts = res && publicKey ? [makeAccount({ address: res.address, publicKey })] : [];
          emitChange();
          return { accounts };
        },
      },
      [STANDARD_DISCONNECT]: {
        version: "1.0.0" as const,
        disconnect: async () => {
          await bridge.request("solana_disconnect", [{}]);
          accounts = [];
          emitChange();
        },
      },
      [STANDARD_EVENTS]: {
        version: "1.0.0" as const,
        on: (event: string, listener: ChangeListener) => {
          if (event !== "change") return () => {};
          changeListeners.add(listener);
          return () => changeListeners.delete(listener);
        },
      },
      [SIGN_TRANSACTION]: {
        version: "1.0.0" as const,
        supportedTransactionVersions: ["legacy", 0] as const,
        signTransaction: (...inputs: SignTxInput[]) =>
          inOrder(inputs, async (i) => {
            const res = (await bridge.request("solana_signTransaction", [
              { tx: toNumbers(i.transaction), account: i.account.address },
            ])) as { signedTx: number[] };
            return { signedTransaction: bytes(res.signedTx) };
          }),
      },
      [SIGN_AND_SEND_TRANSACTION]: {
        version: "1.0.0" as const,
        supportedTransactionVersions: ["legacy", 0] as const,
        signAndSendTransaction: (...inputs: SignTxInput[]) =>
          inOrder(inputs, async (i) => {
            const res = (await bridge.request("solana_signAndSendTransaction", [
              { tx: toNumbers(i.transaction), account: i.account.address },
            ])) as { signature: number[] };
            return { signature: bytes(res.signature) };
          }),
      },
      [SIGN_MESSAGE]: {
        version: "1.0.0" as const,
        signMessage: (...inputs: SignMessageInput[]) =>
          inOrder(inputs, async (i) => {
            const res = (await bridge.request("solana_signMessage", [
              { message: toNumbers(i.message), account: i.account.address },
            ])) as { signedMessage: number[]; signature: number[] };
            return { signedMessage: bytes(res.signedMessage), signature: bytes(res.signature) };
          }),
      },
    },
  };

  const announce = (): void => {
    registerWallet(wallet);
    registered = true;
  };

  // Registering again once the real icon arrives is harmless: apps key on name.
  bridge.onIcon(() => {
    if (!registered) announce();
  });

  bridge.onEvent("solana", (ev) => {
    if (ev.event !== "accountsChanged") return;
    const next = Array.isArray(ev.data) ? ev.data : [];
    if (next.length > 0) return;
    accounts = [];
    emitChange();
  });

  announce();
}
