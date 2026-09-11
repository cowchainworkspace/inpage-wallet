import type { Bridge } from "../core/bridge";
import type { InjectedConfig } from "../core/config";
import { installTron, type TronWebLike } from "./tron";

export type { TronWebLike } from "./tron";

export type TronFullDeps = {
  /** A TronWeb instance, already pointed at the host's fullnode. */
  tronWeb: TronWebLike;
};

export type TronLinkFull = {
  ready: boolean;
  tronWeb: TronWebLike;
  request(args: { method: string; params?: unknown }): Promise<unknown>;
};

/**
 * The Tron providers with the host's TronWeb SDK on window.tronWeb: reads run on
 * the host's node, only signing is redirected. Its own entry: `tron` costs nothing.
 */
export function installTronFull(
  bridge: Bridge,
  config: InjectedConfig,
  deps: TronFullDeps,
): TronLinkFull | null {
  const tronLink = installTron(bridge, config, { tronWeb: deps.tronWeb });
  return tronLink === null ? null : (tronLink as TronLinkFull);
}
