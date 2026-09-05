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

  return {
    get: async (origin, family) => local.get(origin, family),

    set: async (session) => {
      local.set(session);
      announce(session.origin, session.family, session);
      try {
        await pushRemote(session);
      } catch {
        /* the backend catches up later; the local write already stands */
      }
    },

    clear: async (origin, family) => {
      const existing = local.get(origin, family);
      local.clear(origin, family);
      announce(origin, family, null);
      if (!existing || !remote?.remove) return;
      try {
        await remote.remove(existing);
      } catch {
        /* the backend catches up later */
      }
    },

    list: async () => local.list(),

    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    reconcile: async () => {
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
            /* keep it locally and try again on the next reconcile */
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
