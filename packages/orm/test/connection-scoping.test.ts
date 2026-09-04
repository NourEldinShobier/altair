/**
 * Which database is in force and who decided it, ported from
 * `activerecord/test/cases/connection_adapters/connection_handlers_multi_role_test.rb`,
 * `activerecord/test/cases/connection_adapters/connection_handlers_sharding_test.rb`
 * and `activerecord/test/cases/middleware/database_selector_test.rb`.
 *
 * The failure this whole area exists to prevent is the silent one: a read
 * routed to a replica that has not caught up returns stale rows and reports
 * nothing.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  BASE_CLASS,
  SEND_TO_REPLICA_DELAY,
  type WriteContext,
  connectedToAllShards,
  connectedToStack,
  connectingTo,
  databaseResolver,
  preventingWrites,
  readingRequest,
  roleFor,
  selectDatabase,
  sessionContext,
  shardFor,
  withConnectionScope,
} from "../src/connection-scoping.js";

afterEach(() => {
  connectedToStack().length = 0;
});

describe("the stack of entries", () => {
  it("starts empty, with everything on the writer", () => {
    expect(connectedToStack()).toEqual([]);
    expect(roleFor()).toBe("writing");
    expect(shardFor()).toBe("default");
    expect(preventingWrites()).toBe(false);
  });

  it("answers from the entry that was pushed", () => {
    connectingTo({ role: "reading", shard: "one" });

    expect(roleFor()).toBe("reading");
    expect(shardFor()).toBe("one");
  });

  /** `connected_to` nests, and the inner block is the answer. */
  it("answers from the newest entry", () => {
    connectingTo({ role: "reading" });
    connectingTo({ role: "writing" });

    expect(roleFor()).toBe("writing");
  });

  /**
   * An entry that names only a role must not also answer the shard question —
   * a `connected_to(role: :reading)` inside a shard block would otherwise move
   * the query to another tenant's database.
   */
  it("skips an entry that does not name what was asked", () => {
    connectingTo({ shard: "one" });
    connectingTo({ role: "reading" });

    expect(shardFor()).toBe("one");
    expect(roleFor()).toBe("reading");
  });

  /**
   * An application mid-migration has one group of models on a new database and
   * the rest where they were, which a single global scope cannot express.
   */
  it("applies an entry only to the classes it names", () => {
    connectingTo({ role: "reading", klasses: ["Dog"] });

    expect(roleFor("Dog")).toBe("reading");
    expect(roleFor("Invoice")).toBe("writing");
  });

  it("applies an entry naming the base class to everything", () => {
    connectingTo({ role: "reading", klasses: [BASE_CLASS] });

    expect(roleFor("Invoice")).toBe("reading");
  });

  it("removes the entry it pushed", () => {
    const done = connectingTo({ role: "reading" });
    done();

    expect(roleFor()).toBe("writing");
  });

  /**
   * Removing its own entry rather than the last one: a body that pushed an
   * entry and failed to pop it would otherwise have that entry removed here and
   * its own left behind.
   */
  it("removes its own entry, not the newest", () => {
    const done = connectingTo({ role: "reading" });
    connectingTo({ shard: "one" });
    done();

    expect(roleFor()).toBe("writing");
    expect(shardFor()).toBe("one");
  });

  it("does not remove twice", () => {
    const first = connectingTo({ role: "reading" });
    const second = connectingTo({ role: "reading" });
    first();
    first();

    expect(connectedToStack()).toHaveLength(1);

    second();
  });
});

describe("preventing writes", () => {
  /**
   * A write on a follower either fails somewhere far from its cause or, on a
   * writable follower, succeeds and is discarded at the next replication event.
   */
  it("comes on by default under a reading role", () => {
    connectingTo({ role: "reading" });

    expect(preventingWrites()).toBe(true);
  });

  it("refuses to be turned off under a reading role", () => {
    expect(() => connectingTo({ role: "reading", preventWrites: false })).toThrow(
      "cannot set `preventWrites` to false when `role` is `reading`",
    );
  });

  it("stays off by default on the writer", () => {
    connectingTo({ role: "writing" });

    expect(preventingWrites()).toBe(false);
  });

  /**
   * The case worth having: writes prevented on the *writer*, so an application
   * can find which code paths break under a read-only failover before the
   * failover rather than during it.
   */
  it("can be turned on for the writer", () => {
    connectingTo({ role: "writing", preventWrites: true });

    expect(preventingWrites()).toBe(true);
    expect(roleFor()).toBe("writing");
  });

  /** `false` is an answer, not an absence — an inner block must be able to lift it. */
  it("is answered by the newest entry that names it", () => {
    connectingTo({ role: "writing", preventWrites: true });
    connectingTo({ role: "writing", preventWrites: false });

    expect(preventingWrites()).toBe(false);
  });
});

describe("one stack per request", () => {
  /**
   * Without a scope every request shares the process-level stack, and an entry
   * one request pushed decides another request's database.
   */
  it("does not leak an entry out of its scope", async () => {
    await withConnectionScope(() => {
      connectingTo({ role: "reading" });

      expect(roleFor()).toBe("reading");
    });

    expect(roleFor()).toBe("writing");
  });

  it("keeps two concurrent scopes apart", async () => {
    const seen: string[] = [];

    await Promise.all([
      withConnectionScope(async () => {
        connectingTo({ shard: "one" });
        await Promise.resolve();
        seen.push(shardFor());
      }),
      withConnectionScope(async () => {
        connectingTo({ shard: "two" });
        await Promise.resolve();
        seen.push(shardFor());
      }),
    ]);

    expect(seen.sort()).toEqual(["one", "two"]);
  });
});

describe("every shard in turn", () => {
  it("runs the body once per shard, under that shard", async () => {
    const seen = await connectedToAllShards(["one", "two"], () => shardFor());

    expect(seen).toEqual(["one", "two"]);
  });

  /** In turn rather than at once: shard-wide work is a migration or a backfill. */
  it("does not leave a shard in force afterwards", async () => {
    await connectedToAllShards(["one", "two"], () => undefined);

    expect(shardFor()).toBe("default");
    expect(connectedToStack()).toEqual([]);
  });

  it("does not leave one in force when the body throws", async () => {
    await expect(
      connectedToAllShards(["one"], () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(connectedToStack()).toEqual([]);
  });

  it("carries the role onto each shard", async () => {
    const seen = await connectedToAllShards(["one"], () => roleFor(), { role: "reading" });

    expect(seen).toEqual(["reading"]);
  });

  /** Silently doing nothing would look like a backfill that ran. */
  it("refuses a model with no shards", async () => {
    await expect(connectedToAllShards([], () => undefined)).rejects.toThrow(
      "not connected to any shards",
    );
  });
});

describe("which requests read", () => {
  /**
   * The safe, idempotent methods. A POST is a write even when it happens not to
   * write anything — guessing the other way sends a real write to a replica.
   */
  it("is the safe methods", () => {
    expect(readingRequest({ method: "GET" })).toBe(true);
    expect(readingRequest({ method: "HEAD" })).toBe(true);
    expect(readingRequest({ method: "QUERY" })).toBe(true);
    expect(readingRequest({ method: "POST" })).toBe(false);
    expect(readingRequest({ method: "DELETE" })).toBe(false);
  });

  it("does not care about case", () => {
    expect(readingRequest({ method: "get" })).toBe(true);
  });
});

describe("where the last write is remembered", () => {
  it("is nothing until something is written", () => {
    expect(sessionContext({}).lastWriteTimestamp()).toBe(0);
  });

  it("is written into the session", () => {
    const session: Record<string, unknown> = {};
    sessionContext(session, () => 1_000).updateLastWriteTimestamp();

    expect(sessionContext(session).lastWriteTimestamp()).toBe(1_000);
  });

  /**
   * Per visitor: a process-wide answer would put every visitor on the primary
   * because somebody wrote, which is the replica doing no work at all.
   */
  it("is one visitor's, not another's", () => {
    const mine: Record<string, unknown> = {};
    sessionContext(mine, () => 1_000).updateLastWriteTimestamp();

    expect(sessionContext({}).lastWriteTimestamp()).toBe(0);
  });

  /** A session carrying junk under the key must not be read as a timestamp. */
  it("ignores a value that is not a timestamp", () => {
    expect(sessionContext({ lastWrite: "soon" }).lastWriteTimestamp()).toBe(0);
  });
});

describe("deciding between primary and replica", () => {
  const contextAt = (lastWrite: number): WriteContext => ({
    lastWriteTimestamp: () => lastWrite,
    updateLastWriteTimestamp: () => undefined,
  });

  it("waits two seconds by default", () => {
    expect(databaseResolver(contextAt(0)).delay).toBe(SEND_TO_REPLICA_DELAY);
    expect(SEND_TO_REPLICA_DELAY).toBe(2_000);
  });

  /**
   * The whole point: a redirect after a create must not read from a replica
   * that has not caught up, or the page renders as it was before and nothing
   * reports it.
   */
  it("reads from the primary inside the window", async () => {
    const resolver = databaseResolver(contextAt(1_000), { now: () => 2_500 });

    expect(await resolver.read(() => roleFor())).toBe("writing");
  });

  it("reads from the replica once the delay has passed", async () => {
    const resolver = databaseResolver(contextAt(1_000), { now: () => 3_000 });

    expect(await resolver.read(() => roleFor())).toBe("reading");
  });

  it("takes a different delay", async () => {
    const resolver = databaseResolver(contextAt(1_000), { now: () => 1_500, delay: 100 });

    expect(await resolver.read(() => roleFor())).toBe("reading");
  });

  /**
   * A read routed to the primary is still a read. Letting it write would hide a
   * bug that appears the moment the delay elapses and the same code runs
   * against a replica.
   */
  it("prevents writes on either side of a read", async () => {
    expect(
      await databaseResolver(contextAt(0), { now: () => 0 }).read(() => preventingWrites()),
    ).toBe(true);
    expect(
      await databaseResolver(contextAt(0), { now: () => 10_000 }).read(() => preventingWrites()),
    ).toBe(true);
  });

  it("writes to the primary, with writes allowed", async () => {
    const resolver = databaseResolver(contextAt(0));

    expect(await resolver.write(() => [roleFor(), preventingWrites()])).toEqual(["writing", false]);
  });

  it("records the write", async () => {
    let written = 0;
    const resolver = databaseResolver({
      lastWriteTimestamp: () => 0,
      updateLastWriteTimestamp: () => {
        written += 1;
      },
    });

    await resolver.write(() => undefined);

    expect(written).toBe(1);
  });

  /**
   * A write that raised may still have committed, so a visitor whose failed
   * request wrote something must not then be sent to a replica that has not
   * seen it.
   */
  it("records a write that failed", async () => {
    let written = 0;
    const resolver = databaseResolver({
      lastWriteTimestamp: () => 0,
      updateLastWriteTimestamp: () => {
        written += 1;
      },
    });

    await expect(
      resolver.write(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(written).toBe(1);
  });

  it("does not leave an entry behind", async () => {
    await databaseResolver(contextAt(0)).read(() => undefined);
    await databaseResolver(contextAt(0)).write(() => undefined);

    expect(connectedToStack()).toEqual([]);
  });

  /**
   * Especially when the body failed: an entry left behind by a failed request
   * decides the database for whatever runs next.
   */
  it("does not leave an entry behind when the body throws", async () => {
    await expect(
      databaseResolver(contextAt(0)).read(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(connectedToStack()).toEqual([]);
  });
});

describe("the middleware", () => {
  const session: Record<string, unknown> = {};

  it("sends a read to the replica and a write to the primary", async () => {
    const middleware = selectDatabase(() => sessionContext(session, () => 0), {
      now: () => 10_000,
    });

    expect(await middleware({ method: "GET" }, () => roleFor())).toBe("reading");
    expect(await middleware({ method: "POST" }, () => roleFor())).toBe("writing");
  });

  /** The reason the context is per request: this visitor just wrote. */
  it("keeps a visitor on the primary after their own write", async () => {
    const mine: Record<string, unknown> = {};
    let clock = 1_000;
    const middleware = selectDatabase(() => sessionContext(mine, () => clock), {
      now: () => clock,
    });

    await middleware({ method: "POST" }, () => undefined);
    clock += 500;

    expect(await middleware({ method: "GET" }, () => roleFor())).toBe("writing");

    clock += 2_000;

    expect(await middleware({ method: "GET" }, () => roleFor())).toBe("reading");
  });

  /**
   * A scope per request, so an entry this request pushed cannot decide another
   * request's database.
   */
  it("gives each request its own stack", async () => {
    const middleware = selectDatabase(() => sessionContext({}, () => 0), { now: () => 10_000 });
    await middleware({ method: "GET" }, () => {
      // A request that switched shard and never switched back. Without a stack
      // of its own, that entry decides the next request's database.
      connectingTo({ shard: "one" });
    });

    expect(connectedToStack()).toEqual([]);
    expect(shardFor()).toBe("default");
  });

  /**
   * One context per request, because the question is whether *this* visitor
   * wrote. Sharing one would put everybody on the primary because somebody did.
   */
  it("asks the request whose session it is", async () => {
    const wrote: Record<string, unknown> = { lastWrite: 9_000 };
    const middleware = selectDatabase(
      (request: { method: string; session: Record<string, unknown> }) =>
        sessionContext(request.session),
      { now: () => 10_000 },
    );

    expect(await middleware({ method: "GET", session: wrote }, () => roleFor())).toBe("writing");
    expect(await middleware({ method: "GET", session: {} }, () => roleFor())).toBe("reading");
  });
});
