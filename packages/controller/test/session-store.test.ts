/**
 * Server-side sessions, ported from
 * `actionpack/test/dispatch/session/cache_store_test.rb` and the
 * `AbstractStore` cases in `actionpack/test/dispatch/session/`.
 */

import { describe, expect, it } from "bun:test";
import {
  MemorySessionStore,
  StoredSession,
  commitSession,
  extractSessionId,
  generateSid,
  loadSession,
  rotateSession,
} from "../src/session-store.js";

describe("generateSid", () => {
  /** A bearer credential: guessing one is signing in as somebody. */
  it("is long", () => {
    expect(generateSid()).toHaveLength(64);
  });

  it("is hex", () => {
    expect(generateSid()).toMatch(/^[0-9a-f]+$/);
  });

  it("does not repeat itself", () => {
    expect(generateSid()).not.toBe(generateSid());
  });
});

describe("extractSessionId", () => {
  it("accepts one of ours", () => {
    const sid = generateSid();

    expect(extractSessionId(sid)).toBe(sid);
  });

  /** Refused before the lookup, so cookie noise cannot become database load. */
  it("refuses something malformed", () => {
    expect(extractSessionId("not-a-session")).toBeUndefined();
    expect(extractSessionId("abc")).toBeUndefined();
    expect(extractSessionId("ZZZZ".repeat(16))).toBeUndefined();
  });

  it("refuses nothing at all", () => {
    expect(extractSessionId(null)).toBeUndefined();
    expect(extractSessionId(undefined)).toBeUndefined();
    expect(extractSessionId("")).toBeUndefined();
  });
});

describe("the store", () => {
  it("round-trips a session", async () => {
    const store = new MemorySessionStore();
    await store.writeSession("abc", { userId: 1 });

    expect(await store.findSession("abc")).toEqual({ userId: 1 });
  });

  it("gives null for one it does not have", async () => {
    expect(await new MemorySessionStore().findSession("absent")).toBeNull();
  });

  it("deletes one", async () => {
    const store = new MemorySessionStore();
    await store.writeSession("abc", { userId: 1 });
    await store.deleteSession("abc");

    expect(await store.findSession("abc")).toBeNull();
  });

  it("hands back a copy rather than the stored object", async () => {
    const store = new MemorySessionStore();
    await store.writeSession("abc", { userId: 1 });

    const read = (await store.findSession("abc")) as Record<string, unknown>;
    read.userId = 2;

    expect(await store.findSession("abc")).toEqual({ userId: 1 });
  });

  /** Checked on read: a session nobody asks about costs nothing. */
  it("forgets an expired session", async () => {
    const store = new MemorySessionStore();
    await store.writeSession("abc", { userId: 1 }, -1);

    expect(await store.findSession("abc")).toBeNull();
  });

  it("keeps one that has not expired", async () => {
    const store = new MemorySessionStore();
    await store.writeSession("abc", { userId: 1 }, 3600);

    expect(await store.findSession("abc")).toEqual({ userId: 1 });
  });

  it("lists what it holds", async () => {
    const store = new MemorySessionStore();
    await store.writeSession("a", {});
    await store.writeSession("b", {});

    expect(store.sessionIds.sort()).toEqual(["a", "b"]);
  });
});

describe("StoredSession", () => {
  it("reads and writes keys", () => {
    const session = new StoredSession("abc", { userId: 1 });

    expect(session.get("userId")).toBe(1);
    expect(session.has("userId")).toBe(true);

    session.set("role", "admin");

    expect(session.keys.sort()).toEqual(["role", "userId"]);
  });

  it("deletes a key", () => {
    const session = new StoredSession("abc", { userId: 1 });
    session.delete("userId");

    expect(session.has("userId")).toBe(false);
  });

  it("starts unchanged", () => {
    expect(new StoredSession("abc", { userId: 1 }).changed).toBe(false);
  });

  it("notices a write", () => {
    const session = new StoredSession("abc", { userId: 1 });
    session.set("role", "admin");

    expect(session.changed).toBe(true);
  });

  /** Writing the same value back is not a change. */
  it("does not notice a write of the same value", () => {
    const session = new StoredSession("abc", { userId: 1 });
    session.set("userId", 1);

    expect(session.changed).toBe(false);
  });

  it("counts destruction as a change", () => {
    const session = new StoredSession("abc", { userId: 1 });
    session.destroy();

    expect(session.destroyed).toBe(true);
    expect(session.changed).toBe(true);
  });
});

describe("loadSession", () => {
  it("reads an existing session", async () => {
    const store = new MemorySessionStore();
    const sid = generateSid();
    await store.writeSession(sid, { userId: 1 });

    const session = await loadSession(store, sid);

    expect(session.id).toBe(sid);
    expect(session.get("userId")).toBe(1);
  });

  it("starts a new one with no cookie", async () => {
    const session = await loadSession(new MemorySessionStore(), null);

    expect(session.keys).toEqual([]);
    expect(session.id).toMatch(/^[0-9a-f]{64}$/);
  });

  /**
   * A forgotten session gets a fresh id rather than reusing the one the client
   * sent — reusing it would let a client choose its own session identifier,
   * which is session fixation.
   */
  it("does not reuse an id the store has forgotten", async () => {
    const sid = generateSid();
    const session = await loadSession(new MemorySessionStore(), sid);

    expect(session.id).not.toBe(sid);
  });

  it("does not reuse a malformed id either", async () => {
    const session = await loadSession(new MemorySessionStore(), "not-a-session");

    expect(session.id).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("commitSession", () => {
  it("writes a changed session", async () => {
    const store = new MemorySessionStore();
    const session = await loadSession(store, null);
    session.set("userId", 1);

    const id = await commitSession(store, session);

    expect(id).toBe(session.id);
    expect(await store.findSession(session.id)).toEqual({ userId: 1 });
  });

  /**
   * Writing on every request refreshes the expiry on every request, which
   * turns a one-hour timeout into an indefinite one for anybody with a tab
   * open.
   */
  it("does not write an unchanged session", async () => {
    const store = new MemorySessionStore();
    const sid = generateSid();
    await store.writeSession(sid, { userId: 1 });

    const session = await loadSession(store, sid);
    await commitSession(store, session);

    // Nothing was written, so a store that had expired it would still say so.
    await store.deleteSession(sid);
    await commitSession(store, session);

    expect(await store.findSession(sid)).toBeNull();
  });

  it("deletes a destroyed session and clears the cookie", async () => {
    const store = new MemorySessionStore();
    const session = await loadSession(store, null);
    session.set("userId", 1);
    await commitSession(store, session);

    session.destroy();
    const id = await commitSession(store, session);

    expect(id).toBeNull();
    expect(await store.findSession(session.id)).toBeNull();
  });
});

describe("rotateSession", () => {
  /**
   * The defence against session fixation: an attacker who got a victim to use
   * an id they know still holds it after sign-in, unless the id changes then.
   */
  it("gives the session a new id", async () => {
    const store = new MemorySessionStore();
    const session = await loadSession(store, null);
    session.set("userId", 1);
    await commitSession(store, session);

    const rotated = await rotateSession(store, session);

    expect(rotated.id).not.toBe(session.id);
  });

  it("keeps the contents", async () => {
    const store = new MemorySessionStore();
    const session = new StoredSession(generateSid(), { userId: 1, role: "admin" });

    const rotated = await rotateSession(store, session);

    expect(rotated.toObject()).toEqual({ userId: 1, role: "admin" });
  });

  it("forgets the old id", async () => {
    const store = new MemorySessionStore();
    const session = new StoredSession(generateSid(), { userId: 1 });
    await store.writeSession(session.id, session.toObject());

    await rotateSession(store, session);

    expect(await store.findSession(session.id)).toBeNull();
  });

  it("stores the session under the new id", async () => {
    const store = new MemorySessionStore();
    const session = new StoredSession(generateSid(), { userId: 1 });

    const rotated = await rotateSession(store, session);

    expect(await store.findSession(rotated.id)).toEqual({ userId: 1 });
  });
});
