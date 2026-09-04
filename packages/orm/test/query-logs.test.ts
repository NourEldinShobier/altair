/**
 * SQL comments naming the code that issued the query, ported from
 * `activerecord/test/cases/query_logs_test.rb`.
 *
 * The problem belongs to whoever is looking at the database rather than at the
 * application. A slow-query log, `pg_stat_statements`, a lock graph at three in
 * the morning — all of them show the statement and none of them show which line
 * of which action produced it.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { Current, notifications } from "@altair/support";
import { configureQueryLogs, disableQueryLogs, queryLogComment } from "../src/query-logs.js";
import { SchemaStatements } from "../src/schema.js";
import { isSqlite, testConnection } from "./support/database.js";

afterEach(() => {
  disableQueryLogs();
});

const inRequest = async (state: Record<string, unknown>): Promise<string> =>
  await Current.run(state as never, () => queryLogComment());

describe("off by default", () => {
  it("writes nothing", () => {
    expect(queryLogComment()).toBe("");
  });

  it("writes nothing again after being turned off", () => {
    configureQueryLogs({ application: "blog" });
    disableQueryLogs();

    expect(queryLogComment()).toBe("");
  });
});

describe("what it writes", () => {
  it("names the application", () => {
    configureQueryLogs({ tags: ["application"], application: "blog" });

    expect(queryLogComment()).toBe(" /*application:blog*/");
  });

  it("names the controller and action of the request in flight", async () => {
    configureQueryLogs({ tags: ["controller", "action"] });

    const comment = await inRequest({ controller: "posts", action: "show" });

    expect(comment).toBe(" /*controller:posts,action:show*/");
  });

  it("keeps the tags in the order they were configured", async () => {
    configureQueryLogs({ tags: ["action", "controller"] });

    const comment = await inRequest({ controller: "posts", action: "show" });

    expect(comment).toBe(" /*action:show,controller:posts*/");
  });

  it("carries the request id, so a query joins up with the log lines", async () => {
    configureQueryLogs({ tags: ["request_id"] });

    const comment = await inRequest({ requestId: "abc-123" });

    expect(comment).toContain("request_id:abc-123");
  });

  it("takes a tag of the application's own", () => {
    configureQueryLogs({ tags: [() => "shard:eu-west"] });

    expect(queryLogComment()).toBe(" /*shard:eu-west*/");
  });
});

/**
 * A tag that answers nothing is left out rather than written empty, so a query
 * from a job does not carry `controller:` with nothing after it.
 */
describe("a tag with nothing to say", () => {
  it("is left out", () => {
    configureQueryLogs({ tags: ["application", "controller"], application: "blog" });

    expect(queryLogComment()).toBe(" /*application:blog*/");
  });

  it("leaves no comment at all when none of them apply", () => {
    configureQueryLogs({ tags: ["controller", "action"] });

    expect(queryLogComment()).toBe("");
  });

  it("leaves out a tag nobody defined, rather than writing it empty", () => {
    configureQueryLogs({ tags: ["nonsense"], application: "blog" });

    expect(queryLogComment()).toBe("");
  });

  it("leaves out a function that answers undefined", () => {
    configureQueryLogs({ tags: [() => undefined] });

    expect(queryLogComment()).toBe("");
  });
});

/**
 * The tags come from a request — a controller name from a route, an id from a
 * header. A value containing the comment terminator would end the comment early
 * and put the rest into the statement, which is SQL injection through the
 * diagnostics.
 */
describe("a value that tries to end the comment", () => {
  it("cannot close it early", async () => {
    configureQueryLogs({ tags: ["request_id"] });

    const comment = await inRequest({ requestId: "x*/; DROP TABLE users; --" });

    expect(comment).not.toContain("*/;");
    expect(comment.match(/\*\//g)).toHaveLength(1);
  });

  it("cannot open a nested one either", async () => {
    configureQueryLogs({ tags: ["request_id"] });

    const comment = await inRequest({ requestId: "a/*b" });

    expect(comment.match(/\/\*/g)).toHaveLength(1);
  });

  it("does not let a newline break the statement up", async () => {
    configureQueryLogs({ tags: ["request_id"] });

    const comment = await inRequest({ requestId: "a\nb" });

    expect(comment).not.toContain("\n");
  });
});

/**
 * A query from a migration or a console has no request. The diagnostics must
 * not be the thing that makes it fail.
 */
describe("outside a request", () => {
  it("writes what it can and does not throw", () => {
    configureQueryLogs({ tags: ["application", "controller"], application: "blog" });

    expect(() => queryLogComment()).not.toThrow();
    expect(queryLogComment()).toBe(" /*application:blog*/");
  });
});

/**
 * The check that matters: a comment nothing appends is a feature nothing uses.
 * This runs a real statement with the tags on, which is also the only way to
 * find out the comment is valid SQL on the database in front of us.
 */
describe("reaching the database", () => {
  /**
   * Asserted through the notification because that carries the statement as it
   * was run — one variable feeds both the driver and the bus. Running the query
   * and checking it did not error proves nothing on its own: a comment is valid
   * SQL, so an untagged statement passes that check too. It did, until this
   * test was added.
   */
  it("appends the comment to the statement it runs", async () => {
    const connection = await testConnection();
    const seen: string[] = [];

    const subscription = notifications.subscribe("sql.altair", (event) => {
      seen.push(String((event.payload as { sql: string }).sql));
    });

    try {
      await new SchemaStatements(connection).createTable("posts", (t) => t.string("title"));

      configureQueryLogs({ tags: ["application"], application: "blog" });

      await Current.run({ controller: "posts", action: "index" } as never, () =>
        connection.query("SELECT title FROM posts"),
      );

      expect(seen.at(-1)).toContain("/*application:blog*/");
    } finally {
      subscription.unsubscribe();
      if (isSqlite) await connection.close();
    }
  });

  it("leaves the statement alone when the tags are off", async () => {
    const connection = await testConnection();
    const seen: string[] = [];

    const subscription = notifications.subscribe("sql.altair", (event) => {
      seen.push(String((event.payload as { sql: string }).sql));
    });

    try {
      await new SchemaStatements(connection).createTable("posts", (t) => t.string("title"));
      await connection.query("SELECT title FROM posts");

      expect(seen.at(-1)).not.toContain("/*");
    } finally {
      subscription.unsubscribe();
      if (isSqlite) await connection.close();
    }
  });

  it("runs a tagged statement successfully", async () => {
    const connection = await testConnection();

    try {
      await new SchemaStatements(connection).createTable("posts", (t) => t.string("title"));
      await connection.execute("INSERT INTO posts (title) VALUES ('A')");

      configureQueryLogs({ tags: ["application", "controller", "action"], application: "blog" });

      const rows = await Current.run({ controller: "posts", action: "index" } as never, () =>
        connection.query<{ title: string }>("SELECT title FROM posts"),
      );

      expect(rows.map((row) => row.title)).toEqual(["A"]);
    } finally {
      if (isSqlite) await connection.close();
    }
  });

  /**
   * A value that closed the comment early would put the rest of it into the
   * statement. Here that is a syntax error rather than a silent injection,
   * which is the point of sanitizing before it ever reaches the driver.
   */
  it("survives a request id that tries to escape the comment", async () => {
    const connection = await testConnection();

    try {
      await new SchemaStatements(connection).createTable("posts", (t) => t.string("title"));

      configureQueryLogs({ tags: ["request_id"] });

      const rows = await Current.run({ requestId: "x*/ UNION SELECT 1 --" } as never, () =>
        connection.query("SELECT title FROM posts"),
      );

      expect(rows).toEqual([]);
    } finally {
      if (isSqlite) await connection.close();
    }
  });
});
