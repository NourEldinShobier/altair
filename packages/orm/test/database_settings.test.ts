/**
 * Two settings a connection can be asked about, ported from `ctype` in
 * `activerecord/test/cases/adapters/postgresql/postgresql_adapter_test.rb` and
 * `show_variable` in
 * `activerecord/test/cases/adapters/mysql2/mysql2_adapter_test.rb`.
 *
 * Both are asked of exactly one adapter and answer nothing on the others,
 * which is the part worth pinning: a caller that got a plausible-looking
 * answer from the wrong server would act on it.
 */

import { describe, expect, it } from "bun:test";
import type { Connection } from "../src/connection.js";
import { ctype, databaseInfo, showVariable } from "../src/database_info.js";
import { testConnection } from "./support/database.js";

/** A connection that reports an adapter and answers queries from a table. */
function fake(adapter: string, answers: Record<string, unknown>): Connection {
  return {
    adapter,
    query: async (sql: string) => {
      const key = Object.keys(answers).find((one) => sql.includes(one));

      if (key === undefined) throw new Error(`no answer for ${sql}`);

      return [{ value: answers[key] }];
    },
  } as unknown as Connection;
}

describe("the database's character classification", () => {
  it("is read from the catalogue on postgresql", async () => {
    const connection = fake("postgres", { datctype: "en_US.UTF-8" });

    expect(await ctype(connection)).toBe("en_US.UTF-8");
  });

  /**
   * MySQL folds it into the collation and SQLite has neither, so an answer
   * from either would be an invention.
   */
  it("is nothing on the other two", async () => {
    expect(await ctype(fake("mysql", { datctype: "en_US.UTF-8" }))).toBeUndefined();
    expect(await ctype(fake("sqlite", { datctype: "en_US.UTF-8" }))).toBeUndefined();
  });

  /** Introspection must never be the thing that takes an application down. */
  it("is nothing when the catalogue cannot be read", async () => {
    expect(await ctype(fake("postgres", {}))).toBeUndefined();
  });

  it("joins the rest of what a connection reports", async () => {
    const info = await databaseInfo(
      // Matched by substring and first key wins, so the specific catalogue
      // queries have to come before `current_database`, which they all mention.
      fake("postgres", {
        datctype: "en_US.UTF-8",
        datcollate: "en_US.UTF-8",
        pg_encoding_to_char: "UTF8",
        current_schema: "public",
        version: "16.2",
        current_database: "app",
      }),
    );

    expect(info.ctype).toBe("en_US.UTF-8");
  });

  it("is present, and undefined, on a connection that has none", async () => {
    const info = await databaseInfo(await testConnection());

    expect(Object.hasOwn(info, "ctype")).toBe(true);
  });
});

describe("a mysql server variable", () => {
  it("is read with the double-at spelling", async () => {
    const connection = fake("mysql", { "@@max_allowed_packet": 67_108_864 });

    expect(await showVariable(connection, "max_allowed_packet")).toBe("67108864");
  });

  /**
   * The variables worth reading are the ones that came and went between
   * versions, and the caller is asking precisely because it does not know
   * whether this server has one.
   */
  it("is nothing for one that does not exist", async () => {
    expect(await showVariable(fake("mysql", {}), "no_such_variable")).toBeUndefined();
  });

  it("is nothing on a server that has no such thing", async () => {
    expect(await showVariable(fake("postgres", { "@@x": 1 }), "x")).toBeUndefined();
    expect(await showVariable(fake("sqlite", { "@@x": 1 }), "x")).toBeUndefined();
  });

  /**
   * `@@` takes no placeholder, so this is string-built by necessity — and a
   * variable name is exactly the kind of thing that arrives from
   * configuration.
   */
  it("refuses a name that is not a name", async () => {
    await expect(showVariable(fake("mysql", {}), "x; DROP TABLE users")).rejects.toThrow(
      "not a server variable name",
    );
    await expect(showVariable(fake("mysql", {}), "")).rejects.toThrow();
    await expect(showVariable(fake("mysql", {}), "1abc")).rejects.toThrow();
  });

  it("takes an ordinary name", async () => {
    await expect(showVariable(fake("mysql", { "@@sql_mode": "" }), "sql_mode")).resolves.toBe("");
  });
});
