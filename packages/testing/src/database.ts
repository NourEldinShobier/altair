/**
 * Test databases, ported from `ActiveRecord::TestFixtures`.
 *
 * Rails wraps every test in a transaction and rolls it back, so a test sees a
 * clean database without anyone writing teardown. That is the single thing
 * that makes a large model suite bearable, and it is why this package exists
 * before the ORM has every feature: an application cannot test what it builds
 * without it.
 *
 * The schema comes from the dump rather than from replaying migrations, which
 * is the difference between a suite that starts in milliseconds and one that
 * starts in seconds.
 */

import {
  Connection,
  loadSchema,
  setConnection,
  type Row,
  type SchemaDefinition,
} from "@altair/orm";

export type CleanStrategy = "transaction" | "truncation";

export interface TestDatabaseOptions {
  /** Defaults to in-memory SQLite, which needs no service and no cleanup. */
  url?: string;
  /**
   * How each test is isolated.
   *
   * `transaction` is faster and is what Rails does. `truncation` is the escape
   * hatch for a test that needs its writes visible to another connection —
   * anything that spawns a process, or a pooled adapter where a transaction
   * cannot be pinned to one connection.
   */
  strategy?: CleanStrategy;
  /** Makes this the connection models use. On by default. */
  global?: boolean;
}

export class TestDatabase {
  readonly connection: Connection;
  readonly strategy: CleanStrategy;

  #open = false;
  #tables: string[] = [];

  private constructor(connection: Connection, strategy: CleanStrategy) {
    this.connection = connection;
    this.strategy = strategy;
  }

  /**
   * Creates a database and loads a schema into it.
   *
   * Takes the dumped schema an application already has, so preparing a test
   * database is the same operation as `db:schema:load`.
   */
  static async prepare(
    schema: SchemaDefinition,
    options: TestDatabaseOptions = {},
  ): Promise<TestDatabase> {
    const connection = new Connection(options.url ?? "sqlite://:memory:");
    await loadSchema(connection, schema);

    const database = new TestDatabase(connection, options.strategy ?? "transaction");
    database.#tables = schema.tables.map((table) => table.name);

    if (options.global !== false) setConnection(connection);
    return database;
  }

  /** Starts a test's isolation. Call from `beforeEach`. */
  async begin(): Promise<void> {
    if (this.strategy !== "transaction") return;
    if (this.#open) throw new Error("A test transaction is already open. Did rollback() not run?");

    // ponytail: this opens a transaction on the connection itself, which is
    // correct while the adapter hands out one connection, as in-memory SQLite
    // does. A pooled adapter needs the transaction pinned to a single
    // connection first; until then, use the truncation strategy there.
    await this.connection.beginTransaction();
    this.#open = true;
  }

  /** Ends a test's isolation, discarding everything it wrote. Call from `afterEach`. */
  async rollback(): Promise<void> {
    if (this.strategy === "truncation") {
      await this.truncate();
      return;
    }
    if (!this.#open) return;

    await this.connection.rollbackTransaction();
    this.#open = false;
  }

  /** Empties every table the schema declared. The truncation strategy. */
  async truncate(): Promise<void> {
    for (const table of this.#tables) {
      await this.connection.execute(`DELETE FROM ${this.connection.quote(table)}`);
    }

    // SQLite remembers the highest rowid per table, so ids keep climbing
    // across tests unless the counter is reset too. A test asserting on id 1
    // should not depend on which tests ran before it.
    if (this.connection.adapter === "sqlite") {
      const exists = await this.connection.query<Row>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'",
      );
      if (exists.length > 0) await this.connection.execute("DELETE FROM sqlite_sequence");
    }
  }

  /** Row count in a table, for assertions about what a test left behind. */
  async count(table: string): Promise<number> {
    const rows = await this.connection.query<Row>(
      `SELECT COUNT(*) AS ${this.connection.quote("count")} FROM ${this.connection.quote(table)}`,
    );
    return Number(rows[0]?.count ?? 0);
  }

  get tables(): readonly string[] {
    return [...this.#tables];
  }

  async close(): Promise<void> {
    if (this.#open) await this.rollback();
    await this.connection.close();
  }
}

/**
 * The hooks a test file registers.
 *
 *     let database: TestDatabase
 *     beforeAll(async () => { database = await TestDatabase.prepare(schema) })
 *
 *     const { setup, teardown } = transactionalTests(() => database)
 *     beforeEach(setup)
 *     afterEach(teardown)
 *
 * Returned rather than registered so this package does not import the test
 * runner, which would make it unusable from anything that is not a test.
 *
 * A function is accepted as well as a database because the hooks are wired up
 * while the describe block is being read, which is before any `beforeAll` has
 * run — so the database usually does not exist yet at the point this is
 * called.
 */
export function transactionalTests(database: TestDatabase | (() => TestDatabase)): {
  setup: () => Promise<void>;
  teardown: () => Promise<void>;
} {
  const resolve = () => (typeof database === "function" ? database() : database);

  return {
    setup: () => resolve().begin(),
    teardown: () => resolve().rollback(),
  };
}
