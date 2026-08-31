/**
 * Resolving which database a model talks to, ported from
 * `ActiveRecord::DatabaseConfigurations` and `DatabaseConfigurations::HashConfig`.
 *
 * `databases.ts` holds the connections once something has decided what they
 * are. This is the deciding: a configuration file lists an entry per
 * environment, and under each environment an entry per database — primary, a
 * read replica, an analytics store, four shards — and every task and every
 * model has to ask the same question and get the same answer.
 *
 * The question that actually matters is not "which database" but **"which of
 * these does `db:migrate` touch"**. Getting it wrong is not a crash:
 *
 * - Migrating a read replica runs DDL against a server that replicates *from*
 *   somewhere else, and the next replication event undoes it or breaks.
 * - Migrating a database owned by another application applies your schema to
 *   their tables.
 * - *Not* migrating a shard leaves one of four shards a version behind, which
 *   surfaces as an error on a fraction of requests that depends on which shard
 *   a user hashed to.
 *
 * So `databaseTasks` defaults to true for ordinary entries, is forced false for
 * replicas, and is honoured exactly as written otherwise.
 */

/** One entry under one environment. Rails' `HashConfig`. */
export interface DatabaseConfiguration {
  /** The environment it belongs to: `development`, `production`. */
  env: string;
  /** The name under it: `primary`, `animals`, `shard_one`. */
  name: string;
  /** Everything the adapter needs. */
  adapter?: string;
  database?: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  url?: string;
  pool?: number;
  /** Rails' `replica:` — a read-only follower. */
  replica?: boolean;
  /** Rails' `database_tasks:` — whether `db:migrate` and friends touch it. */
  databaseTasks?: boolean;
  /** Rails' `migrations_paths:`. */
  migrationsPaths?: string | string[];
  /** Rails' `schema_dump:` — the file the schema is written to, or false. */
  schemaDump?: string | false;
  [option: string]: unknown;
}

/** What `configsFor` was asked for. */
export interface ConfigQuery {
  env?: string;
  name?: string;
  /** Rails' `include_hidden` — entries excluded from database tasks. */
  includeHidden?: boolean;
}

export const PRIMARY_NAME = "primary";

/**
 * Whether `db:migrate` and friends touch an entry. Rails' `database_tasks?`.
 *
 * A replica is forced to false whatever the file says. Running DDL against a
 * follower is not a slower way to migrate — it is DDL on a server whose
 * contents come from somewhere else, and the next replication event either
 * undoes it or stops.
 */
export function databaseTasks(config: DatabaseConfiguration): boolean {
  if (config.replica === true) return false;

  return config.databaseTasks !== false;
}

/** Rails' `replica?`. */
export function replica(config: DatabaseConfiguration): boolean {
  return config.replica === true;
}

/** Rails' `primary?`. */
export function isPrimary(config: DatabaseConfiguration): boolean {
  return config.name === PRIMARY_NAME;
}

export class UnknownDatabaseConfiguration extends Error {
  constructor(env: string, name: string | undefined, known: readonly string[]) {
    super(
      `No database configuration for ${JSON.stringify(name ?? "any")} in ${JSON.stringify(env)}. ` +
        `Configured there: ${known.join(", ") || "none"}. Falling back to another entry would ` +
        `connect a task to a database nobody named, which for a destructive task is the wrong ` +
        `database entirely.`,
    );
    this.name = "UnknownDatabaseConfiguration";
  }
}

/**
 * Every configured database, by environment. Rails' `DatabaseConfigurations`.
 */
export class DatabaseConfigurations {
  readonly #configs: DatabaseConfiguration[];

  constructor(configs: readonly DatabaseConfiguration[] = []) {
    this.#configs = [...configs];
  }

  /**
   * Builds from the shape a configuration file has. Rails' `build_configs`.
   *
   * Two shapes per environment, because Rails accepts both: a single database
   * is written flat, several are written as a map of names. Treating the flat
   * form as a map of names would read `adapter` and `database` as two database
   * names, which fails far from the file.
   */
  static from(file: Record<string, Record<string, unknown>>): DatabaseConfigurations {
    const configs: DatabaseConfiguration[] = [];

    for (const [env, entry] of Object.entries(file)) {
      const named = Object.entries(entry).filter(
        ([, value]) => typeof value === "object" && value !== null && !Array.isArray(value),
      );

      if (named.length === 0) {
        configs.push({ ...(entry as DatabaseConfiguration), env, name: PRIMARY_NAME });
        continue;
      }

      for (const [name, value] of named) {
        configs.push({ ...(value as DatabaseConfiguration), env, name });
      }
    }

    return new DatabaseConfigurations(configs);
  }

  /** Rails' `configs_for`. */
  configsFor({ env, name, includeHidden = false }: ConfigQuery = {}): DatabaseConfiguration[] {
    return this.#configs.filter((config) => {
      if (env !== undefined && config.env !== env) return false;
      if (name !== undefined && config.name !== name) return false;

      // Hidden entries are still *reachable* — a model can point at one — they
      // are only left out of the list the tasks iterate. Filtering them out of
      // everything would make an entry that says `database_tasks: false`
      // unusable rather than untouched.
      return includeHidden || databaseTasks(config);
    });
  }

  /**
   * One entry, or an error. Rails' `find_db_config`.
   *
   * Never a fallback. Connecting a task to a database nobody named is, for
   * anything destructive, the wrong database entirely.
   */
  findDbConfig(env: string, name = PRIMARY_NAME): DatabaseConfiguration {
    const found = this.configsFor({ env, name, includeHidden: true })[0];

    if (!found) {
      throw new UnknownDatabaseConfiguration(
        env,
        name,
        this.configsFor({ env, includeHidden: true }).map((each) => each.name),
      );
    }

    return found;
  }

  /** Rails' `primary?` lookup — the entry a model uses when it says nothing. */
  primary(env: string): DatabaseConfiguration {
    const named = this.configsFor({ env, name: PRIMARY_NAME, includeHidden: true })[0];

    if (named) return named;

    // Rails falls back to the first entry, which is what makes a single-database
    // file work without anybody writing the word "primary".
    const first = this.configsFor({ env, includeHidden: true })[0];

    if (!first) throw new UnknownDatabaseConfiguration(env, undefined, []);

    return first;
  }

  /** Rails' `env_names`. */
  envNames(): string[] {
    return [...new Set(this.#configs.map((each) => each.env))].sort();
  }

  /** The names configured under an environment. */
  names(env: string): string[] {
    return this.configsFor({ env, includeHidden: true }).map((each) => each.name);
  }

  get size(): number {
    return this.#configs.length;
  }
}

// --- shards and roles ------------------------------------------------------

/**
 * Rails' `shard_keys` — the shards an application is configured for.
 *
 * Shards are named entries that share a schema, so `shard_one` and `shard_two`
 * are shards of the same logical database rather than two databases. Rails
 * distinguishes them by the model declaring `connects_to shards:`, so this
 * takes the declaration rather than guessing from names — guessing would make
 * an unrelated database called `shard_report` a shard.
 */
export function shardKeys(declared: Record<string, unknown> | undefined): string[] {
  return Object.keys(declared ?? {});
}

/** Rails' `sharded?`. */
export function sharded(declared: Record<string, unknown> | undefined): boolean {
  return shardKeys(declared).length > 1;
}

/** Rails' `role_names`. */
export function roleNames(declared: Record<string, unknown> | undefined): string[] {
  return Object.keys(declared ?? {});
}

/**
 * The key a connection is registered under. Rails'
 * `connection_specification_name`.
 *
 * All three parts, because all three change which server a query reaches. A
 * key missing the role sends a write to a replica; one missing the shard sends
 * a query for one tenant to another tenant's database.
 */
export function connectionSpecificationName(
  name: string,
  role = "writing",
  shard = "default",
): string {
  return `${name}/${role}/${shard}`;
}

// --- coercion --------------------------------------------------------------

/**
 * Rails' `type_cast_config_to_boolean`.
 *
 * Configuration arrives from YAML and from the environment, and the
 * environment has only strings. `"false"` is truthy in JavaScript, so a
 * `POOL_PREPARED_STATEMENTS=false` read without this turns the setting *on* —
 * which is the exact opposite of what the operator typed.
 */
export function typeCastConfigToBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;

  const text = String(value).trim().toLowerCase();

  if (["false", "0", "no", "off"].includes(text)) return false;
  if (["true", "1", "yes", "on"].includes(text)) return true;

  return undefined;
}

/**
 * Rails' `type_cast_config_to_integer`.
 *
 * Returns nothing rather than `NaN` for something unparseable. `NaN` reaching
 * a pool size makes every comparison against it false, so the pool silently
 * behaves as though it had no limit.
 */
export function typeCastConfigToInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : undefined;

  const parsed = Number.parseInt(String(value).trim(), 10);

  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Rails' `validate_default_timezone`. */
export function validateDefaultTimezone(value: unknown): "utc" | "local" {
  if (value === "utc" || value === "local") return value;

  throw new Error(
    `"${String(value)}" is not a database timezone. It must be "utc" or "local": anything else ` +
      `would be treated as one of them, and picking the wrong one shifts every stored time by ` +
      `the machine's offset.`,
  );
}

// --- what a task should do with an entry -----------------------------------

/** Rails' `use_metadata_table?`. */
export function useMetadataTable(config: DatabaseConfiguration): boolean {
  return config["useMetadataTable"] !== false;
}

/** Rails' `use_foreign_keys?` — whether the schema dumper emits them. */
export function useForeignKeys(config: DatabaseConfiguration): boolean {
  return config["useForeignKeys"] !== false;
}

/**
 * Rails' `schema_dump` — where the schema for this entry is written.
 *
 * Per entry, not per application. Two databases dumping to one file is how the
 * second overwrites the first and a `db:schema:load` recreates half a schema.
 */
export function schemaDumpPath(
  config: DatabaseConfiguration,
  format: "ruby" | "sql" = "ruby",
): string | undefined {
  if (config.schemaDump === false) return undefined;
  if (typeof config.schemaDump === "string") return config.schemaDump;

  const extension = format === "sql" ? "structure.sql" : "schema.rb";

  return isPrimary(config) ? `db/${extension}` : `db/${config.name}_${extension}`;
}

/** Rails' `migrations_paths`, always as a list. */
export function migrationsPaths(config: DatabaseConfiguration): string[] {
  if (config.migrationsPaths === undefined) return ["db/migrate"];

  return Array.isArray(config.migrationsPaths) ? config.migrationsPaths : [config.migrationsPaths];
}

/**
 * Rails' `use_transactional_tests?` for one database.
 *
 * A test wrapping its work in a transaction it rolls back is only possible on
 * a database this process owns. One shared with another service, or a replica,
 * has to be left alone — a rollback there would discard whatever else was
 * writing at the time.
 */
export function useTransactionalTestsForDatabase(config: DatabaseConfiguration): boolean {
  return !replica(config) && config["shared"] !== true;
}

/** The inverse, for a task that wants the list to skip. */
export function skipTransactionalTestsForDatabase(config: DatabaseConfiguration): boolean {
  return !useTransactionalTestsForDatabase(config);
}
