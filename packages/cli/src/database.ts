/**
 * Creating and dropping the database itself, ported from Rails' `db:create`
 * and `db:drop`.
 *
 * Every other database task assumes the database is there. These are the ones
 * that put it there, and they are the only tasks that cannot connect to it to
 * do their work: `CREATE DATABASE app_development` has to be run from
 * somewhere else.
 *
 * Where that somewhere is differs by adapter, which is the whole content of
 * this file. SQLite has no such statement at all — a database is a file, and
 * opening it makes it.
 */

import { unlink } from "node:fs/promises";

/** What these need from a connection, so the CLI need not import the ORM's. */
export interface DatabaseTarget {
  adapter: "sqlite" | "postgres" | "mysql";
  /** The database's name, or the file's path on SQLite. */
  name: string;
  /** A URL pointing at somewhere the statement can be run from. */
  maintenanceUrl: string;
}

/**
 * Reads a connection URL into the parts these tasks need.
 *
 * The maintenance URL is the interesting one: `CREATE DATABASE` cannot be run
 * from the database it creates, so Postgres connects to `postgres` — which
 * every server has — and MySQL connects with no database named at all.
 */
export function targetFor(url: string): DatabaseTarget {
  if (url.startsWith("sqlite:") || url === ":memory:") {
    return {
      adapter: "sqlite",
      name: url.replace(/^sqlite:\/\/|^sqlite:/, ""),
      maintenanceUrl: url,
    };
  }

  const parsed = new URL(url);
  const name = parsed.pathname.replace(/^\//, "");
  const adapter = parsed.protocol.startsWith("postgres") ? "postgres" : "mysql";

  const maintenance = new URL(url);
  maintenance.pathname = adapter === "postgres" ? "/postgres" : "/";

  return { adapter, name, maintenanceUrl: maintenance.toString() };
}

/** What a task did, so the CLI can say so without deciding how. */
export interface DatabaseResult {
  output: string;
  changed: boolean;
}

/** The slice of a connection these tasks use. */
export interface MaintenanceConnection {
  execute(sql: string, bindings?: unknown[]): Promise<unknown>;
  query<T>(sql: string, bindings?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

/**
 * A name written into a statement rather than bound.
 *
 * A database name cannot be a parameter — it is part of the statement, not a
 * value in it — so it is checked instead. Anything but a plain identifier is
 * refused rather than quoted, because the alternative is deciding how each
 * adapter escapes a name in a place where getting it wrong runs whatever was
 * in it.
 */
export function assertDatabaseName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_$-]*$/.test(name)) {
    throw new Error(
      `Refusing to use ${JSON.stringify(name)} as a database name: it must start with a letter or underscore and contain only letters, digits, underscores, dollars or dashes.`,
    );
  }
}

/**
 * Creates the database, and says so if it was already there.
 *
 * Already existing is not an error: `db:create` is run as part of setting a
 * machine up, and a second run should be quiet rather than fatal.
 */
export async function createDatabase(
  target: DatabaseTarget,
  connect: (url: string) => Promise<MaintenanceConnection>,
): Promise<DatabaseResult> {
  if (target.adapter === "sqlite") {
    // A file database is made by opening it, and `:memory:` is made by asking.
    if (target.name === ":memory:")
      return { output: "In-memory database, nothing to create.", changed: false };

    const file = Bun.file(target.name);
    if (await file.exists()) return { output: `${target.name} already exists.`, changed: false };

    await Bun.write(target.name, "");
    return { output: `Created ${target.name}.`, changed: true };
  }

  assertDatabaseName(target.name);

  const connection = await connect(target.maintenanceUrl);

  try {
    await connection.execute(`CREATE DATABASE ${quoteName(target)}`);
    return { output: `Created ${target.name}.`, changed: true };
  } catch (error) {
    if (alreadyExists(error)) return { output: `${target.name} already exists.`, changed: false };

    throw error;
  } finally {
    await connection.close();
  }
}

/** Drops the database, and says so if there was nothing to drop. */
export async function dropDatabase(
  target: DatabaseTarget,
  connect: (url: string) => Promise<MaintenanceConnection>,
): Promise<DatabaseResult> {
  if (target.adapter === "sqlite") {
    if (target.name === ":memory:")
      return { output: "In-memory database, nothing to drop.", changed: false };

    try {
      await unlink(target.name);
      return { output: `Dropped ${target.name}.`, changed: true };
    } catch {
      return { output: `${target.name} does not exist.`, changed: false };
    }
  }

  assertDatabaseName(target.name);

  const connection = await connect(target.maintenanceUrl);

  try {
    await connection.execute(`DROP DATABASE ${quoteName(target)}`);
    return { output: `Dropped ${target.name}.`, changed: true };
  } catch (error) {
    if (doesNotExist(error)) return { output: `${target.name} does not exist.`, changed: false };

    throw error;
  } finally {
    await connection.close();
  }
}

function quoteName(target: DatabaseTarget): string {
  return target.adapter === "mysql" ? `\`${target.name}\`` : `"${target.name}"`;
}

/** Whether an error means the database was already there. */
function alreadyExists(error: unknown): boolean {
  const message = String((error as Error)?.message ?? "").toLowerCase();

  return message.includes("already exists") || message.includes("database exists");
}

/** Whether an error means there was nothing to drop. */
function doesNotExist(error: unknown): boolean {
  const message = String((error as Error)?.message ?? "").toLowerCase();

  return (
    message.includes("does not exist") ||
    message.includes("doesn't exist") ||
    message.includes("unknown database")
  );
}
