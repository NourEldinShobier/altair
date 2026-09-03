/**
 * Request and query logging.
 *
 * Mirrors railties/test/application/loading_test.rb's log expectations and
 * actionpack's log subscriber tests. Run against a real connection, because
 * the query count in the request summary comes off the notifications bus and
 * a fake bus would not prove it arrives.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Connection, Model, SchemaStatements, setConnection } from "@altair/orm";
import { Logger, type LogEntry } from "@altair/support";
import { currentQueryStats, logQueries, requestLogging } from "../src/logging.js";

interface ItemRow {
  id: number;
  name: string;
}

class Item extends Model<ItemRow>("items") {}

let entries: LogEntry[];
let logger: Logger;
let subscription: { unsubscribe(): void } | undefined;

const entry = (message: string) => entries.find((one) => one.message === message);

beforeEach(async () => {
  entries = [];
  logger = new Logger({ level: "debug", sink: (_line, one) => entries.push(one) });

  const connection = new Connection("sqlite://:memory:");
  setConnection(connection);
  Item.resetColumnInformation();

  await new SchemaStatements(connection).createTable("items", (t) => {
    t.string("name");
  });
});

afterEach(() => {
  subscription?.unsubscribe();
  subscription = undefined;
});

const run = (handler: () => Promise<Response>, options = {}) =>
  requestLogging({ logger, ...options })(new Request("http://test.host/posts?page=2"), handler);

describe("one line either side of a request", () => {
  it("says what started", async () => {
    await run(async () => new Response("ok"));

    expect(entry("started")?.payload).toMatchObject({ method: "GET", path: "/posts" });
  });

  it("says what happened", async () => {
    await run(async () => new Response("ok", { status: 201 }));

    expect(entry("completed")?.payload).toMatchObject({ status: 201, path: "/posts" });
    expect(entry("completed")?.payload.durationMs).toBeGreaterThanOrEqual(0);
  });

  // A process interleaves a hundred requests, and a line that does not say
  // which one it belongs to is nearly useless when something goes wrong.
  it("tags every line inside it", async () => {
    await run(async () => {
      logger.info("inside");
      return new Response("ok");
    });

    const id = entry("started")?.payload.requestId;

    expect(id).toBeTruthy();
    expect(entry("inside")?.payload.requestId).toBe(id);
    expect(entry("completed")?.payload.requestId).toBe(id);
  });

  it("keeps the id the request arrived with", async () => {
    await requestLogging({ logger })(
      new Request("http://test.host/", { headers: { "x-request-id": "given" } }),
      async () => new Response("ok"),
    );

    expect(entry("started")?.payload.requestId).toBe("given");
  });

  // The dispatcher catches an exception and turns it into a 500 before this
  // ever sees one, so without raising the level here a failed request is an
  // info line and an operator grepping for level=error finds nothing. Found by
  // running a real application rather than this middleware on its own.
  it("logs a 5xx at error level", async () => {
    await run(async () => new Response("no", { status: 500 }));

    expect(entry("completed")?.level).toBe("error");
  });

  it("leaves a 4xx at info, since it is the caller's mistake", async () => {
    await run(async () => new Response("no", { status: 404 }));

    expect(entry("completed")?.level).toBe("info");
  });

  // Logged here and re-thrown: this decides what the operator sees, and the
  // handler above decides what the person sees.
  it("logs a failure and lets it through", async () => {
    await expect(
      run(async () => {
        throw new Error("kaboom");
      }),
    ).rejects.toThrow("kaboom");

    expect(entry("failed")?.level).toBe("error");
    expect(entry("failed")?.payload.error).toBeInstanceOf(Error);
  });

  // A health check every second is noise, and noise is what makes a log
  // useless before it makes it expensive.
  it("can be told to say nothing about a path", async () => {
    await requestLogging({ logger, ignore: (path) => path === "/up" })(
      new Request("http://test.host/up"),
      async () => new Response("ok"),
    );

    expect(entries).toEqual([]);
  });

  it("does not log the query string, which is where the tokens are", async () => {
    await run(async () => new Response("ok"));

    expect(JSON.stringify(entries)).not.toContain("page=2");
  });
});

describe("what the database did", () => {
  it("counts the queries a request ran", async () => {
    subscription = logQueries({ logger });

    await run(async () => {
      await Item.create({ name: "a" });
      await Item.count();
      return new Response("ok");
    });

    expect(entry("completed")?.payload.queries).toBeGreaterThanOrEqual(2);
  });

  // A request that spent 3ms of its 15 in the database is a different problem
  // from one that spent 14, and the total alone does not say which you have.
  it("reports the time separately from the total", async () => {
    subscription = logQueries({ logger });

    await run(async () => {
      await Item.create({ name: "a" });
      return new Response("ok");
    });

    const payload = entry("completed")?.payload ?? {};

    expect(payload.queryMs).toBeGreaterThanOrEqual(0);
    expect(payload.queryMs as number).toBeLessThanOrEqual(payload.durationMs as number);
  });

  it("counts nothing when no queries ran", async () => {
    subscription = logQueries({ logger });
    await run(async () => new Response("ok"));

    expect(entry("completed")?.payload).toMatchObject({ queries: 0 });
  });

  it("logs the statements themselves", async () => {
    subscription = logQueries({ logger });
    await Item.create({ name: "a" });

    expect(entries.some((one) => String(one.payload.sql).includes("INSERT INTO"))).toBe(true);
  });

  // Bindings are the part most likely to be somebody's email address or a
  // password reset token, and a log is copied into places the database is not.
  it("logs the statement without the values", async () => {
    subscription = logQueries({ logger });
    await Item.create({ name: "hunter2" });

    expect(JSON.stringify(entries)).not.toContain("hunter2");
  });

  it("can be told to log only the slow ones", async () => {
    subscription = logQueries({ logger, slowerThan: 10_000 });
    await Item.create({ name: "a" });

    expect(entries.filter((one) => one.message === "sql")).toEqual([]);
  });

  it("still counts the fast ones it does not log", async () => {
    subscription = logQueries({ logger, slowerThan: 10_000 });

    await run(async () => {
      await Item.create({ name: "a" });
      return new Response("ok");
    });

    expect(entry("completed")?.payload.queries).toBeGreaterThanOrEqual(1);
  });

  it("counts nothing outside a request", async () => {
    subscription = logQueries({ logger });

    expect(currentQueryStats()).toBeUndefined();
    await Item.create({ name: "a" });
  });

  // Two requests in flight must not add up into each other's summary.
  it("keeps concurrent requests' counts apart", async () => {
    subscription = logQueries({ logger });

    // Warmed first: a model's first query also reads its columns, and that
    // extra statement would land in whichever request happened to be first.
    await Item.create({ name: "warm" });

    await Promise.all([
      run(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        await Item.create({ name: "slow" });
        return new Response("ok");
      }),
      run(async () => {
        for (let i = 0; i < 4; i += 1) await Item.create({ name: `fast-${i}` });
        return new Response("ok");
      }),
    ]);

    const counts = entries
      .filter((one) => one.message === "completed")
      .map((one) => one.payload.queries as number)
      .sort((a, b) => a - b);

    expect(counts).toEqual([1, 4]);
  });
});
