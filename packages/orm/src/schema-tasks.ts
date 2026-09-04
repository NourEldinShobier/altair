/**
 * Keeping a schema and a database in step, ported from
 * `ActiveRecord::Tasks::DatabaseTasks` and `ActiveRecord::Migration`'s
 * `maintain_test_schema!`.
 *
 * `schema.ts` runs migrations and `dump.ts` writes the schema out. What is
 * between them is the bookkeeping every Rails application relies on without
 * ever calling it directly, and it exists because of one failure mode:
 *
 * **A test suite run against a stale schema passes.** A migration adds a
 * column, the developer runs the suite without loading it, and every test that
 * does not touch the new column is green. The suite is green, the branch looks
 * finished, and the first thing that fails is production. Nothing about that
 * sequence produces an error anywhere.
 *
 * So `maintainTestSchema` compares what the database has migrated against what
 * the migration directory holds, and reloads rather than warning. A warning in
 * a test run scrolls past.
 *
 * The other half is destruction. `purge` and `truncateAll` empty a database,
 * which is exactly right in test and catastrophic anywhere else, so both take
 * the environment and refuse outside the ones that expect it.
 */

/** What the database says it has applied. Rails' `schema_migrations`. */
export interface SchemaState {
  /** Versions recorded in `schema_migrations`. */
  applied: readonly string[];
  /** Versions present on disk. */
  available: readonly string[];
}

/**
 * Versions on disk that the database has not applied. Rails' `needs_migration?`.
 *
 * A *set* difference, not a comparison of the highest version. Two developers
 * on two branches produce two migrations, and whoever merges second has a
 * migration with a lower timestamp than one already applied — comparing maxima
 * declares that database up to date and it is missing a table.
 */
export function pendingMigrationVersions(state: SchemaState): string[] {
  const applied = new Set(state.applied);

  return state.available.filter((version) => !applied.has(version)).sort();
}

/** Rails' `schema_up_to_date?`. */
export function schemaUpToDate(state: SchemaState): boolean {
  return pendingMigrationVersions(state).length === 0;
}

export class PendingMigrations extends Error {
  readonly versions: readonly string[];

  constructor(versions: readonly string[]) {
    super(
      `${versions.length} migration${versions.length === 1 ? "" : "s"} have not been applied: ` +
        `${versions.join(", ")}. Running against a stale schema does not fail — every test that ` +
        `does not touch the new columns passes, and the first thing that notices is production.`,
    );
    this.name = "PendingMigrations";
    this.versions = versions;
  }
}

/** Rails' `check_all_pending!`. */
export function checkAllPending(state: SchemaState): void {
  const pending = pendingMigrationVersions(state);

  if (pending.length > 0) throw new PendingMigrations(pending);
}

/** What a schema reload has to do, if anything. */
export type SchemaAction = "none" | "load" | "create-and-load";

/**
 * Rails' `maintain_test_schema!`.
 *
 * Reloads rather than warning, because a warning in a test run scrolls past
 * and the suite still reports green. Loading is cheap relative to being wrong
 * about it.
 */
export function maintainTestSchema(
  state: SchemaState,
  { databaseExists = true }: { databaseExists?: boolean } = {},
): SchemaAction {
  if (!databaseExists) return "create-and-load";

  return schemaUpToDate(state) ? "none" : "load";
}

/** Rails' `load_schema_if_pending!`. */
export function loadSchemaIfPending(
  state: SchemaState,
  { databaseExists = true }: { databaseExists?: boolean } = {},
): boolean {
  return maintainTestSchema(state, { databaseExists }) !== "none";
}

// --- where the schema lives ------------------------------------------------

export type SchemaFormat = "ruby" | "sql";

/**
 * Rails' `schema_format`.
 *
 * `sql` is not merely a different file: a schema with anything the dumper
 * cannot express — a partial index, a trigger, a check constraint with a
 * function in it — is *silently incomplete* in the portable format. An
 * application using those has to dump SQL, and choosing the format is
 * therefore a correctness decision rather than a preference.
 */
export function schemaFormat(configured: unknown): SchemaFormat {
  return configured === "sql" ? "sql" : "ruby";
}

/** Rails' `db_dir`. */
export function dbDir(root = "."): string {
  return `${root.replace(/\/$/, "")}/db`;
}

/** Rails' `cache_dump_filename` — where the schema cache is written. */
export function cacheDumpFilename(name: string, { root = "." } = {}): string {
  return name === "primary"
    ? `${dbDir(root)}/schema_cache.yml`
    : `${dbDir(root)}/${name}_schema_cache.yml`;
}

/** Rails' `structure_dump` / `structure_load` target. */
export function structureDumpPath(name: string, { root = "." } = {}): string {
  return name === "primary"
    ? `${dbDir(root)}/structure.sql`
    : `${dbDir(root)}/${name}_structure.sql`;
}

/**
 * The tables a dump should leave out. Rails' `schema_dumper_ignore_tables`.
 *
 * The bookkeeping tables, because they hold *this* database's history: dumping
 * `schema_migrations` and loading it elsewhere tells the new database it has
 * already run every migration, and the next `db:migrate` then does nothing at
 * all.
 */
export const INTERNAL_TABLES: readonly string[] = ["schema_migrations", "ar_internal_metadata"];

export function ignoredTables(extra: readonly string[] = []): string[] {
  return [...INTERNAL_TABLES, ...extra];
}

/** Rails' `dumpable_tables`. */
export function dumpableTables(
  tables: readonly string[],
  ignore: readonly string[] = [],
): string[] {
  const skip = new Set(ignoredTables(ignore));

  return tables.filter((table) => !skip.has(table)).sort();
}

// --- emptying a database ---------------------------------------------------

/** Environments where emptying a database is a normal thing to do. */
export const DISPOSABLE_ENVIRONMENTS: readonly string[] = ["test"];

export class ProtectedEnvironment extends Error {
  constructor(task: string, env: string) {
    super(
      `Refusing to ${task} in ${JSON.stringify(env)}. This empties the database, which is ` +
        `routine in ${DISPOSABLE_ENVIRONMENTS.join(", ")} and unrecoverable anywhere else. Set ` +
        `DISABLE_DATABASE_ENVIRONMENT_CHECK=1 if you are certain.`,
    );
    this.name = "ProtectedEnvironment";
  }
}

/**
 * Rails' `check_protected_environments!`.
 *
 * The override is an environment variable rather than an argument, so it
 * cannot be committed to a task file: an escape hatch that lives in code is
 * one somebody adds during an incident and nobody removes.
 */
export function checkProtectedEnvironment(
  task: string,
  env: string,
  overrides: Record<string, string | undefined> = {},
): void {
  if (DISPOSABLE_ENVIRONMENTS.includes(env)) return;
  if (overrides["DISABLE_DATABASE_ENVIRONMENT_CHECK"]) return;

  throw new ProtectedEnvironment(task, env);
}

/**
 * The tables `truncateAll` should empty. Rails' `truncate_tables`.
 *
 * Everything except the bookkeeping. Truncating `schema_migrations` would make
 * the database look unmigrated, and the next run would try to apply every
 * migration to a schema that already has all of them.
 */
export function truncatableTables(tables: readonly string[]): string[] {
  const skip = new Set(INTERNAL_TABLES);

  return tables.filter((table) => !skip.has(table));
}

/** Rails' `truncate_all` — the statements, for the caller to run. */
export function truncateAll(
  tables: readonly string[],
  env: string,
  {
    quote = (name: string) => `"${name}"`,
    overrides = {},
  }: { quote?: (name: string) => string; overrides?: Record<string, string | undefined> } = {},
): string[] {
  checkProtectedEnvironment("truncate the database", env, overrides);

  return truncatableTables(tables).map((table) => `TRUNCATE TABLE ${quote(table)}`);
}

/** Rails' `purge` — drop everything, including the bookkeeping. */
export function purgeStatements(
  tables: readonly string[],
  env: string,
  {
    quote = (name: string) => `"${name}"`,
    overrides = {},
  }: { quote?: (name: string) => string; overrides?: Record<string, string | undefined> } = {},
): string[] {
  checkProtectedEnvironment("purge the database", env, overrides);

  // Everything, bookkeeping included: a purge is followed by a schema load,
  // and leaving `schema_migrations` behind would tell the fresh schema it had
  // already been migrated.
  return tables.map((table) => `DROP TABLE IF EXISTS ${quote(table)}`);
}

// --- seeds -----------------------------------------------------------------

export interface SeedLoader {
  load(): Promise<void> | void;
}

let loader: SeedLoader | undefined;

/** Rails' `seed_loader`. */
export function seedLoader(): SeedLoader | undefined {
  return loader;
}

export function setSeedLoader(replacement: SeedLoader | undefined): void {
  loader = replacement;
}

export class NoSeedLoader extends Error {
  constructor() {
    super(
      `Nothing is configured to load seeds. Doing nothing silently would make ` +
        `\`db:seed\` appear to succeed against an empty database, which is indistinguishable ` +
        `from seeds that ran and inserted nothing.`,
    );
    this.name = "NoSeedLoader";
  }
}

/**
 * Rails' `load_seed`.
 *
 * Refuses when nothing is configured. Succeeding silently makes `db:seed`
 * against an empty database look identical to seeds that ran and did nothing,
 * and the difference matters when somebody is trying to work out why the app
 * has no data.
 */
export async function loadSeed(): Promise<void> {
  if (!loader) throw new NoSeedLoader();

  await loader.load();
}

// --- version bookkeeping ---------------------------------------------------

/**
 * The version a dumped schema records. Rails' `dump_version` / `define(version:)`.
 *
 * The *highest applied*, not the count and not the newest on disk. A schema
 * loaded into a fresh database is then recorded as having applied everything up
 * to that point, which is what makes `db:schema:load` followed by `db:migrate`
 * a no-op rather than a re-run.
 */
export function dumpVersion(applied: readonly string[]): string | undefined {
  return applied.length === 0 ? undefined : [...applied].sort().at(-1);
}

/** Rails' `load_version` — reading it back out of a dump. */
export function loadVersion(dump: string): string | undefined {
  return /version:\s*"?(\d+)"?/.exec(dump)?.[1];
}

/**
 * Whether a dump can be loaded by this version of the schema language. Rails'
 * `compatible_table_definition?`.
 *
 * A dump written by a newer version may use syntax this one does not have, and
 * loading it half-way leaves a partial schema — worse than refusing, because a
 * partial schema still starts.
 */
export function compatibleWith(dumpVersionNumber: number, supported: number): boolean {
  return dumpVersionNumber <= supported;
}
