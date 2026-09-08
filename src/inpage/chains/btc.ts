import { networksFor } from "../../protocol/networks";
import type { Bridge } from "../core/bridge";
import type { InjectedConfig } from "../core/config";
import { claimInstall } from "../core/guard";
import {
  bytes,
  inOrder,
  registerWallet,
  STANDARD_EVENTS,
  type ChangeListener,
  type WalletStandardAccount,
} from "../core/wallet-standard";

/** Bitcoin Wallet Standard feature names, inlined — no constants package exists. */
const CONNECT = "bitcoin:connect";
const SIGN_MESSAGE = "bitcoin:signMessage";
const SIGN_TX = "bitcoin:signTransaction";
const FEATURES = [CONNECT, SIGN_MESSAGE, SIGN_TX, STANDARD_EVENTS];

type BtcAccount = WalletStandardAccount & {
  readonly addressType: string;
  readonly purposes: readonly string[];
};

function bytesToB64(input: Uint8Array): string {
  let s = "";
  for (const byte of input) s += String.fromCharCode(byte);
  return btoa(s);
}

function b64ToBytes(input: string): Uint8Array {
  try {
    return Uint8Array.from(atob(input), (c) => c.charCodeAt(0));
  } catch {
    return new TextEncoder().encode(input);
  }
}

/** Bitcoin over the Wallet Standard. PSBTs cross the bridge as base64. */
export function installBtc(bridge: Bridge, config: InjectedConfig): void {
  if (!claimInstall("btc")) return;

  const chains = networksFor(config.networks, "btc")
    .map((n) => n.wire.walletStandardChain)
    .filter((c): c is string => typeof c === "string");

  const changeListeners = new Set<ChangeListener>();
  let accounts: BtcAccount[] = [];
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

  const makeAccount = (r: {
    address: string;
    publicKey?: number[];
    addressType?: string;
  }): BtcAccount => ({
    address: r.address,
    publicKey: bytes(r.publicKey),
    addressType: r.addressType ?? "",
    purposes: ["payment"],
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
      [STANDARD_EVENTS]: {
        version: "1.0.0" as const,
        on: (event: string, listener: ChangeListener) => {
          if (event !== "change") return () => {};
          changeListeners.add(listener);
          return () => changeListeners.delete(listener);
        },
      },
      [CONNECT]: {
        version: "1.0.0" as const,
        // The bridge method is the host-facing name, not the feature key.
        connect: async () => {
          const res = (await bridge.request("btc_requestAccounts", [{}])) as {
            address: string;
            publicKey?: number[];
            addressType?: string;
          } | null;
          accounts = res ? [makeAccount(res)] : [];
          emitChange();
          return { accounts };
        },
      },
      [SIGN_MESSAGE]: {
        version: "1.0.0" as const,
        signMessage: (...inputs: { message: Uint8Array }[]) =>
          inOrder(inputs, async (input) => {
            const message = new TextDecoder().decode(input.message);
            const signature = (await bridge.request("btc_signMessage", [{ message }])) as string;
            return { signature: b64ToBytes(signature) };
          }),
      },
      [SIGN_TX]: {
        version: "1.0.0" as const,
        signTransaction: (...inputs: { psbt: Uint8Array }[]) =>
          inOrder(inputs, async (input) => {
            const signed = (await bridge.request("btc_signPsbt", [
              { psbt: bytesToB64(input.psbt) },
            ])) as string;
            return { signedPsbt: b64ToBytes(signed) };
          }),
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

  bridge.onEvent("btc", (ev) => {
    if (ev.event !== "accountsChanged") return;
    const next = Array.isArray(ev.data) ? ev.data : [];
    if (next.length > 0) return;
    accounts = [];
    emitChange();
  });

  announce();
}
