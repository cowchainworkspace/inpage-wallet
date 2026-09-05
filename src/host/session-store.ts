import type { ChainFamily } from "../protocol/networks";
import { sessionKey, type Session } from "../protocol/session";

export type SessionChange = {
  origin: string;
  family: ChainFamily;
  session: Session | null;
};

export type SessionStore = {
  get(origin: string, family: ChainFamily): Promise<Session | null>;
  set(session: Session): Promise<void>;
  clear(origin: string, family: ChainFamily): Promise<void>;
  list(): Promise<Session[]>;
  /** Optional: tell the router a session ended elsewhere (backend revoke, other device). */
  subscribe?(listener: (change: SessionChange) => void): () => void;
};

/** The host's synchronous cache — chrome.storage's in-memory mirror, MMKV, a Map. */
export type LocalSessionCache = {
  get(origin: string, family: ChainFamily): Session | null;
  set(session: Session): void;
  clear(origin: string, family: ChainFamily): void;
  list(): Session[];
};

/** The host's backend client. Every method is optional; failures never block a write. */
export type RemoteSessions = {
  upsert?(session: Session): Promise<string | void>;
  remove?(session: Session): Promise<void>;
  list?(): Promise<Session[]>;
};

export type LayeredSessionStore = SessionStore & {
  /**
   * Pull the backend list and drop local sessions it no longer has. One that has
   * no backend id never got there, so it is pushed instead of dropped. Returns
   * the sessions that were cleared so the router can emit disconnect for each.
   */
  reconcile(): Promise<Session[]>;
  subscribe(listener: (change: SessionChange) => void): () => void;
};

export function memorySessionStore(seed: Session[] = []): SessionStore & {
  snapshot(): Session[];
} {
  const map = new Map<string, Session>();
  for (const s of seed) map.set(sessionKey(s.origin, s.family), s);
  const listeners = new Set<(change: SessionChange) => void>();

  const announce = (origin: string, family: ChainFamily, session: Session | null): void => {
    for (const listener of listeners) listener({ origin, family, session });
  };

  return {
    get: async (origin, family) => map.get(sessionKey(origin, family)) ?? null,
    set: async (session) => {
      map.set(sessionKey(session.origin, session.family), session);
      announce(session.origin, session.family, session);
    },
    clear: async (origin, family) => {
      map.delete(sessionKey(origin, family));
      announce(origin, family, null);
    },
    list: async () => [...map.values()],
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => [...map.values()],
  };
}

function sameList(
  a: readonly (string | number)[] | undefined,
  b: readonly (string | number)[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

/** Everything the backend stores. A signature only moves lastUsedAt. */
function sameRemoteFields(a: Session, b: Session): boolean {
  return (
    a.origin === b.origin &&
    a.family === b.family &&
    a.networkId === b.networkId &&
    a.walletId === b.walletId &&
    a.addressType === b.addressType &&
    sameList(a.accounts, b.accounts) &&
    sameList(a.publicKey, b.publicKey)
  );
}

/**
 * A synchronous local cache in front of an optional backend. dApps call
 * eth_accounts on every page load, so reads never wait on the network, and a
 * backend that is down still leaves the wallet usable.
 */
export function layeredSessionStore(deps: {
  local: LocalSessionCache;
  remote?: RemoteSessions;
}): LayeredSessionStore {
  const { local, remote } = deps;
  const listeners = new Set<(change: SessionChange) => void>();

  const announce = (origin: string, family: ChainFamily, session: Session | null): void => {
    for (const listener of listeners) {
      try {
        listener({ origin, family, session });
      } catch {
        /* one bad listener must not stop the rest */
      }
    }
  };

  /** Push one session to the backend and adopt the id it assigns. Throws on failure. */
  const pushRemote = async (session: Session): Promise<void> => {
    const upsert = remote?.upsert;
    if (!upsert) return;
    const id = await upsert(session);
    if (typeof id !== "string" || id === session.id) return;
    const withId: Session = { ...session, id };
    local.set(withId);
    announce(withId.origin, withId.family, withId);
  };

  /** Remote writes that failed, keyed by session, drained by the next reconcile. */
  const pending = new Map<string, { op: "upsert" | "remove"; session: Session }>();

  /** One retry each; whatever still fails waits for the reconcile after this one. */
  const drainPending = async (): Promise<void> => {
    for (const [key, item] of [...pending]) {
      pending.delete(key);
      try {
        if (item.op === "remove") {
          await remote?.remove?.(item.session);
          continue;
        }
        const current = local.get(item.session.origin, item.session.family);
        if (current) await pushRemote(current);
      } catch {
        pending.set(key, item);
      }
    }
  };

  return {
    get: async (origin, family) => local.get(origin, family),

    set: async (session) => {
      const key = sessionKey(session.origin, session.family);
      const previous = local.get(session.origin, session.family);
      local.set(session);
      announce(session.origin, session.family, session);
      // One backend request per signature is not worth a lastUsedAt bump.
      if (previous && sameRemoteFields(previous, session)) return;
      try {
        await pushRemote(session);
        pending.delete(key);
      } catch {
        /* the local write stands; retried on the next reconcile */
        pending.set(key, { op: "upsert", session });
      }
    },

    clear: async (origin, family) => {
      const key = sessionKey(origin, family);
      const existing = local.get(origin, family);
      local.clear(origin, family);
      announce(origin, family, null);
      // A queued upsert for a session that no longer exists has nothing to say.
      pending.delete(key);
      if (!existing || !remote?.remove) return;
      try {
        await remote.remove(existing);
      } catch {
        /* the local clear stands; retried on the next reconcile */
        pending.set(key, { op: "remove", session: existing });
      }
    },

    list: async () => local.list(),

    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    reconcile: async () => {
      await drainPending();
      if (!remote?.list) return [];
      let live: Session[];
      try {
        live = await remote.list();
      } catch {
        return [];
      }
      const alive = new Set(live.map((s) => sessionKey(s.origin, s.family)));
      const cleared: Session[] = [];
      for (const session of local.list()) {
        if (alive.has(sessionKey(session.origin, session.family))) continue;
        if (session.id === undefined) {
          // Absent remotely because it never got there — push it, do not drop it.
          try {
            await pushRemote(session);
          } catch {
            /* keep it locally; retried on the next reconcile */
            pending.set(sessionKey(session.origin, session.family), { op: "upsert", session });
          }
          continue;
        }
        local.clear(session.origin, session.family);
        cleared.push(session);
        announce(session.origin, session.family, null);
      }
      return cleared;
    },
  };
}
