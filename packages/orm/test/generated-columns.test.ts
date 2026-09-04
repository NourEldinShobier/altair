/**
 * Columns the database computes, ported from the `as:` / `stored:` cases in
 * `activerecord/test/cases/adapters/mysql2/virtual_column_test.rb`,
 * `activerecord/test/cases/adapters/postgresql/virtual_column_test.rb` and
 * `activerecord/test/cases/adapters/sqlite3/virtual_column_test.rb`.
 *
 * The three databases disagree about which kinds they support and about how to
 * spell them, and every disagreement fails at migration time in production
 * rather than at write time in development. That is what these assert.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Connection } from "../src/connection.js";
import { SchemaStatements } from "../src/schema.js";
import { columnNamesOf, isSqlite, testConnection } from "./support/database.js";
import { columnSchemas } from "../src/introspect.js";
import {
  GeneratedColumnHasDefault,
  VirtualColumnUnsupported,
  checkGeneratedColumn,
  generatedClause,
  virtualStored,
} from "../src/generated-columns.js";

const NAME = "full_name";
const EXPRESSION = "first_name || ' ' || last_name";

describe("whether the value is kept on disk", () => {
  /**
   * Virtual by default, matching MySQL and SQLite — and the reason PostgreSQL
   * is refused rather than quietly upgraded, since storing a column somebody
   * asked not to store changes the table's size and its write cost.
   */
  it("is virtual unless asked for", () => {
    expect(virtualStored({ as: EXPRESSION })).toBe(false);
    expect(virtualStored({ as: EXPRESSION, stored: false })).toBe(false);
    expect(virtualStored({ as: EXPRESSION, stored: true })).toBe(true);
  });
});

describe("postgresql", () => {
  it("writes a stored generated column", () => {
    expect(generatedClause("postgres", NAME, { as: EXPRESSION, stored: true })).toBe(
      ` GENERATED ALWAYS AS (${EXPRESSION}) STORED`,
    );
  });

  /**
   * A migration written on MySQL — where virtual is the default — runs there
   * and then fails on the PostgreSQL it is deployed to, halfway through a
   * deploy. Refusing here moves that to the moment it is written.
   */
  it("refuses a virtual one, and says what to do instead", () => {
    expect(() => generatedClause("postgres", NAME, { as: EXPRESSION })).toThrow(
      VirtualColumnUnsupported,
    );
    expect(() => generatedClause("postgres", NAME, { as: EXPRESSION, stored: false })).toThrow(
      "stored: true",
    );
  });

  /** So the message is worth reading in a migration with fifteen columns. */
  it("names the column it is refusing", () => {
    expect(() => generatedClause("postgres", NAME, { as: EXPRESSION })).toThrow("full_name");
  });
});

describe("mysql", () => {
  /** MySQL's default is virtual, so the keyword is only worth emitting for stored. */
  it("says nothing extra for a virtual column", () => {
    expect(generatedClause("mysql", NAME, { as: EXPRESSION })).toBe(` AS (${EXPRESSION})`);
  });

  it("says STORED for a stored one", () => {
    expect(generatedClause("mysql", NAME, { as: EXPRESSION, stored: true })).toBe(
      ` AS (${EXPRESSION}) STORED`,
    );
  });

  /** MariaDB rejects `STORED` outright, which a CI matrix finds and a deploy does not. */
  it("says PERSISTENT on MariaDB", () => {
    expect(
      generatedClause("mysql", NAME, { as: EXPRESSION, stored: true }, { mariadb: true }),
    ).toBe(` AS (${EXPRESSION}) PERSISTENT`);
  });

  it("says nothing extra on MariaDB for a virtual column", () => {
    expect(generatedClause("mysql", NAME, { as: EXPRESSION }, { mariadb: true })).toBe(
      ` AS (${EXPRESSION})`,
    );
  });
});

describe("sqlite", () => {
  /** It says which it is either way, so a dump reads the same on every adapter. */
  it("says which kind it is", () => {
    expect(generatedClause("sqlite", NAME, { as: EXPRESSION })).toBe(` AS (${EXPRESSION}) VIRTUAL`);
    expect(generatedClause("sqlite", NAME, { as: EXPRESSION, stored: true })).toBe(
      ` AS (${EXPRESSION}) STORED`,
    );
  });
});

describe("a column that is both computed and defaulted", () => {
  /**
   * A default is what a column takes when nobody writes it, and nobody can
   * write a generated column at all.
   */
  it("is refused", () => {
    expect(() => checkGeneratedColumn(NAME, { as: EXPRESSION, default: "x" })).toThrow(
      GeneratedColumnHasDefault,
    );
    expect(() => checkGeneratedColumn(NAME, { as: EXPRESSION, default: "x" })).toThrow("full_name");
  });

  it("leaves an ordinary defaulted column alone", () => {
    expect(() => checkGeneratedColumn(NAME, { default: "x" })).not.toThrow();
    expect(() => checkGeneratedColumn(NAME, { as: EXPRESSION })).not.toThrow();
    expect(() => checkGeneratedColumn(NAME, {})).not.toThrow();
  });

  /** `default: null` is a default — the column takes NULL, deliberately. */
  it("counts an explicit null default", () => {
    expect(() => checkGeneratedColumn(NAME, { as: EXPRESSION, default: null })).toThrow(
      GeneratedColumnHasDefault,
    );
  });
});

describe("a table with one, end to end", () => {
  let connection: Connection;
  let schema: SchemaStatements;

  beforeEach(async () => {
    connection = await testConnection();
    schema = new SchemaStatements(connection);
  });

  /** Stored, because PostgreSQL cannot do anything else. */
  it("creates the column and the database computes it", async () => {
    await schema.dropTable("people", { ifExists: true });
    await schema.createTable("people", (t) => {
      t.string("first_name");
      t.string("last_name");
      t.virtual("full_name", {
        type: "string",
        as: concatenation(connection.adapter),
        stored: true,
      });
    });

    expect(await columnNamesOf(connection, "people")).toContain("full_name");

    await connection.execute(
      `INSERT INTO ${connection.quote("people")} (${connection.quote("first_name")}, ${connection.quote("last_name")}) VALUES ('Ada', 'Lovelace')`,
    );

    const rows = await connection.query<{ full_name: string }>(
      `SELECT ${connection.quote("full_name")} FROM ${connection.quote("people")}`,
    );

    expect(rows[0]?.full_name).toBe("Ada Lovelace");
  });

  /** The application never writes it, which is the whole point. */
  it("refuses a write to it", async () => {
    await schema.dropTable("people", { ifExists: true });
    await schema.createTable("people", (t) => {
      t.string("first_name");
      t.string("last_name");
      t.virtual("full_name", {
        type: "string",
        as: concatenation(connection.adapter),
        stored: true,
      });
    });

    await expect(
      connection.execute(
        `INSERT INTO ${connection.quote("people")} (${connection.quote("full_name")}) VALUES ('nope')`,
      ),
    ).rejects.toThrow();
  });
});

describe("what createTable refuses", () => {
  /**
   * Built, not executed: the clause is assembled before anything is sent, so
   * this reaches the refusal on any machine without a PostgreSQL to talk to.
   */
  const postgres = () => new SchemaStatements(new Connection("postgres://localhost/nowhere"));

  it("refuses a virtual column on postgresql", async () => {
    await expect(
      postgres().createTable("people", (t) => {
        t.virtual("full_name", { type: "string", as: EXPRESSION });
      }),
    ).rejects.toThrow(VirtualColumnUnsupported);
  });

  /** Which proves the stored flag reaches the clause rather than being dropped. */
  it("allows a stored one on postgresql", async () => {
    await expect(
      postgres().createTable("people", (t) => {
        t.virtual("full_name", { type: "string", as: EXPRESSION, stored: true });
      }),
    ).rejects.not.toThrow(VirtualColumnUnsupported);
  });

  it("refuses one that is also defaulted", async () => {
    await expect(
      postgres().createTable("people", (t) => {
        t.virtual("full_name", { type: "string", as: EXPRESSION, stored: true, default: "x" });
      }),
    ).rejects.toThrow(GeneratedColumnHasDefault);
  });
});

describe("reading the columns back", () => {
  /**
   * SQLite's plain `table_info` omits generated columns, so a table with one
   * would dump without it and a `schema:load` would rebuild it missing a
   * column — with no error anywhere.
   */
  it.skipIf(!isSqlite)("sees a generated column", async () => {
    const connection = await testConnection();
    const schema = new SchemaStatements(connection);

    await schema.dropTable("people", { ifExists: true });
    await schema.createTable("people", (t) => {
      t.string("first_name");
      t.virtual("shouty", { type: "string", as: "upper(first_name)", stored: true });
    });

    const columns = await columnSchemas(connection, "people");

    expect(columns.map((column) => column.name)).toContain("shouty");
    expect(columns.find((column) => column.name === "shouty")?.generated).toBe(true);
    expect(columns.find((column) => column.name === "first_name")?.generated).toBe(false);
  });

  /** An fts5 index's internals belong in nobody's schema dump. */
  it.skipIf(!isSqlite)("leaves a virtual table's hidden columns out", async () => {
    const connection = await testConnection();

    await connection.execute(`CREATE VIRTUAL TABLE docs USING fts5(title, body)`);

    const names = (await columnSchemas(connection, "docs")).map((column) => column.name);

    expect(names).toEqual(["title", "body"]);
  });
});

/** The one expression the three databases spell differently. */
function concatenation(adapter: string): string {
  return adapter === "mysql"
    ? "concat(first_name, ' ', last_name)"
    : "first_name || ' ' || last_name";
}
