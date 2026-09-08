/** Minimal Wallet Standard account: avoids a dependency on @wallet-standard/base. */
export type WalletStandardAccount = {
  readonly address: string;
  readonly publicKey: Uint8Array;
  readonly chains: readonly string[];
  readonly features: readonly string[];
};

export type ChangeListener = (props: { accounts?: readonly WalletStandardAccount[] }) => void;

export const STANDARD_CONNECT = "standard:connect";
export const STANDARD_DISCONNECT = "standard:disconnect";
export const STANDARD_EVENTS = "standard:events";

type RegisterApi = { register(wallet: unknown): void };

function registerWalletEvent(callback: (api: RegisterApi) => void): Event {
  const event = new Event("wallet-standard:register-wallet", {
    bubbles: false,
    cancelable: false,
    composed: false,
  });
  Object.defineProperty(event, "detail", { value: callback });
  return event;
}

/** The register protocol, hand-rolled so no @wallet-standard package is needed. */
export function registerWallet(wallet: unknown): void {
  const callback = (api: RegisterApi): void => api.register(wallet);
  try {
    window.dispatchEvent(registerWalletEvent(callback));
  } catch {
    /* an app that does not implement the standard */
  }
  try {
    window.addEventListener(
      "wallet-standard:app-ready",
      (e) => callback((e as CustomEvent<RegisterApi>).detail),
      false,
    );
  } catch {
    /* ignore */
  }
}

export function bytes(value: unknown): Uint8Array {
  return new Uint8Array(Array.isArray(value) ? (value as number[]) : []);
}

export function toNumbers(value: Uint8Array | number[]): number[] {
  return Array.from(value);
}

/**
 * Wallet Standard sign methods are variadic. One request per input, sequentially
 * so a host holding one prompt at a time is not asked to open several, and the
 * first failure rejects the whole call without asking for the rest.
 */
export async function inOrder<I, O>(
  inputs: readonly I[],
  run: (input: I) => Promise<O>,
): Promise<O[]> {
  const outputs: O[] = [];
  for (const input of inputs) outputs.push(await run(input));
  return outputs;
}
