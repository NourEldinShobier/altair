/**
 * Refusing destructive tasks where they would be a catastrophe, ported from
 * `ActiveRecord::Tasks::DatabaseTasks` protected-environment checks.
 *
 * The failure this exists for is specific and famous: somebody runs
 * `db:drop` or `db:schema:load` with the wrong environment loaded and empties
 * production. It is not a rare mistake — a terminal left in the wrong
 * directory, a `RAILS_ENV` exported an hour ago and forgotten, a deploy script
 * that inherits an environment it did not set — and it has no undo.
 *
 * So the check is not "are you sure": it is a refusal that has to be
 * overridden deliberately, in a way nobody types by accident.
 */

import type { Connection } from "./connection.js";

/** Environments where destructive tasks are refused. Rails' `protected_environments`. */
let protectedNames = new Set(["production"]);

export function setProtectedEnvironments(...names: string[]): void {
  protectedNames = new Set(names);
}

export function protectedEnvironments(): string[] {
  return [...protectedNames];
}

export function isProtectedEnvironment(name: string): boolean {
  return protectedNames.has(name);
}

/** Raised when a destructive task meets a protected environment. */
export class ProtectedEnvironmentError extends Error {
  constructor(
    readonly environment: string,
    readonly task: string,
  ) {
    super(
      `You are attempting to run ${task} against your ${environment} database, ` +
        `which is protected. If you are sure, set DISABLE_DATABASE_ENVIRONMENT_CHECK=1.`,
    );
    this.name = "ProtectedEnvironmentError";
  }
}

/**
 * The environment the *database* believes it is, as recorded when the schema
 * was last loaded. Rails' `last_stored_environment`.
 *
 * The stored value is what makes the check work at all. Comparing against the
 * process's own environment variable only catches the case where that variable
 * is wrong — and the dangerous case is precisely the one where it is right for
 * the process and wrong for the database it happens to be pointed at.
 */
export async function storedEnvironment(connection: Connection): Promise<string | undefined> {
  const rows = await connection.query<{ value: string }>(
    `SELECT ${connection.quote("value")} FROM ${connection.quote("ar_internal_metadata")} ` +
      `WHERE ${connection.quote("key")} = ${connection.placeholder(0)}`,
    ["environment"],
  );

  return rows[0]?.value;
}

/** Records which environment this database belongs to. */
export async function storeEnvironment(connection: Connection, environment: string): Promise<void> {
  await connection.execute(
    `CREATE TABLE IF NOT EXISTS ${connection.quote("ar_internal_metadata")} (` +
      `${connection.quote("key")} VARCHAR(255) NOT NULL PRIMARY KEY, ` +
      `${connection.quote("value")} VARCHAR(255))`,
  );

  await connection.execute(
    `DELETE FROM ${connection.quote("ar_internal_metadata")} ` +
      `WHERE ${connection.quote("key")} = ${connection.placeholder(0)}`,
    ["environment"],
  );

  await connection.execute(
    `INSERT INTO ${connection.quote("ar_internal_metadata")} ` +
      `(${connection.quote("key")}, ${connection.quote("value")}) ` +
      `VALUES (${connection.placeholder(0)}, ${connection.placeholder(1)})`,
    ["environment", environment],
  );
}

export interface EnvironmentCheckOptions {
  /** What the process thinks it is. */
  environment: string;
  /** The task being attempted, for the message. */
  task: string;
  /** The deliberate override. Rails reads DISABLE_DATABASE_ENVIRONMENT_CHECK. */
  override?: boolean;
}

/**
 * Refuses a destructive task against a protected database. Rails'
 * `check_protected_environments!`.
 *
 * Both the process's environment and the database's stored one are checked,
 * and either being protected is enough. That asymmetry is deliberate: a
 * development process pointed at the production database is the case that
 * loses data, and it is invisible to a check that trusts the process alone.
 */
export async function checkProtectedEnvironments(
  connection: Connection,
  options: EnvironmentCheckOptions,
): Promise<void> {
  if (options.override) return;

  if (isProtectedEnvironment(options.environment)) {
    throw new ProtectedEnvironmentError(options.environment, options.task);
  }

  const stored = await storedEnvironment(connection).catch(() => undefined);

  if (stored !== undefined && isProtectedEnvironment(stored)) {
    throw new ProtectedEnvironmentError(stored, options.task);
  }
}

/**
 * Whether the database's environment and the process's agree. Rails'
 * `check_current_protected_environment`.
 *
 * A mismatch is worth reporting even when neither side is protected: a test
 * suite pointed at the development database will pass and then wipe it, and
 * the only warning anybody gets is this one.
 */
export async function currentEnvironmentMatches(
  connection: Connection,
  environment: string,
): Promise<boolean> {
  const stored = await storedEnvironment(connection).catch(() => undefined);

  return stored === undefined || stored === environment;
}
