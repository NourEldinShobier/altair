/**
 * Which migrations have run, which have not, and what to do about it. Ported
 * from `ActiveRecord::MigrationContext` and `ActiveRecord::SchemaMigration`.
 *
 * `dump.ts` can record a version in `schema_migrations`. What is missing is
 * the comparison: knowing that a database is at version 7 is only useful next
 * to a list of the migrations that exist, and the gap between the two is the
 * question every deploy has to answer.
 *
 * The gap is also where the interesting failure lives. A migration is
 * identified by a timestamp, and two developers working the same afternoon
 * produce 20260830120000 and 20260830113000 — merged in either order. Whichever
 * lands second has a *lower* version than one already applied, so anything
 * that tracks "the current version" as a single number decides it has already
 * run and skips it forever. The database then has a column nothing created and
 * a schema file that disagrees with it.
 *
 * So applied versions are a set, never a maximum. `currentVersion` exists for
 * display and for the schema dump; `pending` is what a deploy asks, and it is
 * computed by subtracting the set — which catches the out-of-order case
 * without needing to know it happened.
 */

import type { Connection } from "./connection.js";
import { SchemaStatements } from "./schema.js";
import type { Migration } from "./schema.js";
// The same error `command_recorder.ts` already raises for a step that cannot
// be inverted. A migration with no `down` is the same situation one level up,
// and Rails uses one error for both.
import { IrreversibleMigration } from "./command_recorder.js";

export type { Migration };

/** What `migrateStatus` reports for one migration. */
export interface MigrationStatus {
  status: "up" | "down";
  version: string;
  name: string;
}

export class UnknownMigrationVersion extends Error {
  constructor(version: string) {
    super(`No migration with version ${version}.`);
    this.name = "UnknownMigrationVersion";
  }
}

/**
 * A version is digits only, and is compared as a string.
 *
 * Rails' timestamps are 14 digits, which exceeds what a double holds exactly
 * — 20260830120000 is fine but the arithmetic near that size is not something
 * to rely on, and a version is an identifier rather than a quantity anyway.
 */
const VERSION = /^\d{1,17}$/;

export function validVersionFormat(version: string): boolean {
  return VERSION.test(version);
}

/**
 * A version as it is stored. Rails' `normalize_migration_number`.
 *
 * Left-padded to 14, because `20260830120000` and `830120000` would otherwise
 * sort against each other by length rather than by time.
 */
export function normalizeMigrationNumber(version: string): string {
  return version.padStart(14, "0");
}

/**
 * A version as a person reads it. Rails' `format_version`.
 *
 * Only a version that is already a timestamp. Padding first and formatting
 * afterwards turns `1` into `0000-00-00 00:00:01`, which is not a date and is
 * worse than the number it came from.
 */
export function formatVersion(version: string): string {
  const [, year, month, day, hour, minute, second] =
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(version) ?? [];

  if (year === undefined) return version;

  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

export function checkVersion(version: string): string {
  if (!validVersionFormat(version)) {
    throw new Error(`"${version}" is not a migration version — versions are digits only.`);
  }

  return normalizeMigrationNumber(version);
}

/**
 * The `schema_migrations` table. Rails' `SchemaMigration`.
 *
 * One row per applied version and nothing else — no timestamps, no ordering
 * column. What ran is a set, and anything more invites code that reads it as a
 * sequence.
 */
export class SchemaMigration {
  readonly connection: Connection;
  readonly table = "schema_migrations";

  constructor(connection: Connection) {
    this.connection = connection;
  }

  async createTable(): Promise<void> {
    await this.connection.execute(
      `CREATE TABLE IF NOT EXISTS ${this.connection.quote(this.table)} ` +
        `(${this.connection.quote("version")} VARCHAR(255) NOT NULL PRIMARY KEY)`,
      [],
    );
  }

  /**
   * Every version that has run. Rails' `migrated` / `integer_versions`.
   *
   * A Set, because every question worth asking of it is membership. Returning
   * a sorted array invites `.at(-1)` as "the current version", which is the
   * out-of-order bug.
   */
  async migrated(): Promise<Set<string>> {
    try {
      const rows = await this.connection.query<{ version: unknown }>(
        `SELECT ${this.connection.quote("version")} FROM ${this.connection.quote(this.table)}`,
      );

      return new Set(rows.map((row) => normalizeMigrationNumber(String(row.version))));
    } catch {
      // No table means nothing has migrated, which is a state and not an error.
      return new Set();
    }
  }

  /** The same, sorted, for a dump or a report. Rails' `normalized_versions`. */
  async normalizedVersions(): Promise<string[]> {
    return Array.from(await this.migrated()).sort();
  }

  /** For a caller that wants numbers rather than the stored strings. */
  async integerVersions(): Promise<number[]> {
    return (await this.normalizedVersions()).map((version) => Number(version));
  }

  async create(version: string): Promise<void> {
    await this.connection.execute(
      `INSERT INTO ${this.connection.quote(this.table)} (${this.connection.quote("version")}) ` +
        `VALUES (${this.connection.placeholder(0)})`,
      [checkVersion(version)],
    );
  }

  /** Rails' `delete_version`. */
  async deleteVersion(version: string): Promise<void> {
    await this.connection.execute(
      `DELETE FROM ${this.connection.quote(this.table)} WHERE ${this.connection.quote("version")} = ${this.connection.placeholder(0)}`,
      [checkVersion(version)],
    );
  }

  /** Rails' `delete_all_versions`. */
  async deleteAllVersions(): Promise<void> {
    await this.connection.execute(`DELETE FROM ${this.connection.quote(this.table)}`, []);
  }

  /**
   * The highest version applied, for the schema file's header. Rails'
   * `current_version`.
   *
   * For display and for the dump only. It is not what "has this migration
   * run?" should ask — see the note at the top of this file.
   */
  async currentVersion(): Promise<string | undefined> {
    const all = await this.normalizedVersions();

    return all[all.length - 1];
  }

  /** The lines a schema dump writes. Rails' `dump_schema_migrations`. */
  async dumpSchemaMigrations(): Promise<string[]> {
    return (await this.normalizedVersions()).map(
      (version) => `INSERT INTO schema_migrations (version) VALUES ('${version}');`,
    );
  }

  /** The versions a dump carries, for loading one back. Rails' `dump_schema_versions`. */
  async dumpSchemaVersions(): Promise<string[]> {
    return this.normalizedVersions();
  }

  /** Records versions from a loaded schema. Rails' `load_schema_migrations`. */
  async loadSchemaMigrations(versions: readonly string[]): Promise<void> {
    await this.createTable();

    for (const version of versions) await this.create(version);
  }
}

/**
 * The migrations that exist, against the ones that have run. Rails'
 * `MigrationContext`.
 */
export class MigrationContext {
  readonly migrations: readonly Migration[];
  readonly schemaMigration: SchemaMigration;
  /** Where they came from, for a message that has to name a directory. */
  readonly migrationsPaths: readonly string[];

  constructor(
    migrations: readonly Migration[],
    connection: Connection,
    migrationsPaths: readonly string[] = ["db/migrate"],
  ) {
    this.migrations = [...migrations].sort((a, b) =>
      normalizeMigrationNumber(a.version).localeCompare(normalizeMigrationNumber(b.version)),
    );
    this.schemaMigration = new SchemaMigration(connection);
    this.migrationsPaths = migrationsPaths;
  }

  get connection(): Connection {
    return this.schemaMigration.connection;
  }

  /** The builder migrations are handed, matching `Migrator`'s. */
  get schema(): SchemaStatements {
    return new SchemaStatements(this.connection);
  }

  /** Every version that exists, in order. */
  versions(): string[] {
    return this.migrations.map((each) => normalizeMigrationNumber(each.version));
  }

  /** The migration with this version. Rails' `migration_class`. */
  migrationClass(version: string): Migration {
    const wanted = checkVersion(version);
    const found = this.migrations.find((each) => normalizeMigrationNumber(each.version) === wanted);

    if (!found) throw new UnknownMigrationVersion(version);

    return found;
  }

  /** Which have run. Rails' `load_migrated`. */
  async loadMigrated(): Promise<Set<string>> {
    return this.schemaMigration.migrated();
  }

  /**
   * Everything that exists but has not run. Rails' `pending_migrations`.
   *
   * By subtracting the applied set rather than comparing against a maximum,
   * which is what makes an out-of-order timestamp merge correctly instead of
   * being skipped forever.
   */
  async pending(): Promise<Migration[]> {
    const applied = await this.loadMigrated();

    return this.migrations.filter((each) => !applied.has(normalizeMigrationNumber(each.version)));
  }

  async needsMigration(): Promise<boolean> {
    return (await this.pending()).length > 0;
  }

  /** What `rails db:migrate:status` prints. Rails' `migrate_status`. */
  async migrateStatus(): Promise<MigrationStatus[]> {
    const applied = await this.loadMigrated();
    const known = new Set(this.versions());

    const rows: MigrationStatus[] = this.migrations.map((each) => ({
      status: applied.has(normalizeMigrationNumber(each.version)) ? "up" : "down",
      version: normalizeMigrationNumber(each.version),
      name: each.name ?? "unnamed",
    }));

    // A version in the table with no migration to match is worth showing, not
    // hiding: it means the file was deleted or the branch was switched, and
    // the schema now has changes nothing in the tree accounts for.
    for (const version of Array.from(applied).sort()) {
      if (!known.has(version)) {
        rows.push({ status: "up", version, name: "********** NO FILE **********" });
      }
    }

    return rows.sort((a, b) => a.version.localeCompare(b.version));
  }

  /**
   * Runs everything pending, oldest first. Rails' `migrate`.
   *
   * Each is recorded as soon as it succeeds rather than all at the end: a run
   * that fails halfway has genuinely applied the ones before it, and a
   * `schema_migrations` that does not say so makes the next run try them
   * again.
   */
  async migrateAll(): Promise<Migration[]> {
    await this.schemaMigration.createTable();

    const ran: Migration[] = [];

    for (const migration of await this.pending()) {
      await migration.up(this.schema);
      await this.schemaMigration.create(migration.version);
      ran.push(migration);
    }

    return ran;
  }

  /** Runs one, whether or not it is pending. */
  async up(version: string): Promise<void> {
    const migration = this.migrationClass(version);

    await this.schemaMigration.createTable();
    await migration.up(this.schema);
    await this.schemaMigration.create(migration.version);
  }

  /**
   * Undoes one. Rails' `down`.
   *
   * Refuses rather than silently forgetting the version when there is no
   * `down`: dropping the row would say the migration never ran, and the next
   * deploy would apply it a second time on top of itself.
   */
  async down(version: string): Promise<void> {
    const migration = this.migrationClass(version);

    if (!migration.down)
      throw new IrreversibleMigration(
        `Migration ${migration.version} (${migration.name ?? "unnamed"})`,
      );

    await migration.down(this.schema);
    await this.schemaMigration.deleteVersion(migration.version);
  }

  /** Undoes the last `steps` applied migrations, newest first. */
  async rollback(steps = 1): Promise<Migration[]> {
    const applied = await this.schemaMigration.normalizedVersions();
    const undone: Migration[] = [];

    for (const version of applied.reverse().slice(0, steps)) {
      // A version with no migration cannot be rolled back, and stopping is
      // better than skipping past it into one that is older still.
      const migration = this.migrations.find(
        (each) => normalizeMigrationNumber(each.version) === version,
      );

      if (!migration) throw new UnknownMigrationVersion(version);

      await this.down(version);
      undone.push(migration);
    }

    return undone;
  }

  /** The highest applied version, for the schema file's header. */
  async currentVersion(): Promise<string | undefined> {
    return this.schemaMigration.currentVersion();
  }
}
