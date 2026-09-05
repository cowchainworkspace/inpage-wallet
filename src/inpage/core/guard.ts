const FLAG = "__inpageWalletInstalled";

type FlagHolder = Record<string, Record<string, boolean> | undefined>;

/**
 * A document can be injected more than once (per-frame registration, a re-run
 * preamble). The second install must be a no-op, not a second provider.
 */
export function claimInstall(key: string): boolean {
  const holder = globalThis as unknown as FlagHolder;
  const flags = holder[FLAG] ?? {};
  holder[FLAG] = flags;
  if (flags[key]) return false;
  flags[key] = true;
  return true;
}

/** Test-only: forget every claim so a fresh install can run in the same document. */
export function resetInstalls(): void {
  (globalThis as unknown as FlagHolder)[FLAG] = {};
}
