/**
 * What database is actually on the other end, ported from the introspection
 * cases in `activerecord/test/cases/adapter_test.rb`.
 *
 * A connection string says what somebody meant to connect to; these say what
 * they got. The clearest case is MySQL's `utf8`, which is not UTF-8: three
 * bytes per character, so every emoji is truncated at the first four-byte
 * character and takes the rest of the string with it.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { setConnection } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import {
  advisoryLocksEnabled,
  charsetCurrent,
  charsetHoldsEveryCharacter,
  collationCurrent,
  currentDatabase,
  currentSchema,
  databaseExists,
  databaseInfo,
  databaseVersion,
} from "../src/database_info.js";
import { isSqlite, testConnection } from "./support/database.js";

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);
});

afterEach(async () => {
  if (isSqlite) await connection.close();
});

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

describe("against the real connection", () => {
  it("reports a version", async () => {
    expect(await databaseVersion(connection)).toBeDefined();
  });

  it("reports a database", async () => {
    expect(await currentDatabase(connection)).toBeDefined();
  });

  it("reports a charset", async () => {
    expect(await charsetCurrent(connection)).toBeDefined();
  });

  it("reports a collation", async () => {
    expect(await collationCurrent(connection)).toBeDefined();
  });

  it("collects everything in one call", async () => {
    const info = await databaseInfo(connection);

    expect(info.adapter).toBe(connection.adapter);
    expect(info.version).toBeDefined();
  });
});

describe("per adapter", () => {
  it("asks postgres for its own catalogue", async () => {
    const postgres = fake("postgres", { "current_database()": "shop" });

    expect(await currentDatabase(postgres)).toBe("shop");
  });

  it("asks mysql for its own", async () => {
    const mysql = fake("mysql", { "DATABASE()": "shop" });

    expect(await currentDatabase(mysql)).toBe("shop");
  });

  /**
   * A search path putting a tenant's schema first means the same statement
   * reaches a different table depending on the connection.
   */
  it("reports a schema only where there is one to report", async () => {
    const postgres = fake("postgres", { "current_schema()": "tenant_7" });

    expect(await currentSchema(postgres)).toBe("tenant_7");
    expect(await currentSchema(fake("mysql", {}))).toBeUndefined();
    expect(await currentSchema(fake("sqlite", {}))).toBeUndefined();
  });

  /** A round trip to ask a question the server has no answer to. */
  it("does not send a postgres-only query to another server", async () => {
    let asked = 0;
    const mysql = {
      adapter: "mysql",
      query: async () => {
        asked += 1;

        return [];
      },
    } as unknown as Connection;

    await currentSchema(mysql);

    expect(asked).toBe(0);
  });

  it("reads mysql's charset from the right variable", async () => {
    const mysql = fake("mysql", { "@@character_set_database": "utf8mb4" });

    expect(await charsetCurrent(mysql)).toBe("utf8mb4");
  });

  it("says sqlite compares binary", async () => {
    expect(await collationCurrent(fake("sqlite", {}))).toBe("BINARY");
  });
});

describe("whether the charset can hold every character", () => {
  it("says yes for utf8mb4", async () => {
    expect(
      await charsetHoldsEveryCharacter(fake("mysql", { "@@character_set_database": "utf8mb4" })),
    ).toBe(true);
  });

  /** Three bytes per character: an emoji is truncated, not refused. */
  it("says no for mysql's utf8", async () => {
    expect(
      await charsetHoldsEveryCharacter(fake("mysql", { "@@character_set_database": "utf8" })),
    ).toBe(false);
  });

  /** The honest name for the same three-byte set, which newer MySQL reports. */
  it("says no for utf8mb3 as well", async () => {
    expect(
      await charsetHoldsEveryCharacter(fake("mysql", { "@@character_set_database": "utf8mb3" })),
    ).toBe(false);
  });

  it("ignores case", async () => {
    expect(
      await charsetHoldsEveryCharacter(fake("mysql", { "@@character_set_database": "UTF8" })),
    ).toBe(false);
  });

  it("says yes for postgres UTF8, which is the real thing", async () => {
    const postgres = fake("postgres", { pg_encoding_to_char: "UTF8" });

    expect(await charsetHoldsEveryCharacter(postgres)).toBe(true);
  });

  it("says yes when it cannot tell", async () => {
    expect(await charsetHoldsEveryCharacter(fake("mysql", {}))).toBe(true);
  });

  it("agrees with the real connection", async () => {
    expect(await charsetHoldsEveryCharacter(connection)).toBe(true);
  });
});

describe("advisory locks", () => {
  /** What a migration takes so two deploys do not run the same one at once. */
  it("are there on postgres and mysql", () => {
    expect(advisoryLocksEnabled(fake("postgres", {}))).toBe(true);
    expect(advisoryLocksEnabled(fake("mysql", {}))).toBe(true);
  });

  /**
   * Saying so is more useful than a lock that quietly does nothing: a SQLite
   * deployment must not migrate from two processes.
   */
  it("are not on sqlite", () => {
    expect(advisoryLocksEnabled(fake("sqlite", {}))).toBe(false);
  });
});

describe("when the database will not say", () => {
  /**
   * Introspection must never be the thing that takes an application down — a
   * permission that does not allow reading a system view, an adapter that
   * spells a catalogue differently. "I do not know" is what a caller can act
   * on.
   */
  it("answers undefined rather than throwing", async () => {
    const refuses = {
      adapter: "postgres",
      query: async () => {
        throw new Error("permission denied for view pg_database");
      },
    } as unknown as Connection;

    expect(await databaseVersion(refuses)).toBeUndefined();
    expect(await charsetCurrent(refuses)).toBeUndefined();
  });

  it("still collects the rest", async () => {
    const partial = {
      adapter: "postgres",
      query: async (sql: string) => {
        if (sql.includes("version()")) return [{ value: "PostgreSQL 16" }];

        throw new Error("permission denied");
      },
    } as unknown as Connection;

    const info = await databaseInfo(partial);

    expect(info.version).toBe("PostgreSQL 16");
    expect(info.charset).toBeUndefined();
  });

  it("answers undefined for a row with a null value", async () => {
    const nulls = {
      adapter: "postgres",
      query: async () => [{ value: null }],
    } as unknown as Connection;

    expect(await currentDatabase(nulls)).toBeUndefined();
  });

  it("answers undefined for no rows at all", async () => {
    const empty = {
      adapter: "postgres",
      query: async () => [],
    } as unknown as Connection;

    expect(await currentDatabase(empty)).toBeUndefined();
  });
});

describe("databaseExists", () => {
  it("says yes for one that is there", async () => {
    const postgres = fake("postgres", { pg_database: 1 });

    expect(await databaseExists(postgres, "shop")).toBe(true);
  });

  it("says no for one that is not", async () => {
    const empty = {
      adapter: "postgres",
      query: async () => [],
    } as unknown as Connection;

    expect(await databaseExists(empty, "shop")).toBe(false);
  });

  /** A name with an apostrophe would otherwise be a syntax error nobody reads. */
  it("survives a name with a quote in it", async () => {
    let seen = "";
    const watching = {
      adapter: "postgres",
      query: async (sql: string) => {
        seen = sql;

        return [];
      },
    } as unknown as Connection;

    await databaseExists(watching, "o'brien");

    expect(seen).toContain("'o''brien'");
  });
});
