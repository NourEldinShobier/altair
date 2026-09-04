/**
 * Turning a driver's error into one the application can act on, ported from
 * `ActiveRecord::ConnectionAdapters`' `translate_exception` and the error
 * constructors in `activerecord/lib/active_record/errors.rb`.
 *
 * Every driver reports the same failure differently: PostgreSQL sets a
 * five-character SQLSTATE on a diagnostic field of the result, MySQL sets a
 * number, SQLite puts English in the message. An application that wants to say
 * "that email is taken" cannot read any of them without knowing which database
 * it is talking to — and the moment it matches on the message text it is one
 * server upgrade away from a 500.
 *
 * So the translation happens once, here, and what reaches the application is a
 * class. `catch (e) { if (e instanceof RecordNotUnique) ... }` is the same code
 * on all three.
 *
 * The distinctions the classes draw are the ones that change what a caller
 * should do:
 *
 * - **A constraint violation** is the caller's fault and retrying is pointless.
 * - **A deadlock or a serialization failure** is nobody's fault and retrying is
 *   the *correct* response — the transaction was rolled back by the server
 *   precisely so it could be run again.
 * - **A lock timeout or a cancelled query** means the work may or may not have
 *   happened, so retrying is only safe if the statement was idempotent.
 * - **A connection failure** means the statement may have run and the answer
 *   was lost. Retrying a write here is how you get two charges on one card.
 *
 * Collapsing those into one `DatabaseError` is why so much application code
 * retries the things it should report and reports the things it should retry.
 */

/**
 * The SQLSTATE codes we act on. From the PostgreSQL adapter's constants.
 *
 * SQLSTATE is standardised, so these are not PostgreSQL-specific in principle;
 * they are here because PostgreSQL is the adapter that reports them reliably.
 */
export const SQLSTATE = {
  valueLimitViolation: "22001",
  numericValueOutOfRange: "22003",
  notNullViolation: "23502",
  foreignKeyViolation: "23503",
  uniqueViolation: "23505",
  checkViolation: "23514",
  exclusionViolation: "23P01",
  serializationFailure: "40001",
  deadlockDetected: "40P01",
  duplicateDatabase: "42P04",
  undefinedDatabase: "3D000",
  invalidPassword: "28P01",
  lockNotAvailable: "55P03",
  queryCanceled: "57014",
} as const;

/**
 * The MySQL error numbers we act on. From the abstract MySQL adapter.
 *
 * Numbers rather than SQLSTATE because MySQL's SQLSTATE is much coarser — it
 * reports `23000` for a unique violation *and* a foreign key violation, which
 * are the two cases most worth telling apart.
 */
export const MYSQL_ERROR = {
  databaseCreateExists: 1007,
  lockWaitTimeout: 1205,
  duplicateEntry: 1062,
  notNullViolation: 1048,
  noReferencedRow: 1216,
  noReferencedRow2: 1452,
  rowIsReferenced: 1217,
  rowIsReferenced2: 1451,
  dataTooLong: 1406,
  outOfRange: 1264,
  lockDeadlock: 1213,
  queryInterrupted: 1317,
  queryTimeout: 3024,
  badDbError: 1049,
  accessDenied: 1045,
  serverGone: 2006,
  serverLost: 2013,
} as const;

/** libpq diagnostic field codes, as `PG::PG_DIAG_*`. */
export const PG_DIAG = {
  severity: "S",
  sqlstate: "C",
  messagePrimary: "M",
  tableName: "t",
  columnName: "c",
  constraintName: "n",
} as const;

/** What is left of a failed statement: the driver's own error result. */
export interface DriverResult {
  fields?: Record<string, string | undefined>;
}

export interface StatementContext {
  message?: string;
  sql?: string;
  binds?: readonly unknown[];
  /** The driver's own error, kept so the original backtrace is not lost. */
  cause?: unknown;
}

/**
 * The base of everything a statement can fail with. Rails' `StatementInvalid`.
 *
 * Carries the SQL and the binds because the message alone rarely identifies
 * which of a request's twenty queries blew up, and reproducing it from a log
 * line is the slowest part of fixing it.
 */
export class StatementInvalid extends Error {
  readonly sql: string | undefined;
  readonly binds: readonly unknown[] | undefined;

  constructor(message = "Invalid statement", context: StatementContext = {}) {
    super(message, { cause: context.cause });
    this.name = new.target.name;
    this.sql = context.sql;
    this.binds = context.binds;
  }
}

/** A unique index rejected the row. Rails' `RecordNotUnique`. */
export class RecordNotUnique extends StatementInvalid {}

/** A foreign key had nothing to point at, or something still pointed at this. */
export class InvalidForeignKey extends StatementInvalid {}

/** A `NOT NULL` column was given nothing. Rails' `NotNullViolation`. */
export class NotNullViolation extends StatementInvalid {}

/** A `CHECK` constraint said no. Rails' `CheckViolation`. */
export class CheckViolation extends StatementInvalid {}

/** An exclusion constraint said no. Rails' `ExclusionViolation`. */
export class ExclusionViolation extends StatementInvalid {}

/** The value was longer than the column. Rails' `ValueTooLong`. */
export class ValueTooLong extends StatementInvalid {}

/**
 * The number was outside what the column can hold. Rails' `RangeError`.
 *
 * Named `OutOfRange` rather than `RangeError`, which is a global in JavaScript:
 * shadowing it would mean a `catch` for one silently answering for the other.
 */
export class OutOfRange extends StatementInvalid {}

/** The database already existed. Rails' `DatabaseAlreadyExists`. */
export class DatabaseAlreadyExists extends StatementInvalid {}

/**
 * The base of the failures that are worth retrying. Rails'
 * `TransactionRollbackError`.
 *
 * A class of its own so a retry policy can be written as one `instanceof`
 * rather than a list that has to be kept in step with this file.
 */
export class TransactionRollbackError extends StatementInvalid {}

/** Two transactions waited on each other and the server picked one to kill. */
export class Deadlocked extends TransactionRollbackError {}

/** A serializable transaction saw a state that could not have happened serially. */
export class SerializationFailure extends TransactionRollbackError {}

/**
 * The base of the failures where the statement stopped part-way. Rails'
 * `QueryAborted`.
 *
 * Distinct from a rollback error because the work may have been done: retrying
 * is safe only for a statement that was idempotent to begin with.
 */
export class QueryAborted extends StatementInvalid {}

/** We waited for a lock and gave up. Rails' `LockWaitTimeout`. */
export class LockWaitTimeout extends QueryAborted {}

/** Somebody or something cancelled the query. Rails' `QueryCanceled`. */
export class QueryCanceled extends QueryAborted {}

/** The connection died with the statement in flight. Rails' `ConnectionFailed`. */
export class ConnectionFailed extends QueryAborted {}

/**
 * There is no database to talk to. Rails' `NoDatabaseError`.
 *
 * The message names the fix rather than the fault, because the overwhelmingly
 * common cause is a checkout that has never had `db:create` run in it, and the
 * person reading it is usually new to the project.
 */
export class NoDatabaseError extends StatementInvalid {
  constructor(message = "Database not found", context: StatementContext = {}) {
    super(message, context);
  }

  /** Rails' `NoDatabaseError.db_error`. */
  static dbError(dbName: string): NoDatabaseError {
    return new NoDatabaseError(
      `Database not found: ${dbName}. Available database configurations can be found in ` +
        `config/database.yml.\n\nTo resolve this error:\n\n` +
        `- Create the database by running:\n\n    bin/rails db:create\n\n` +
        `- Verify that config/database.yml contains the correct database name.`,
    );
  }
}

/**
 * We never got as far as a statement. Rails' `ConnectionNotEstablished`.
 *
 * Not a `StatementInvalid`: nothing was sent, so there is no SQL to report and
 * — the part that matters — no chance the write half-happened.
 */
export class ConnectionNotEstablished extends Error {
  constructor(message = "No connection", options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * The host was wrong, or the credentials were. Rails'
 * `DatabaseConnectionError`.
 *
 * Two constructors rather than one, because the two failures look identical in
 * a log — "could not connect" — and have nothing in common as fixes. Telling
 * someone their hostname is wrong when their password is wrong sends them to
 * the wrong file.
 */
export class DatabaseConnectionError extends ConnectionNotEstablished {
  constructor(message = "Database connection error", options?: ErrorOptions) {
    super(message, options);
  }

  /** Rails' `DatabaseConnectionError.hostname_error`. */
  static hostnameError(hostname: string): DatabaseConnectionError {
    return new DatabaseConnectionError(
      `There is an issue connecting with your hostname: ${hostname}.\n` +
        `Please check your database configuration and ensure there is a valid connection to ` +
        `your database.`,
    );
  }

  /** Rails' `DatabaseConnectionError.username_error`. */
  static usernameError(username: string): DatabaseConnectionError {
    return new DatabaseConnectionError(
      `There is an issue connecting to your database with your username/password, username: ` +
        `${username}.\nPlease check your database configuration to ensure the username/password ` +
        `are valid.`,
    );
  }
}

/**
 * The MySQL error number, whatever the driver calls it. Rails' `error_number`.
 *
 * Three drivers, three names: `mysql2` sets `errno`, `trilogy` sets
 * `error_code`, and some wrappers pass through `errorNumber`. `code` is read
 * last and only when it is a number, because PostgreSQL drivers put the
 * SQLSTATE *string* there and reading it as a number would answer `NaN` for
 * every PostgreSQL error.
 *
 * Undefined rather than zero when there is no number: zero is a value MySQL
 * could in principle report, and a caller comparing against a constant would
 * silently match it.
 */
export function errorNumber(exception: unknown): number | undefined {
  if (typeof exception !== "object" || exception === null) return undefined;

  const source = exception as Record<string, unknown>;

  for (const key of ["errno", "errorNumber", "error_code", "code"]) {
    const value = source[key];

    if (typeof value === "number") return value;
  }

  return undefined;
}

/**
 * One diagnostic field off a failed PostgreSQL result. Rails' `error_field`.
 *
 * The fields are where the useful detail is — which constraint, which column,
 * which table — and they are structured, unlike the message, which is
 * localised and reworded between server versions.
 */
export function errorField(result: DriverResult | undefined, field: string): string | undefined {
  return result?.fields?.[field];
}

/**
 * Whether the server is telling us the connection itself is going away.
 *
 * `FATAL` and `PANIC` are not statement failures however they are reported:
 * the backend is exiting, so the next statement on this connection will fail
 * too, and treating it as a statement error means retrying on a socket that is
 * already closed.
 */
export function connectionTerminatingSeverity(result: DriverResult | undefined): boolean {
  const severity = errorField(result, PG_DIAG.severity);

  return severity === "FATAL" || severity === "PANIC";
}

const BY_SQLSTATE = new Map<string, typeof StatementInvalid>([
  [SQLSTATE.uniqueViolation, RecordNotUnique],
  [SQLSTATE.foreignKeyViolation, InvalidForeignKey],
  [SQLSTATE.checkViolation, CheckViolation],
  [SQLSTATE.exclusionViolation, ExclusionViolation],
  [SQLSTATE.valueLimitViolation, ValueTooLong],
  [SQLSTATE.numericValueOutOfRange, OutOfRange],
  [SQLSTATE.notNullViolation, NotNullViolation],
  [SQLSTATE.serializationFailure, SerializationFailure],
  [SQLSTATE.deadlockDetected, Deadlocked],
  [SQLSTATE.duplicateDatabase, DatabaseAlreadyExists],
  [SQLSTATE.undefinedDatabase, NoDatabaseError],
  [SQLSTATE.lockNotAvailable, LockWaitTimeout],
  [SQLSTATE.queryCanceled, QueryCanceled],
]);

const BY_ERROR_NUMBER = new Map<number, typeof StatementInvalid>([
  [MYSQL_ERROR.duplicateEntry, RecordNotUnique],
  [MYSQL_ERROR.noReferencedRow, InvalidForeignKey],
  [MYSQL_ERROR.noReferencedRow2, InvalidForeignKey],
  [MYSQL_ERROR.rowIsReferenced, InvalidForeignKey],
  [MYSQL_ERROR.rowIsReferenced2, InvalidForeignKey],
  [MYSQL_ERROR.notNullViolation, NotNullViolation],
  [MYSQL_ERROR.dataTooLong, ValueTooLong],
  [MYSQL_ERROR.outOfRange, OutOfRange],
  [MYSQL_ERROR.lockDeadlock, Deadlocked],
  [MYSQL_ERROR.lockWaitTimeout, LockWaitTimeout],
  [MYSQL_ERROR.queryTimeout, LockWaitTimeout],
  [MYSQL_ERROR.queryInterrupted, QueryCanceled],
  [MYSQL_ERROR.databaseCreateExists, DatabaseAlreadyExists],
  [MYSQL_ERROR.badDbError, NoDatabaseError],
  [MYSQL_ERROR.serverGone, ConnectionFailed],
  [MYSQL_ERROR.serverLost, ConnectionFailed],
]);

/**
 * The driver's error as one of ours. Rails' `translate_exception`.
 *
 * The SQLSTATE is tried first and the error number second, rather than
 * branching on which adapter we are: a driver that reports both is translated
 * the same way either path, and the caller does not have to pass a flag saying
 * which database this was.
 *
 * An error we do not recognise comes back as a plain `StatementInvalid` with
 * the driver's message intact, not as something more specific guessed from the
 * text. A wrong class is worse than a vague one — it is the difference between
 * a caller retrying and a caller reporting.
 */
export function translateStatementError(
  exception: unknown,
  context: StatementContext = {},
): StatementInvalid {
  const error = exception instanceof Error ? exception : undefined;
  const message = context.message ?? error?.message ?? "Invalid statement";
  const result = (exception as { result?: DriverResult } | null)?.result;

  const state = errorField(result, PG_DIAG.sqlstate) ?? sqlStateOf(exception);
  const number = errorNumber(exception);

  const Translated =
    (state === undefined ? undefined : BY_SQLSTATE.get(state)) ??
    (number === undefined ? undefined : BY_ERROR_NUMBER.get(number)) ??
    (connectionTerminatingSeverity(result) ? ConnectionFailed : StatementInvalid);

  return new Translated(message, { ...context, cause: context.cause ?? error });
}

/**
 * The SQLSTATE a PostgreSQL driver puts on the error itself.
 *
 * `node-postgres` sets it as `code`, a string — which is why `errorNumber`
 * only reads `code` when it is a number, and why this only reads it when it is
 * a string. Sharing one field for two meanings is the driver's choice, not
 * ours, but a translation that got it backwards would answer `RecordNotUnique`
 * for MySQL error 23505, which does not exist.
 */
function sqlStateOf(exception: unknown): string | undefined {
  if (typeof exception !== "object" || exception === null) return undefined;

  const code = (exception as { code?: unknown }).code;

  return typeof code === "string" ? code : undefined;
}
