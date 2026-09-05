import { networksFor } from "../../protocol/networks";
import type { Bridge } from "../core/bridge";
import type { InjectedConfig } from "../core/config";
import { claimInstall } from "../core/guard";
import {
  registerWallet,
  STANDARD_CONNECT,
  STANDARD_DISCONNECT,
  STANDARD_EVENTS,
  type ChangeListener,
  type WalletStandardAccount,
} from "../core/wallet-standard";

/** XLS-72d feature names, inlined — no constants package exists. */
const SIGN_TX = "xrpl:signTransaction";
const SIGN_AND_SUBMIT = "xrpl:signAndSubmitTransaction";
const FEATURES = [SIGN_TX, SIGN_AND_SUBMIT];

type TxJson = Record<string, unknown>;

/**
 * XRPL over the Wallet Standard (XLS-72d). Coexists with the window.crossmark
 * provider: different discovery channel, same xrpl_* bridge methods and session.
 */
export function installXrpStandard(bridge: Bridge, config: InjectedConfig): void {
  if (!claimInstall("xrp-standard")) return;

  const chains = networksFor(config.networks, "xrp")
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

  // XRPL connect answers with an address only; the public key is not exposed.
  const makeAccount = (address: string): WalletStandardAccount => ({
    address,
    publicKey: new Uint8Array(),
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
          const res = (await bridge.request("xrpl_requestAccounts", [
            { silent: Boolean(input?.silent) },
          ])) as { address: string } | null;
          accounts = res ? [makeAccount(res.address)] : [];
          emitChange();
          return { accounts };
        },
      },
      [STANDARD_DISCONNECT]: {
        version: "1.0.0" as const,
        disconnect: async () => {
          await bridge.request("xrpl_disconnect");
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
      [SIGN_TX]: {
        version: "1.0.0" as const,
        signTransaction: async (input: { tx_json: TxJson }) => {
          const res = (await bridge.request("xrpl_signTransaction", [
            { tx_json: input.tx_json, submit: false },
          ])) as { tx_blob?: string };
          return { signed_tx_blob: res.tx_blob ?? "" };
        },
      },
      [SIGN_AND_SUBMIT]: {
        version: "1.0.0" as const,
        signAndSubmitTransaction: async (input: { tx_json: TxJson }) => {
          const res = (await bridge.request("xrpl_signTransaction", [
            { tx_json: input.tx_json, submit: true },
          ])) as { hash?: string };
          return { tx_hash: res.hash ?? "", tx_json: res };
        },
      },
    },
  };

  const announce = (): void => {
    registerWallet(wallet);
    registered = true;
  };

  bridge.onIcon(() => {
    if (!registered) announce();
  });

  bridge.onEvent("xrp", (ev) => {
    if (ev.event !== "accountsChanged") return;
    const next = Array.isArray(ev.data) ? ev.data : [];
    if (next.length > 0) return;
    accounts = [];
    emitChange();
  });

  announce();
}
