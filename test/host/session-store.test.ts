import { describe, expect, it, vi } from "vitest";

import {
  layeredSessionStore,
  memorySessionStore,
  type LocalSessionCache,
  type SessionChange,
} from "../../src/host/session-store";
import { sessionKey, type Session } from "../../src/protocol/session";

const A = "https://a.example";
const B = "https://b.example";

function session(origin: string, over: Partial<Session> = {}): Session {
  return {
    origin,
    family: "evm",
    networkId: "1",
    accounts: ["0xabc"],
    createdAt: 1,
    lastUsedAt: 1,
    ...over,
  };
}

function localCache(seed: Session[] = []): LocalSessionCache & { size(): number } {
  const map = new Map<string, Session>();
  for (const s of seed) map.set(sessionKey(s.origin, s.family), s);
  return {
    get: (origin, family) => map.get(sessionKey(origin, family)) ?? null,
    set: (s) => {
      map.set(sessionKey(s.origin, s.family), s);
    },
    clear: (origin, family) => {
      map.delete(sessionKey(origin, family));
    },
    list: () => [...map.values()],
    size: () => map.size,
  };
}

describe("memorySessionStore", () => {
  it("round-trips and lists", async () => {
    const store = memorySessionStore([session(A)]);

    expect(await store.get(A, "evm")).toMatchObject({ origin: A });
    expect(await store.get(A, "solana")).toBeNull();

    await store.set(session(B));
    expect(await store.list()).toHaveLength(2);

    await store.clear(A, "evm");
    expect(await store.get(A, "evm")).toBeNull();
  });
});

describe("layeredSessionStore", () => {
  it("answers reads from the local cache without touching the backend", async () => {
    const remote = { list: vi.fn(async () => []) };
    const store = layeredSessionStore({ local: localCache([session(A)]), remote });

    expect(await store.get(A, "evm")).toMatchObject({ origin: A });
    expect(remote.list).not.toHaveBeenCalled();
  });

  it("writes through and stores the id the backend assigned", async () => {
    const local = localCache();
    const upsert = vi.fn(async () => "backend-1");
    const store = layeredSessionStore({ local, remote: { upsert } });

    await store.set(session(A));

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(local.get(A, "evm")).toMatchObject({ id: "backend-1" });
  });

  it("keeps the local write when the backend is unreachable", async () => {
    const local = localCache();
    const store = layeredSessionStore({
      local,
      remote: {
        upsert: async () => {
          throw new Error("offline");
        },
      },
    });

    await store.set(session(A));

    expect(local.get(A, "evm")).toMatchObject({ origin: A });
  });

  it("removes remotely with the session it had locally", async () => {
    const remove = vi.fn(async () => {});
    const local = localCache([session(A, { id: "backend-1" })]);
    const store = layeredSessionStore({ local, remote: { remove } });

    await store.clear(A, "evm");

    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ id: "backend-1" }));
    expect(local.get(A, "evm")).toBeNull();
  });

  it("does not call the backend when there was nothing local to remove", async () => {
    const remove = vi.fn(async () => {});
    const store = layeredSessionStore({ local: localCache(), remote: { remove } });

    await store.clear(A, "evm");

    expect(remove).not.toHaveBeenCalled();
  });

  it("reconcile clears local sessions the backend no longer has and reports them", async () => {
    const local = localCache([session(A, { id: "backend-a" }), session(B, { id: "backend-b" })]);
    const changes: SessionChange[] = [];
    const store = layeredSessionStore({ local, remote: { list: async () => [session(B)] } });
    store.subscribe((c) => changes.push(c));

    const cleared = await store.reconcile();

    expect(cleared).toHaveLength(1);
    expect(cleared[0]?.origin).toBe(A);
    expect(local.size()).toBe(1);
    expect(changes).toEqual([{ origin: A, family: "evm", session: null }]);
  });

  it("retries a failed upsert on the next reconcile", async () => {
    const local = localCache();
    let offline = true;
    const upsert = vi.fn(async () => {
      if (offline) throw new Error("offline");
      return "backend-1";
    });
    const store = layeredSessionStore({ local, remote: { upsert, list: async () => local.list() } });

    await store.set(session(A));
    expect(local.get(A, "evm")?.id).toBeUndefined();

    offline = false;
    await store.reconcile();

    expect(upsert).toHaveBeenCalledTimes(2);
    expect(local.get(A, "evm")).toMatchObject({ id: "backend-1" });
  });

  it("retries a failed remove on the next reconcile and then stops", async () => {
    const local = localCache([session(A, { id: "backend-1" })]);
    let offline = true;
    const remove = vi.fn(async () => {
      if (offline) throw new Error("offline");
    });
    const store = layeredSessionStore({ local, remote: { remove, list: async () => [] } });

    await store.clear(A, "evm");
    expect(remove).toHaveBeenCalledTimes(1);

    offline = false;
    await store.reconcile();
    expect(remove).toHaveBeenCalledTimes(2);

    await store.reconcile();
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it("reconcile pushes a local session the backend never received", async () => {
    const local = localCache([session(A)]);
    const upsert = vi.fn(async () => "backend-a");
    const changes: SessionChange[] = [];
    const store = layeredSessionStore({ local, remote: { upsert, list: async () => [] } });
    store.subscribe((c) => changes.push(c));

    const cleared = await store.reconcile();

    expect(cleared).toEqual([]);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(local.get(A, "evm")).toMatchObject({ id: "backend-a" });
    expect(changes).toEqual([{ origin: A, family: "evm", session: expect.objectContaining({ id: "backend-a" }) }]);
  });

  it("reconcile keeps a session whose push failed instead of clearing it", async () => {
    const local = localCache([session(A)]);
    const upsert = vi.fn(async () => {
      throw new Error("offline");
    });
    const store = layeredSessionStore({ local, remote: { upsert, list: async () => [] } });

    const cleared = await store.reconcile();

    expect(cleared).toEqual([]);
    expect(local.get(A, "evm")).toMatchObject({ origin: A });
    expect(local.get(A, "evm")?.id).toBeUndefined();
  });

  it("reconcile leaves everything alone when the backend cannot be reached", async () => {
    const local = localCache([session(A)]);
    const store = layeredSessionStore({
      local,
      remote: {
        list: async () => {
          throw new Error("offline");
        },
      },
    });

    expect(await store.reconcile()).toEqual([]);
    expect(local.size()).toBe(1);
  });

  it("reconcile is a no-op with no backend at all", async () => {
    const local = localCache([session(A)]);
    const store = layeredSessionStore({ local });

    expect(await store.reconcile()).toEqual([]);
    expect(local.size()).toBe(1);
  });

  it("stops notifying after unsubscribe", async () => {
    const store = layeredSessionStore({ local: localCache() });
    const changes: SessionChange[] = [];
    const off = store.subscribe((c) => changes.push(c));

    await store.set(session(A));
    off();
    await store.set(session(B));

    expect(changes).toHaveLength(1);
  });
});
