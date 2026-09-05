import type { ChainFamily, NetworkDef } from "../../protocol/networks";

/**
 * `rdns` and `uuid` are the wallet's permanent identity: dApps key a user's saved
 * "last connected wallet" on them. Generate once, never change.
 */
export type WalletIdentity = {
  name: string;
  rdns: string;
  uuid: string;
  /** Data URI. A neutral spec-valid placeholder is used until the host sends one. */
  icon?: string | undefined;
};

export type InjectedConfig = {
  identity: WalletIdentity;
  /** Host ids and names; the families present decide which providers are injected. */
  networks: NetworkDef[];
  /** Which network answers before a session exists. */
  defaultNetwork?: Partial<Record<ChainFamily, string>> | undefined;
  legacyGlobals?: {
    /** Define window.ethereum if absent. Off by default: EIP-6963 only. */
    ethereum?: boolean | undefined;
    /** Use the full TronWeb SDK entry instead of the thin tronLink bridge. */
    tronWeb?: boolean | undefined;
  } | undefined;
  /** window.cardano key dApps enumerate. Defaults to a slug of identity.name. */
  cardanoWalletKey?: string | undefined;
  channel?: string | undefined;
};

/** Neutral placeholder shown until the host delivers its own icon. */
export const FALLBACK_ICON =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" rx="10" fill="#6b7280"/><circle cx="24" cy="24" r="9" fill="#f9fafb"/></svg>',
  );

export function initialIcon(config: InjectedConfig): string {
  const icon = config.identity.icon;
  return icon && icon.length > 0 ? icon : FALLBACK_ICON;
}
