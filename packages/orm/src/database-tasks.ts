/**
 * The `db:*` tasks, ported from `ActiveRecord::Tasks::DatabaseTasks`.
 *
 * `schema-tasks.ts` has the pieces — which tables are dumpable, whether the
 * schema is up to date, whether this environment may be destroyed.
 * `database-configurations.ts` has the configurations. This is the layer that
 * decides *which* databases a task runs against, and in what order.
 *
 * That sounds like plumbing and is where the interesting failures are, because
 * an application with more than one database has two of everything and the
 * tasks have to be explicit about which:
 *
 * - **`db:create` means every database for this environment; `db:create:primary`
 *   means one.** A task that quietly did "all" when given a name would create
 *   the replica alongside the primary — usually harmless — and a task that
 *   quietly did "primary" when asked for all would leave the second database
 *   missing, which appears much later as a connection error naming a database
 *   nobody remembers configuring.
 * - **A replica is never created, dropped, migrated or purged.** It is the same
 *   physical database as its primary under a different connection, so running
 *   any of those against it does the work twice — and `purge` twice is one
 *   destroyed database and one destroyed database that was already empty.
 * - **The destructive tasks refuse to run outside a disposable environment.**
 *   `db:drop` in production is unrecoverable and is exactly the kind of thing
 *   that gets run by a deploy script pointed at the wrong environment.
 */

import { type DatabaseConfiguration, databaseTasks } from "./database-configurations.js";
import { checkProtectedEnvironment } from "./schema-tasks.js";

/**
 * Rails' `for_current_env` — the configurations one task applies to.
 *
 * Replicas are excluded here rather than in each task, so a task added later
 * cannot forget: a replica is the same physical database as its primary under
 * another connection, so creating, dropping, migrating or purging it does the
 * work twice — and `purge` twice is one destroyed database and one destroyed
 * database that was already empty.
 */
export function forCurrentEnv(
  configs: readonly DatabaseConfiguration[],
  env: string,
): DatabaseConfiguration[] {
  // `databaseTasks` is the one question, and it already answers no for a
  // replica — asking separately would be a second place for the two to come to
  // disagree. It also covers `database_tasks: false`, for a database the
  // application connects to and does not own: an analytics warehouse, a legacy
  // schema somebody else migrates.
  return configs.filter((config) => config.env === env && databaseTasks(config));
}

/**
 * Rails' `raise_for_multi_db` — refuse an ambiguous task.
 *
 * A task with no name against several databases is ambiguous, and guessing
 * "the first one" would migrate one database and leave the other behind — a
 * difference that surfaces as a missing column much later, in whichever code
 * path happened to use the other connection.
 */
export function raiseForMultiDb(configs: readonly DatabaseConfiguration[], task: string): void {
  if (configs.length <= 1) return;

  throw new Error(
    `${task} needs to say which database: this environment has ${configs.length} ` +
      `(${configs.map((config) => config.name).join(", ")}). Guessing would act on one and ` +
      `leave the others behind, which surfaces as a missing column somewhere unrelated.`,
  );
}

/** Rails' `create_current` / `drop_current` — the one named database. */
export function forName(
  configs: readonly DatabaseConfiguration[],
  env: string,
  name: string,
): DatabaseConfiguration {
  const found = configs.find((config) => config.env === env && config.name === name);

  if (found === undefined) {
    const available = configs.filter((config) => config.env === env).map((config) => config.name);

    throw new Error(
      `No database named ${JSON.stringify(name)} in ${env}. Configured: ` +
        `${available.join(", ") || "none"}.`,
    );
  }

  return found;
}

// --- the tasks themselves ---------------------------------------------------------------

export interface TaskRunner {
  create(config: DatabaseConfiguration): Promise<void> | void;
  drop(config: DatabaseConfiguration): Promise<void> | void;
  purge(config: DatabaseConfiguration): Promise<void> | void;
  loadSchema(config: DatabaseConfiguration): Promise<void> | void;
  dumpSchema(config: DatabaseConfiguration): Promise<void> | void;
}

/**
 * Rails' `create_all`.
 *
 * Keeps going past a database that already exists — running `db:create` twice
 * is the normal case, and an application with two databases where one already
 * exists would otherwise be unable to create the other without dropping the
 * first.
 */
export async function createAll(
  runner: TaskRunner,
  configs: readonly DatabaseConfiguration[],
  env: string,
): Promise<{ created: string[]; existing: string[] }> {
  const created: string[] = [];
  const existing: string[] = [];

  for (const config of forCurrentEnv(configs, env)) {
    try {
      await runner.create(config);
      created.push(config.name);
    } catch (error) {
      if (!alreadyExists(error)) throw error;

      existing.push(config.name);
    }
  }

  return { created, existing };
}

function alreadyExists(error: unknown): boolean {
  return /already exists|duplicate database/i.test((error as Error).message ?? "");
}

/** Rails' `create_current` — one database, named. */
export async function createCurrent(
  runner: TaskRunner,
  configs: readonly DatabaseConfiguration[],
  env: string,
  name?: string,
): Promise<string> {
  const config =
    name === undefined ? onlyOne(configs, env, "db:create") : forName(configs, env, name);

  await runner.create(config);

  return config.name;
}

function onlyOne(
  configs: readonly DatabaseConfiguration[],
  env: string,
  task: string,
): DatabaseConfiguration {
  const forEnv = forCurrentEnv(configs, env);
  raiseForMultiDb(forEnv, task);

  const only = forEnv[0];

  if (only === undefined) throw new Error(`No databases configured for ${env}.`);

  return only;
}

/**
 * Rails' `drop_all`.
 *
 * Checks the environment once for the whole task rather than per database. The
 * check is about *where* this is running, not about which database — asking
 * per database would let a task that dropped the first one fail on the second,
 * leaving the application in a state neither environment expects.
 */
export async function dropAll(
  runner: TaskRunner,
  configs: readonly DatabaseConfiguration[],
  env: string,
): Promise<string[]> {
  checkProtectedEnvironment("db:drop", env);

  const dropped: string[] = [];

  for (const config of forCurrentEnv(configs, env)) {
    await runner.drop(config);
    dropped.push(config.name);
  }

  return dropped;
}

/** Rails' `drop_current`. */
export async function dropCurrent(
  runner: TaskRunner,
  configs: readonly DatabaseConfiguration[],
  env: string,
  name?: string,
): Promise<string> {
  checkProtectedEnvironment("db:drop", env);

  const config =
    name === undefined ? onlyOne(configs, env, "db:drop") : forName(configs, env, name);

  await runner.drop(config);

  return config.name;
}

/** Rails' `purge_all` — empty every database without dropping it. */
export async function purgeAll(
  runner: TaskRunner,
  configs: readonly DatabaseConfiguration[],
  env: string,
): Promise<string[]> {
  checkProtectedEnvironment("db:purge", env);

  const purged: string[] = [];

  for (const config of forCurrentEnv(configs, env)) {
    await runner.purge(config);
    purged.push(config.name);
  }

  return purged;
}

/** Rails' `purge_current`. */
export async function purgeCurrent(
  runner: TaskRunner,
  configs: readonly DatabaseConfiguration[],
  env: string,
  name?: string,
): Promise<string> {
  checkProtectedEnvironment("db:purge", env);

  const config =
    name === undefined ? onlyOne(configs, env, "db:purge") : forName(configs, env, name);

  await runner.purge(config);

  return config.name;
}

/**
 * Rails' `recreate_database` — drop then create, in that order.
 *
 * A single operation because the two halves are useless apart: a drop that
 * succeeds and a create that fails leaves no database at all, so the create is
 * attempted even when the drop failed for the ordinary reason.
 */
export async function recreateDatabase(
  runner: TaskRunner,
  config: DatabaseConfiguration,
  env: string,
): Promise<void> {
  checkProtectedEnvironment("db:recreate", env);

  try {
    await runner.drop(config);
  } catch (error) {
    // A database that is not there is exactly the state a drop was aiming for.
    if (!/does not exist|unknown database/i.test((error as Error).message ?? "")) throw error;
  }

  await runner.create(config);
}

/**
 * Rails' `create_and_load_schema` — the two together.
 *
 * One call, because a created database with no schema is worse than none: it
 * exists, so `db:create` reports success on the next run and never loads the
 * schema, and the failure appears as a missing table.
 */
export async function createAndLoadSchema(
  runner: TaskRunner,
  config: DatabaseConfiguration,
): Promise<void> {
  await runner.create(config);

  try {
    await runner.loadSchema(config);
  } catch (error) {
    // The half-made database is removed, so the next `db:create` genuinely
    // creates rather than reporting that it already exists.
    await runner.drop(config);

    throw error;
  }
}

/** Rails' `load_schema_current`. */
export async function loadSchemaCurrent(
  runner: TaskRunner,
  configs: readonly DatabaseConfiguration[],
  env: string,
  name?: string,
): Promise<string> {
  const config =
    name === undefined ? onlyOne(configs, env, "db:schema:load") : forName(configs, env, name);

  await runner.loadSchema(config);

  return config.name;
}

/**
 * Rails' `dump_all` — a schema file per database.
 *
 * Per database rather than one combined file, because the files are checked in
 * and a combined one makes every migration on either database a conflict in
 * the same file.
 */
export async function dumpAll(
  runner: TaskRunner,
  configs: readonly DatabaseConfiguration[],
  env: string,
): Promise<string[]> {
  const dumped: string[] = [];

  for (const config of forCurrentEnv(configs, env)) {
    await runner.dumpSchema(config);
    dumped.push(
      typeof config.schemaDump === "string" ? config.schemaDump : `db/${config.name}_schema.rb`,
    );
  }

  return dumped;
}

/**
 * Rails' `prepare_all` — create if missing, otherwise migrate.
 *
 * The task an application actually runs on boot, and it has to be safe to run
 * against a database that is already there — which is why it is not
 * `create` followed by `load_schema`.
 */
export async function prepareAll(
  runner: TaskRunner,
  configs: readonly DatabaseConfiguration[],
  env: string,
): Promise<{ created: string[]; loaded: string[] }> {
  const { created, existing } = await createAll(runner, configs, env);

  for (const name of created) {
    await runner.loadSchema(forName(configs, env, name));
  }

  return { created, loaded: existing };
}

// --- structure dumps ---------------------------------------------------------------------

/**
 * The database name a command needs, refused rather than defaulted.
 *
 * A configuration with a URL and no `database:` key is ordinary, and a command
 * built with an empty name connects to whichever database the client defaults
 * to — usually one named after the current user, which then gets the dump.
 */
function databaseName(config: DatabaseConfiguration): string {
  if (typeof config.database === "string" && config.database !== "") return config.database;

  throw new Error(
    `The ${JSON.stringify(config.name)} configuration has no database name. A command built ` +
      `without one connects to whichever database the client defaults to, which is usually one ` +
      `named after the current user — and that is the one that would be dumped or dropped.`,
  );
}

/**
 * Rails' `structure_dump` — the command that writes a SQL schema file.
 *
 * Per adapter because there is no portable way to do it, and each tool wants
 * its options in a different order. The schema-only flag is not optional: a
 * dump that included data would be checked into version control, which is how
 * a production export ends up in a public repository.
 */
export function structureDump(config: DatabaseConfiguration, path: string): string[] {
  switch (config.adapter) {
    case "postgres":
      return [
        "pg_dump",
        "--schema-only",
        "--no-privileges",
        "--no-owner",
        "--file",
        path,
        databaseName(config),
      ];
    case "mysql":
      return ["mysqldump", "--no-data", "--routines", "--result-file", path, databaseName(config)];
    case "sqlite":
      return ["sqlite3", databaseName(config), ".schema"];
    default:
      throw new Error(
        `No structure dump for the ${String(config.adapter)} adapter. Guessing a command would produce a ` +
          `file that looks like a schema and is not one.`,
      );
  }
}

/** Rails' `structure_load`. */
export function structureLoad(config: DatabaseConfiguration, path: string): string[] {
  switch (config.adapter) {
    case "postgres":
      // `--set ON_ERROR_STOP=1`, or psql reports success after failing every
      // statement in the file — which produces an empty database and a green
      // deploy.
      return ["psql", "--set", "ON_ERROR_STOP=1", "--quiet", "--file", path, databaseName(config)];
    case "mysql":
      return ["mysql", "--database", databaseName(config), "--execute", `source ${path}`];
    case "sqlite":
      return ["sqlite3", databaseName(config), `.read ${path}`];
    default:
      throw new Error(`No structure load for the ${String(config.adapter)} adapter.`);
  }
}

// --- context for a migration ----------------------------------------------------------------

/**
 * Where one database's migrations live. Named for the paths rather than
 * `MigrationContext`, which `migration-context.ts` already uses for the object
 * that runs them.
 */
export interface MigrationPaths {
  paths: string[];
  schemaMigrationTable: string;
  internalMetadataTable: string;
}

/**
 * Rails' `migration_context` — where a database's migrations live.
 *
 * Per database, because a second database has its own migrations directory and
 * its own `schema_migrations` table. Sharing either makes a migration applied
 * to one database look applied to the other, so it is silently skipped.
 */
export function migrationContext(config: DatabaseConfiguration): MigrationPaths {
  const declared = [config.migrationsPaths ?? []].flat();

  return {
    paths:
      declared.length > 0
        ? declared
        : [`db/${config.name === "primary" ? "" : `${config.name}_`}migrate`],
    schemaMigrationTable: "schema_migrations",
    internalMetadataTable: "ar_internal_metadata",
  };
}

/**
 * Rails' `schema_search_path` — which schemas a dump includes.
 *
 * `public` alone by default. Dumping every schema would include whatever an
 * extension installed — PostGIS puts several thousand functions in one — and
 * the resulting file is both unreadable and unloadable on a database without
 * that extension.
 */
export function schemaSearchPath(configured?: string): string[] {
  return (configured ?? "public")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Rails' `db:console` command for an adapter.
 *
 * The password is deliberately not on the command line: arguments are visible
 * in the process list to every user on the machine, so it goes through the
 * environment instead.
 */
export function dbconsole(config: DatabaseConfiguration): {
  command: string[];
  env: Record<string, string>;
} {
  switch (config.adapter) {
    case "postgres":
      return {
        command: [
          "psql",
          ...(config.host === undefined ? [] : ["--host", config.host]),
          ...(config.username === undefined ? [] : ["--username", config.username]),
          databaseName(config),
        ],
        env: { PGPASSWORD: "" },
      };
    case "mysql":
      return {
        command: [
          "mysql",
          ...(config.host === undefined ? [] : ["--host", config.host]),
          ...(config.username === undefined ? [] : ["--user", config.username]),
          databaseName(config),
        ],
        env: { MYSQL_PWD: "" },
      };
    case "sqlite":
      return { command: ["sqlite3", databaseName(config)], env: {} };
    default:
      throw new Error(`No console command for the ${String(config.adapter)} adapter.`);
  }
}

const registeredTasks = new Map<string, (config: DatabaseConfiguration) => Promise<void> | void>();

/**
 * Rails' `register_task` — an adapter supplying its own implementation.
 *
 * Registered by adapter name rather than matched by pattern, because a pattern
 * that matched two adapters would silently pick whichever registered last —
 * and the failure is a `pg_dump` run against MySQL.
 */
export function registerTask(
  adapter: string,
  task: (config: DatabaseConfiguration) => Promise<void> | void,
): void {
  registeredTasks.set(adapter, task);
}

export function taskFor(
  adapter: string,
): ((config: DatabaseConfiguration) => Promise<void> | void) | undefined {
  return registeredTasks.get(adapter);
}

export function resetTasks(): void {
  registeredTasks.clear();
}
