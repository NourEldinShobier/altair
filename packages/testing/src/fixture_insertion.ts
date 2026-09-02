/**
 * Getting a fixture set into the database, ported from
 * `ActiveRecord::FixtureSet.create_fixtures` and the fixture statements in
 * `ConnectionAdapters::DatabaseStatements`.
 *
 * `fixture_loading.ts` decides *what* the rows are — the derived ids, the
 * resolved references, the order tables are emptied in. This is the half that
 * touches a connection, and the whole of it is arranged around one property:
 * **the load is all-or-nothing.**
 *
 * A suite deletes every fixture table and re-inserts every row. Half of that
 * is far worse than none of it: a run that emptied `posts` and then failed on
 * `comments` leaves a database that looks loaded and is missing a table's
 * worth of rows, and the tests that follow fail one by one with nothing that
 * points back here. So the deletes and the inserts are one transaction, and
 * referential integrity is suspended for its duration — not because the
 * constraints are wrong, but because every row is inserted in the same
 * transaction and any order within it would violate one of them.
 */

import { cacheFixtures, cachedFixtures, fixtureIsCached } from "./fixture_set.js";

/** One statement, with its values bound rather than written into the text. */
export interface FixtureStatement {
  sql: string;
  binds: unknown[];
}

/**
 * What this needs of a connection. Rails uses the adapter; a narrower shape is
 * enough here and lets a suite check what it would have run without a database.
 */
export interface FixtureConnection {
  execute: (statement: FixtureStatement) => Promise<unknown> | unknown;
  transaction: <T>(body: () => Promise<T>) => Promise<T>;
  disableReferentialIntegrity?: <T>(body: () => Promise<T>) => Promise<T>;
  tables?: () => Promise<readonly string[]> | readonly string[];
  quote?: (name: string) => string;
}

const defaultQuote = (name: string): string => `"${name}"`;

/**
 * Rails' `with_yaml_fallback`.
 *
 * A hash or an array has no column type to be quoted into, so it is serialised
 * rather than handed to the driver. Without it the driver either refuses the
 * value or — worse, and this is the one that gets shipped — coerces it to
 * something like `[object Object]` and stores that.
 *
 * Scalars pass through untouched: serialising them too would store `"1"` where
 * the fixture said `1`, and every comparison against that column would then be
 * wrong in a way that reads like a type bug in the model.
 */
export function withYamlFallback(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value;

  return JSON.stringify(value);
}

/**
 * Rails' `build_fixture_sql` — one INSERT for a table's rows.
 *
 * Every row of a table in one statement. A statement per row is the difference
 * between a suite that loads fixtures in a moment and one that spends most of
 * its time in round trips, and fixtures are loaded once per test class.
 *
 * The column list is the union of every row's keys, because two fixtures in
 * one file need not set the same columns; a row that does not mention a column
 * gets a NULL rather than shifting every later value one place left.
 */
export function buildFixtureSql(
  rows: readonly Record<string, unknown>[],
  table: string,
  quote: (name: string) => string = defaultQuote,
): FixtureStatement | undefined {
  const columns: string[] = [];

  for (const row of rows) {
    for (const column of Object.keys(row)) {
      if (!columns.includes(column)) columns.push(column);
    }
  }

  // No columns is not an empty insert: `INSERT INTO posts () VALUES ()` is a
  // syntax error, and a row with nothing in it is a fixture file mistake rather
  // than a row to write. This also covers no rows at all, which have no columns
  // between them — a separate check for that was unreachable.
  if (columns.length === 0) return undefined;

  const binds: unknown[] = [];
  const tuples = rows.map((row) => {
    const placeholders = columns.map((column) => {
      binds.push(withYamlFallback(row[column] ?? null));

      return "?";
    });

    return `(${placeholders.join(", ")})`;
  });

  return {
    sql:
      `INSERT INTO ${quote(table)} (${columns.map((column) => quote(column)).join(", ")}) ` +
      `VALUES ${tuples.join(", ")}`,
    binds,
  };
}

/**
 * Rails' `insert_fixture` — the fallback for one row at a time.
 *
 * Kept because a bulk insert is not universal: an adapter without it needs
 * somewhere to go, and a caller inserting a single row should not have to know
 * which case it is in.
 */
export function insertFixture(
  row: Record<string, unknown>,
  table: string,
  quote: (name: string) => string = defaultQuote,
): FixtureStatement {
  const statement = buildFixtureSql([row], table, quote);

  if (statement === undefined) throw new TypeError("a fixture row must have at least one column");

  return statement;
}

/** The statements a load runs, in the order it runs them. */
export function fixtureStatements(
  tableRows: Record<string, readonly Record<string, unknown>[]>,
  tablesToDelete: readonly string[] = [],
  quote: (name: string) => string = defaultQuote,
): FixtureStatement[] {
  // Deletes first, and all of them before any insert. A table emptied after
  // another was filled would delete rows the same load had just inserted when
  // two fixture sets share a table.
  const statements: FixtureStatement[] = tablesToDelete.map((table) => ({
    sql: `DELETE FROM ${quote(table)}`,
    binds: [],
  }));

  for (const [table, rows] of Object.entries(tableRows)) {
    const insert = buildFixtureSql(rows, table, quote);

    if (insert !== undefined) statements.push(insert);
  }

  return statements;
}

/**
 * Rails' `insert_fixtures_set` — empty the tables and fill them, once.
 *
 * One transaction, so a failure halfway leaves the database as it was rather
 * than half-loaded. Referential integrity is suspended inside it because every
 * row arrives in the same transaction: a post referring to an author inserted
 * two statements later is not a broken reference, it is a reference that is
 * satisfied before the transaction commits, and there is no ordering that
 * makes a cycle work without this.
 */
export async function insertFixturesSet(
  connection: FixtureConnection,
  tableRows: Record<string, readonly Record<string, unknown>[]>,
  tablesToDelete: readonly string[] = [],
): Promise<FixtureStatement[]> {
  const statements = fixtureStatements(tableRows, tablesToDelete, connection.quote ?? defaultQuote);

  const run = async (): Promise<FixtureStatement[]> => {
    for (const statement of statements) await connection.execute(statement);

    return statements;
  };

  return await connection.transaction(async () =>
    connection.disableReferentialIntegrity
      ? await connection.disableReferentialIntegrity(run)
      : run(),
  );
}

/**
 * Rails' `empty_all_tables`.
 *
 * Every table, not the ones a fixture set names. It is what a run does when it
 * cannot trust what is there — a suite that crashed mid-load, or a developer's
 * database that has been written to by hand — and leaving out the tables no
 * fixture mentions is exactly how a stray row survives to fail one test in a
 * hundred runs.
 */
export async function emptyAllTables(connection: FixtureConnection): Promise<string[]> {
  const tables = [...((await connection.tables?.()) ?? [])];
  const quote = connection.quote ?? defaultQuote;

  await connection.transaction(async () => {
    for (const table of tables) {
      await connection.execute({ sql: `DELETE FROM ${quote(table)}`, binds: [] });
    }
  });

  return tables;
}

/**
 * Rails' `reset_column_sequences!`, as the statements it would run.
 *
 * A fixture's id is derived from its label rather than taken from the
 * sequence, so after a load the sequence is still at zero and the next record
 * a *test* creates collides with a fixture. The failure is a unique-key
 * violation in a test that never mentioned fixtures.
 */
export function resetColumnSequences(
  tableRows: Record<string, readonly Record<string, unknown>[]>,
  primaryKey = "id",
): Record<string, number> {
  const highest: Record<string, number> = {};

  for (const [table, rows] of Object.entries(tableRows)) {
    for (const row of rows) {
      const id = row[primaryKey];

      if (typeof id !== "number") continue;

      highest[table] = Math.max(highest[table] ?? 0, id);
    }
  }

  return highest;
}

// --- the cache a whole run shares ------------------------------------------

/**
 * Rails' `cache_for_connection_pool` — fixtures are cached per pool.
 *
 * Per pool and not globally: an application with two databases has two sets of
 * tables, and a fixture set loaded into one has not been loaded into the other.
 * A shared cache would report the second as already loaded and every test
 * against it would run on empty tables.
 */
const pools = new Map<string, Set<string>>();

export function cacheForConnectionPool(pool: string): Set<string> {
  let held = pools.get(pool);

  if (held === undefined) {
    held = new Set<string>();
    pools.set(pool, held);
  }

  return held;
}

export function resetFixtureInsertionCache(): void {
  pools.clear();
}

/** Rails' `update_all_loaded_fixtures` — remember a set by name. */
export function updateAllLoadedFixtures(
  pool: string,
  loaded: Record<string, unknown>,
): Record<string, unknown> {
  const held = cacheForConnectionPool(pool);

  for (const [name, set] of Object.entries(loaded)) {
    held.add(name);
    cacheFixtures(name, set);
  }

  return loaded;
}

/**
 * Rails' `create_fixtures` — load the named sets, skipping what is loaded.
 *
 * The cache is the reason a suite starts at all: without it every test class
 * re-reads and re-inserts every fixture file, which for a real application is
 * most of the run. A set already in this pool's cache is not read and not
 * inserted, and the caller still gets it back, so a caller cannot tell the
 * difference except in how long it took.
 */
export async function createFixtures(
  connection: FixtureConnection,
  names: readonly string[],
  read: (name: string) => Promise<unknown> | unknown,
  options: {
    pool?: string;
    tableRowsFor?: (
      name: string,
      set: unknown,
    ) => Record<string, readonly Record<string, unknown>[]>;
  } = {},
): Promise<Record<string, unknown>> {
  const pool = options.pool ?? "primary";
  const held = cacheForConnectionPool(pool);
  const toRead = names.filter((name) => !held.has(name) || !fixtureIsCached(name));

  if (toRead.length > 0) {
    const loaded: Record<string, unknown> = {};
    const tableRows: Record<string, readonly Record<string, unknown>[]> = {};

    for (const name of toRead) {
      const set = await read(name);
      loaded[name] = set;

      const rows = options.tableRowsFor?.(name, set);

      if (rows) {
        for (const [table, values] of Object.entries(rows)) tableRows[table] = values;
      }
    }

    // Inserted before the cache is updated: a set marked loaded whose insert
    // then failed would be skipped by every later call, and the tests would run
    // against tables nobody filled.
    await insertFixturesSet(connection, tableRows, Object.keys(tableRows));
    updateAllLoadedFixtures(pool, loaded);
  }

  return Object.fromEntries(names.map((name) => [name, cachedFixtures(name)]));
}

// --- reaching them from the test -------------------------------------------

/**
 * Rails' `instantiate_fixtures` — each fixture as a property of the test.
 *
 * `loadInstances` is false for a suite that only wants the rows in the
 * database. Building a model object per fixture costs a query each, and a
 * suite with a few hundred fixtures pays that per test.
 */
export function instantiateFixtures(
  target: Record<string, unknown>,
  set: Record<string, unknown>,
  loadInstances = true,
): Record<string, unknown> {
  if (!loadInstances) return target;

  for (const [name, fixture] of Object.entries(set)) target[name] = fixture;

  return target;
}

/**
 * Rails' `instantiate_all_loaded_fixtures`.
 *
 * Later sets win on a name collision, and the collision is not reported: two
 * fixture files may legitimately both define `david`, and refusing the load
 * would break a suite over a name neither file's author chose.
 */
export function instantiateAllLoadedFixtures(
  target: Record<string, unknown>,
  sets: Record<string, Record<string, unknown>>,
  loadInstances = true,
): Record<string, unknown> {
  for (const set of Object.values(sets)) instantiateFixtures(target, set, loadInstances);

  return target;
}
