/**
 * Broadcasting over PostgreSQL's LISTEN/NOTIFY, ported from
 * `actioncable/test/subscription_adapter/postgresql_test.rb` and the shared
 * adapter cases in `actioncable/test/subscription_adapter/common.rb`.
 *
 * The cases worth having are the ones about the two connections and about a
 * channel name too long to be an identifier — both fail silently rather than
 * loudly.
 */

import { describe, expect, it } from "bun:test";
import {
  Listener,
  MAX_IDENTIFIER_BYTES,
  MAX_PAYLOAD_BYTES,
  PayloadTooLarge,
  type PgConnection,
  escapeIdentifier,
  escapeString,
  listenStatement,
  notifyStatement,
  pgChannelIdentifier,
  runCommand,
  unlistenStatement,
  withBroadcastConnection,
  withSubscriptionsConnection,
} from "../src/postgresql_adapter.js";

function fakeConnection(): PgConnection & { ran: string[]; closed: boolean } {
  const connection = {
    ran: [] as string[],
    closed: false,
    execute(sql: string) {
      connection.ran.push(sql);

      return Promise.resolve(undefined);
    },
    close() {
      connection.closed = true;
    },
  };

  return connection;
}

describe("naming a channel", () => {
  it("uses the stream name when it fits", () => {
    expect(pgChannelIdentifier("posts:1")).toBe("posts:1");
  });

  /**
   * Postgres truncates past 63 bytes, so two long names agreeing in their
   * first 63 become one channel and every subscriber to either receives both.
   */
  it("hashes a name too long to be an identifier", () => {
    const long = `${"a".repeat(MAX_IDENTIFIER_BYTES)}x`;

    expect(pgChannelIdentifier(long).length).toBeLessThanOrEqual(MAX_IDENTIFIER_BYTES);
    expect(pgChannelIdentifier(long)).not.toBe(long);
  });

  it("does not collide on a shared prefix", () => {
    const prefix = "a".repeat(MAX_IDENTIFIER_BYTES);

    expect(pgChannelIdentifier(`${prefix}1`)).not.toBe(pgChannelIdentifier(`${prefix}2`));
  });

  /** The whole name, not a prefix of it — otherwise the hash has the same flaw. */
  it("takes every character into account", () => {
    const long = "d".repeat(100);

    expect(pgChannelIdentifier(`${long}posts`)).not.toBe(pgChannelIdentifier(`${long}pasts`));
    expect(pgChannelIdentifier(`x${long}`)).not.toBe(pgChannelIdentifier(`y${long}`));
  });

  it("is stable", () => {
    const long = "b".repeat(200);

    expect(pgChannelIdentifier(long)).toBe(pgChannelIdentifier(long));
  });

  it("counts bytes, not characters", () => {
    // Each of these is three bytes, so 30 of them exceed the limit at 22.
    expect(pgChannelIdentifier("日".repeat(30))).not.toBe("日".repeat(30));
    expect(pgChannelIdentifier("日".repeat(10))).toBe("日".repeat(10));
  });
});

describe("escaping", () => {
  /**
   * A stream name is often built from a record's attributes, so an embedded
   * quote would end the identifier and turn the rest into SQL.
   */
  it("doubles a quote in an identifier", () => {
    expect(escapeIdentifier('we"ird')).toBe('"we""ird"');
  });

  it("doubles a quote in a payload", () => {
    expect(escapeString("it's")).toBe("'it''s'");
  });

  it("escapes what it puts in a statement", () => {
    expect(notifyStatement("a", "it's")).toContain("'it''s'");
    expect(listenStatement('we"ird')).toBe('LISTEN "we""ird"');
    expect(unlistenStatement("posts")).toBe('UNLISTEN "posts"');
  });

  it("uses the hashed name in every statement for a long stream", () => {
    const long = "c".repeat(200);

    expect(listenStatement(long)).toContain(pgChannelIdentifier(long));
    expect(unlistenStatement(long)).toContain(pgChannelIdentifier(long));
    expect(notifyStatement(long, "x")).toContain(pgChannelIdentifier(long));
  });
});

describe("the payload limit", () => {
  it("allows one that fits", () => {
    expect(() => notifyStatement("a", "x".repeat(MAX_PAYLOAD_BYTES))).not.toThrow();
  });

  /**
   * Refused here rather than by Postgres, because the failure otherwise
   * appears as a broadcast that stops arriving in production and nowhere else.
   */
  it("refuses one that does not", () => {
    expect(() => notifyStatement("a", "x".repeat(MAX_PAYLOAD_BYTES + 1))).toThrow(PayloadTooLarge);
  });

  it("says what to do instead", () => {
    expect(() => notifyStatement("a", "x".repeat(MAX_PAYLOAD_BYTES + 1))).toThrow(
      "Broadcast an id",
    );
  });

  it("measures bytes", () => {
    expect(() => notifyStatement("a", "日".repeat(MAX_PAYLOAD_BYTES / 2))).toThrow(PayloadTooLarge);
  });
});

describe("the two connections", () => {
  /**
   * A connection issuing LISTEN is committed to waiting and cannot serve
   * anything else — held from the pool it is one the pool has lost, taken from
   * it one the pool believes it can still hand to a request.
   */
  it("opens the listening one outside the pool", async () => {
    const outside = fakeConnection();
    const pooled = fakeConnection();
    const source = {
      newConnection: () => Promise.resolve(outside),
      withConnection: <T>(body: (c: PgConnection) => Promise<T>) => body(pooled),
    };

    await withSubscriptionsConnection(source, "cable", (connection) => {
      expect(connection).toBe(outside);

      return Promise.resolve(undefined);
    });

    expect(pooled.ran).toEqual([]);
  });

  /**
   * Otherwise a long-lived connection looks exactly like an application
   * connection that has been idle in transaction for days.
   */
  it("names itself so it can be found in pg_stat_activity", async () => {
    const outside = fakeConnection();

    await withSubscriptionsConnection(
      {
        newConnection: () => Promise.resolve(outside),
        withConnection: <T>(body: (c: PgConnection) => Promise<T>) => body(outside),
      },
      "cable",
      () => Promise.resolve(undefined),
    );

    expect(outside.ran[0]).toBe('SET application_name = "cable"');
  });

  /** The alternative is a Postgres backend per restart that nothing ever closes. */
  it("closes it when the body throws", async () => {
    const outside = fakeConnection();

    await expect(
      withSubscriptionsConnection(
        {
          newConnection: () => Promise.resolve(outside),
          withConnection: <T>(body: (c: PgConnection) => Promise<T>) => body(outside),
        },
        "cable",
        () => Promise.reject(new Error("boom")),
      ),
    ).rejects.toThrow("boom");

    expect(outside.closed).toBe(true);
  });

  /**
   * Borrowed rather than kept: a broadcast is a single NOTIFY, and holding a
   * connection between them takes one out of the pool for the life of the
   * process to do nothing most of the time.
   */
  it("borrows a pooled one to broadcast", async () => {
    const pooled = fakeConnection();
    let released = false;

    await withBroadcastConnection(
      {
        newConnection: () => Promise.resolve(pooled),
        withConnection: async <T>(body: (c: PgConnection) => Promise<T>) => {
          const result = await body(pooled);
          released = true;

          return result;
        },
      },
      (connection) => connection.execute(notifyStatement("posts", "hi")),
    );

    expect(released).toBe(true);
    expect(pooled.ran[0]).toContain("NOTIFY");
  });
});

describe("the listener's queue", () => {
  /**
   * The listening connection is blocked waiting for notifications, so a LISTEN
   * issued from another task would have to wait for the wait to end — which it
   * does not.
   */
  it("queues rather than executing", () => {
    const listener = new Listener();
    listener.addChannel("posts");
    listener.removeChannel("posts");

    expect(listener.drain()).toEqual([
      { action: "listen", channel: "posts" },
      { action: "unlisten", channel: "posts" },
    ]);
  });

  it("empties when drained", () => {
    const listener = new Listener();
    listener.addChannel("posts");
    listener.drain();

    expect(listener.drain()).toEqual([]);
  });

  /**
   * Only the first subscriber issues LISTEN: Postgres ignores a duplicate, but
   * the queue would carry one command per subscriber and the matching UNLISTEN
   * count would then be wrong.
   */
  it("listens once however many subscribe", () => {
    const listener = new Listener();
    listener.addSubscriber("posts", () => undefined);
    listener.addSubscriber("posts", () => undefined);

    expect(listener.drain()).toHaveLength(1);
  });

  it("tells a later subscriber it is listening straight away", () => {
    const listener = new Listener();
    let confirmed = 0;
    listener.addSubscriber("posts", () => undefined);
    listener.drain();
    listener.addSubscriber(
      "posts",
      () => undefined,
      () => {
        confirmed += 1;
      },
    );

    expect(confirmed).toBe(1);
  });

  /**
   * Leaving the LISTEN would keep delivering notifications nothing reads —
   * cheap per message and unbounded over the life of a process.
   */
  it("unlistens when the last subscriber goes", () => {
    const listener = new Listener();
    const first = () => undefined;
    const second = () => undefined;
    listener.addSubscriber("posts", first);
    listener.addSubscriber("posts", second);
    listener.drain();

    listener.removeSubscriber("posts", first);

    expect(listener.drain()).toEqual([]);

    listener.removeSubscriber("posts", second);

    expect(listener.drain()).toEqual([{ action: "unlisten", channel: "posts" }]);
    expect(listener.channels).toEqual([]);
  });

  it("ignores an unsubscribe for a channel it does not have", () => {
    const listener = new Listener();
    listener.removeSubscriber("posts", () => undefined);

    expect(listener.drain()).toEqual([]);
  });

  it("delivers to every subscriber", () => {
    const listener = new Listener();
    const seen: string[] = [];
    listener.addSubscriber("posts", (message) => seen.push(`a:${message}`));
    listener.addSubscriber("posts", (message) => seen.push(`b:${message}`));

    expect(listener.dispatch("posts", "hi")).toBe(2);
    expect(seen).toEqual(["a:hi", "b:hi"]);
  });

  it("delivers nothing for a channel nobody wants", () => {
    expect(new Listener().dispatch("posts", "hi")).toBe(0);
  });

  /**
   * A message already in flight reaches everyone subscribed when it arrived.
   * Iterating the live set instead lets one subscriber's handler cancel
   * delivery to another — a message half-delivered, which nothing on either
   * side can detect.
   */
  it("delivers to everyone who was subscribed when the message arrived", () => {
    const listener = new Listener();
    const seen: string[] = [];
    const second = (message: string) => seen.push(`b:${message}`);
    listener.addSubscriber("posts", (message) => {
      seen.push(`a:${message}`);
      listener.removeSubscriber("posts", second);
    });
    listener.addSubscriber("posts", second);

    listener.dispatch("posts", "hi");

    expect(seen).toEqual(["a:hi", "b:hi"]);
  });

  it("survives a subscriber that unsubscribes itself", () => {
    const listener = new Listener();
    const seen: string[] = [];
    const first = (message: string) => {
      seen.push(message);
      listener.removeSubscriber("posts", first);
    };
    listener.addSubscriber("posts", first);

    expect(() => listener.dispatch("posts", "hi")).not.toThrow();
    expect(seen).toEqual(["hi"]);
  });
});

describe("running a queued command", () => {
  it("issues the right statement", async () => {
    const connection = fakeConnection();

    await runCommand(connection, { action: "listen", channel: "posts" });
    await runCommand(connection, { action: "unlisten", channel: "posts" });

    expect(connection.ran).toEqual(['LISTEN "posts"', 'UNLISTEN "posts"']);
  });

  /**
   * After the statement, not when it was queued: a subscriber told it is
   * listening before Postgres agrees misses anything broadcast in between, and
   * missing the first message of a stream is the one failure it cannot detect.
   */
  it("confirms only once Postgres has agreed", async () => {
    const order: string[] = [];
    const connection: PgConnection = {
      execute(sql: string) {
        order.push(sql);

        return Promise.resolve(undefined);
      },
    };

    await runCommand(connection, {
      action: "listen",
      channel: "posts",
      onSuccess: () => order.push("confirmed"),
    });

    expect(order).toEqual(['LISTEN "posts"', "confirmed"]);
  });
});
