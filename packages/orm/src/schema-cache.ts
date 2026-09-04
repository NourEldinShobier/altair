/**
 * Column and index information, remembered. Ported from
 * `ActiveRecord::ConnectionAdapters::SchemaCache` and `SchemaReflection`.
 *
 * `introspect.ts` asks the database what a table looks like. That is several
 * queries per table, and the answer changes only when a migration runs — so
 * asking again on every boot is work whose result was already known before the
 * process started.
 *
 * It matters more than it sounds. The first request that touches a model pays
 * for that model's introspection, so the cost lands on a real request rather
 * than on startup, and it lands again on every process: a deploy that starts
 * twenty workers pays it twenty times, at once, against a database that is
 * also serving. Dumping the answer to a file at build time and loading it at
 * boot turns all of that into one file read.
 *
 * The cache is deliberately not self-invalidating. A cache that notices a
 * schema change would have to ask the database whether it changed, which is
 * the query it exists to avoid. Instead the dump carries the migration version
 * it was taken at, and a stale one is detected and refused rather than used —
 * silently serving the previous schema's columns is how a deploy half-works.
 */

import type { Connection } from "./connection.js";
import type { ColumnSchema, IndexSchema } from "./introspect.js";
import { columnSchemas, currentVersion, indexSchemas, tableNames } from "./introspect.js";

/** What a dump file holds. */
export interface SchemaCacheDump {
  /** The migration version the cache was taken at. */
  version: string | null;
  columns: Record<string, ColumnSchema[]>;
  indexes: Record<string, IndexSchema[]>;
  /** Every table that existed, so a miss can be told from an absence. */
  dataSources: string[];
}

/**
 * Remembered schema for one database.
 *
 * Every reader takes a connection, and uses it only on a miss. A cache loaded
 * from a dump answers every question without one, which is the whole point;
 * one built at runtime fills in as it goes, which is the fallback.
 */
export class SchemaCache {
  #columns = new Map<string, ColumnSchema[]>();
  #indexes = new Map<string, IndexSchema[]>();
  #dataSources = new Map<string, boolean>();
  #version: string | null = null;
  #loaded = false;

  /** Whether this holds a loaded dump rather than whatever has been asked for so far. */
  get schemaLoaded(): boolean {
    return this.#loaded;
  }

  /** The migration version the cache was taken at. Rails' `schema_version`. */
  get schemaVersion(): string | null {
    return this.#version;
  }

  /** How many tables have been cached, for a caller deciding whether a dump is worth writing. */
  get size(): number {
    return this.#columns.size;
  }

  /** Whether a table's columns are already known. Rails' `cached?`. */
  cached(table: string): boolean {
    return this.#columns.has(table);
  }

  async columns(connection: Connection, table: string): Promise<ColumnSchema[]> {
    const known = this.#columns.get(table);
    if (known) return known;

    const columns = await columnSchemas(connection, table);
    this.#columns.set(table, columns);

    return columns;
  }

  /** The same, keyed by name, which is how callers actually look a column up. */
  async columnsHash(connection: Connection, table: string): Promise<Record<string, ColumnSchema>> {
    const columns = await this.columns(connection, table);
    const hash: Record<string, ColumnSchema> = {};

    for (const column of columns) hash[column.name] = column;

    return hash;
  }

  async indexes(connection: Connection, table: string): Promise<IndexSchema[]> {
    const known = this.#indexes.get(table);
    if (known) return known;

    const indexes = await indexSchemas(connection, table);
    this.#indexes.set(table, indexes);

    return indexes;
  }

  /**
   * The table's primary key columns, or none.
   *
   * Plural because a join table keyed on both of its foreign keys has two, and
   * a caller that assumes one writes an UPDATE matching more rows than it
   * meant to.
   */
  async primaryKeys(connection: Connection, table: string): Promise<string[]> {
    const columns = await this.columns(connection, table);

    return columns.filter((column) => column.primaryKey).map((column) => column.name);
  }

  /**
   * Whether a table exists.
   *
   * A negative answer is cached too. Rails caches it because the question is
   * usually asked by something checking whether an optional table is there,
   * and a missing table is missing for the whole process — re-asking on every
   * check makes the absent case the expensive one.
   */
  async dataSourceExists(connection: Connection, name: string): Promise<boolean> {
    const known = this.#dataSources.get(name);
    if (known !== undefined) return known;

    const exists = (await tableNames(connection)).includes(name);
    this.#dataSources.set(name, exists);

    return exists;
  }

  /** Note a table exists without asking. Rails' `add`. */
  add(name: string): void {
    this.#dataSources.set(name, true);
  }

  /**
   * Read everything, so the cache can be dumped. Rails' `add_all`.
   *
   * This is the expensive call, and it is meant to be: it runs once, off the
   * request path, to produce the file that means nothing else has to.
   */
  async addAll(connection: Connection): Promise<void> {
    const names = await tableNames(connection);

    for (const name of names) {
      this.#dataSources.set(name, true);
      await this.columns(connection, name);
      await this.indexes(connection, name);
    }

    this.#version = await currentVersion(connection);
  }

  /**
   * Forget one table. Rails' `clear_data_source_cache!`.
   *
   * What a migration running inside a live process needs: it changed one
   * table, and throwing away everything else means the next request re-reads
   * schema it already had.
   */
  clearDataSourceCache(name: string): void {
    this.#columns.delete(name);
    this.#indexes.delete(name);
    this.#dataSources.delete(name);
  }

  /** Forget everything. */
  clear(): void {
    this.#columns.clear();
    this.#indexes.clear();
    this.#dataSources.clear();
    this.#version = null;
    this.#loaded = false;
  }

  /** What a dump file holds. Rails' `marshal_dump`/`dump_to`. */
  toDump(): SchemaCacheDump {
    return {
      version: this.#version,
      columns: Object.fromEntries(this.#columns),
      indexes: Object.fromEntries(this.#indexes),
      dataSources: Array.from(this.#dataSources.entries())
        .filter(([, exists]) => exists)
        .map(([name]) => name),
    };
  }

  /** Write it. Rails' `dump_to`. */
  async dumpTo(path: string): Promise<void> {
    await Bun.write(path, `${JSON.stringify(this.toDump(), undefined, 2)}\n`);
  }

  /** Read one back. */
  static fromDump(dump: SchemaCacheDump): SchemaCache {
    const cache = new SchemaCache();

    for (const [table, columns] of Object.entries(dump.columns)) cache.#columns.set(table, columns);
    for (const [table, indexes] of Object.entries(dump.indexes)) cache.#indexes.set(table, indexes);
    for (const name of dump.dataSources) cache.#dataSources.set(name, true);

    cache.#version = dump.version;
    cache.#loaded = true;

    return cache;
  }

  /**
   * Read one from a file, or nothing.
   *
   * Nothing rather than thrown for a missing or unreadable file: a cache is an
   * optimisation, and an application that will not boot because its dump is
   * corrupt has turned a saved query into an outage.
   */
  static async load(path: string): Promise<SchemaCache | undefined> {
    try {
      const dump = (await Bun.file(path).json()) as SchemaCacheDump;

      if (typeof dump !== "object" || dump === null || typeof dump.columns !== "object") {
        return undefined;
      }

      return SchemaCache.fromDump(dump);
    } catch {
      return undefined;
    }
  }
}

/** Where a dump lives by default. Rails' `default_schema_cache_path`. */
export function defaultSchemaCachePath(root = "."): string {
  return `${root}/db/schema_cache.json`;
}

/**
 * The path for one database in a multi-database application. Rails'
 * `lazy_schema_cache_path`.
 *
 * The name is in the file rather than one file holding all of them, because
 * each database migrates on its own schedule — one shared file would be stale
 * for every database whenever any one of them moved.
 */
export function lazySchemaCachePath(name: string, root = "."): string {
  return name === "primary" ? defaultSchemaCachePath(root) : `${root}/db/${name}_schema_cache.json`;
}

/** Whichever path was configured, or the default. */
export function schemaCachePath(configured: string | undefined, root = "."): string {
  return configured ?? defaultSchemaCachePath(root);
}

/**
 * Whether a dump matches the database. Rails' `check_schema_file`/`schema_up_to_date?`.
 *
 * A dump taken before the last migration describes columns that have since
 * changed, and using it is worse than having none: the application starts,
 * serves, and fails on the one query that touches the new column. So a
 * mismatch is reported and the cache is not used.
 */
export function isSchemaCacheCurrent(cache: SchemaCache, databaseVersion: string | null): boolean {
  if (cache.schemaVersion === null || databaseVersion === null) return false;

  return cache.schemaVersion === databaseVersion;
}

export async function checkSchemaFile(
  path: string,
  databaseVersion: string | null,
): Promise<boolean> {
  const cache = await SchemaCache.load(path);

  return cache !== undefined && isSchemaCacheCurrent(cache, databaseVersion);
}

/**
 * Everything the process knows about one database's schema. Rails'
 * `SchemaReflection`.
 *
 * A holder rather than the cache itself, so that clearing or reloading swaps
 * what is inside without every model that captured a reference pointing at a
 * cache nobody uses any more.
 */
export class SchemaReflection {
  #cache: SchemaCache;

  constructor(cache: SchemaCache = new SchemaCache()) {
    this.#cache = cache;
  }

  get schemaCache(): SchemaCache {
    return this.#cache;
  }

  /**
   * Load a dump, use it only if it matches, and say whether it was used.
   *
   * The version check is here rather than in the caller because the tempting
   * thing to write at a call site is `cache ?? new SchemaCache()`, which uses
   * a stale dump exactly as happily as a current one.
   */
  async loadFrom(path: string, databaseVersion: string | null): Promise<boolean> {
    const loaded = await SchemaCache.load(path);

    if (loaded === undefined || !isSchemaCacheCurrent(loaded, databaseVersion)) return false;

    this.#cache = loaded;

    return true;
  }

  /** Read the whole schema and write it out. Rails' `dump_schema_cache`. */
  async dumpSchemaCache(connection: Connection, path: string): Promise<void> {
    await this.#cache.addAll(connection);
    await this.#cache.dumpTo(path);
  }

  /** Throw the cache away, after a migration that changed everything. */
  clearSchemaCache(): void {
    this.#cache = new SchemaCache();
  }

  get schemaLoaded(): boolean {
    return this.#cache.schemaLoaded;
  }
}

let ambient = new SchemaReflection();

/**
 * The schema cache this process reads from. Rails' `schema_reflection`.
 *
 * One per process rather than one per model, because a dump covers the whole
 * schema and a model asking its own question would read the file once per
 * class — which is the boot cost the dump exists to remove.
 *
 * Empty until something loads a dump into it, and a model that finds it empty
 * asks the database exactly as it always did. That is deliberate: a schema
 * cache that changed behaviour by existing would be one nobody could add to a
 * running application without a deploy to think about.
 */
export function schemaReflection(): SchemaReflection {
  return ambient;
}

export function setSchemaReflection(reflection: SchemaReflection): void {
  ambient = reflection;
}

/** Back to asking the database. For a test, and for a migration that changed everything. */
export function resetSchemaReflection(): void {
  ambient = new SchemaReflection();
}
