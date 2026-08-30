/**
 * Notes stored against a schema, and turning constraints off to load fixtures.
 * Ported from the comment cases in
 * `activerecord/test/cases/adapters/postgresql/schema_test.rb` and the
 * `disable_referential_integrity` cases in `fixtures_test.rb`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SchemaStatements, UnsupportedSchemaChange, setConnection } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { isSqlite, testConnection } from "./support/database.js";

let connection: Connection;
let schema: SchemaStatements;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);
  schema = new SchemaStatements(connection);

  await schema.createTable("widgets", (t) => {
    t.string("name");
  });
});

afterEach(async () => {
  if (isSqlite) await connection.close();
});

/** A SchemaStatements over a connection reporting whatever adapter is asked for. */
function on(adapter: string, run: (sql: string) => void = () => undefined): SchemaStatements {
  return new SchemaStatements({
    adapter,
    quote: (identifier: string) => `"${identifier}"`,
    placeholder: () => "?",
    execute: async (sql: string) => {
      run(sql);
    },
    query: async () => [],
  } as unknown as Connection);
}

describe("table comments", () => {
  it("writes one on postgres", async () => {
    const statements: string[] = [];

    await on("postgres", (sql) => statements.push(sql)).changeTableComment(
      "widgets",
      "The widgets",
    );

    expect(statements[0]).toBe(`COMMENT ON TABLE "widgets" IS 'The widgets'`);
  });

  it("removes one with null", async () => {
    const statements: string[] = [];

    await on("postgres", (sql) => statements.push(sql)).changeTableComment("widgets", null);

    expect(statements[0]).toContain("IS NULL");
  });

  /** A comment is prose, and prose has apostrophes in it. */
  it("escapes a quote in the comment", async () => {
    const statements: string[] = [];

    await on("postgres", (sql) => statements.push(sql)).changeTableComment(
      "widgets",
      "The user's widgets",
    );

    expect(statements[0]).toContain("'The user''s widgets'");
  });

  it("writes one on a column", async () => {
    const statements: string[] = [];

    await on("postgres", (sql) => statements.push(sql)).changeColumnComment(
      "widgets",
      "name",
      "What it is called",
    );

    expect(statements[0]).toBe(`COMMENT ON COLUMN "widgets"."name" IS 'What it is called'`);
  });

  /**
   * Refused rather than silently skipped: a schema that quietly loses its
   * documentation on one adapter is documentation nobody can rely on.
   */
  it("refuses on an adapter with no comments", async () => {
    expect(on("sqlite").changeTableComment("widgets", "note")).rejects.toThrow(
      UnsupportedSchemaChange,
    );
    expect(on("mysql").changeColumnComment("widgets", "name", "note")).rejects.toThrow(
      UnsupportedSchemaChange,
    );
  });

  it("says what to do instead", async () => {
    expect(on("sqlite").changeTableComment("widgets", "note")).rejects.toThrow("migration");
  });

  it("reads nothing back on an adapter that stores none", async () => {
    expect(await on("sqlite").tableComment("widgets")).toBeUndefined();
  });
});

describe("disableReferentialIntegrity", () => {
  /**
   * What loading fixtures needs. A set of fixtures references itself in every
   * direction, so there is no insertion order that satisfies every constraint.
   */
  it("turns the checks off around the block", async () => {
    const statements: string[] = [];
    const inside: string[] = [];

    await on("sqlite", (sql) => statements.push(sql)).disableReferentialIntegrity(async () => {
      inside.push("ran");
    });

    expect(statements[0]).toBe("PRAGMA foreign_keys = OFF");
    expect(inside).toEqual(["ran"]);
    expect(statements[1]).toBe("PRAGMA foreign_keys = ON");
  });

  it("uses the right switch for mysql", async () => {
    const statements: string[] = [];

    await on("mysql", (sql) => statements.push(sql)).disableReferentialIntegrity(async () => {
      // Nothing; the statements are what is being checked.
    });

    expect(statements).toEqual(["SET FOREIGN_KEY_CHECKS = 0", "SET FOREIGN_KEY_CHECKS = 1"]);
  });

  /**
   * The whole safety of it. A connection left with checks off will accept
   * broken data for the rest of its life, and nothing about the eventual
   * corruption points back here.
   */
  it("turns them back on when the block throws", async () => {
    const statements: string[] = [];

    await on("sqlite", (sql) => statements.push(sql))
      .disableReferentialIntegrity(() => {
        throw new Error("fixture failed");
      })
      .catch(() => undefined);

    expect(statements.at(-1)).toBe("PRAGMA foreign_keys = ON");
  });

  it("lets the error through", async () => {
    expect(
      on("sqlite").disableReferentialIntegrity(() => {
        throw new Error("fixture failed");
      }),
    ).rejects.toThrow("fixture failed");
  });

  it("gives back what the block returned", async () => {
    expect(await on("sqlite").disableReferentialIntegrity(async () => 42)).toBe(42);
  });

  /**
   * PostgreSQL's session-wide switch needs superuser and disabling triggers
   * needs ownership of every table, so the honest answer is that this
   * connection cannot — and the block runs with the constraints still on
   * rather than against a statement that will fail.
   */
  it("runs the block anyway where it cannot turn them off", async () => {
    const statements: string[] = [];
    let ran = false;

    await on("postgres", (sql) => statements.push(sql)).disableReferentialIntegrity(async () => {
      ran = true;
    });

    expect(ran).toBe(true);
    expect(statements).toEqual([]);
  });
});

describe("against the real connection", () => {
  it("reads a comment back as undefined when there is none", async () => {
    expect(await schema.tableComment("widgets")).toBeUndefined();
  });

  it("still runs a block with integrity disabled", async () => {
    let ran = false;

    await schema.disableReferentialIntegrity(async () => {
      ran = true;
    });

    expect(ran).toBe(true);
  });
});
