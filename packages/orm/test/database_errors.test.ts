/**
 * Turning a driver's error into one the application can act on, ported from
 * the `translate_exception` cases in
 * `activerecord/test/cases/adapters/postgresql/postgresql_adapter_test.rb`,
 * `activerecord/test/cases/adapter_test.rb` and
 * `activerecord/test/cases/errors_test.rb`.
 *
 * Every case here is a distinction that changes what the caller should do:
 * report it, retry it, or refuse to retry it because the write may already
 * have landed.
 */

import { describe, expect, it } from "bun:test";
import {
  CheckViolation,
  ConnectionFailed,
  ConnectionNotEstablished,
  DatabaseAlreadyExists,
  DatabaseConnectionError,
  Deadlocked,
  ExclusionViolation,
  InvalidForeignKey,
  LockWaitTimeout,
  MYSQL_ERROR,
  NoDatabaseError,
  NotNullViolation,
  OutOfRange,
  PG_DIAG,
  QueryAborted,
  QueryCanceled,
  RecordNotUnique,
  SQLSTATE,
  SerializationFailure,
  StatementInvalid,
  TransactionRollbackError,
  ValueTooLong,
  connectionTerminatingSeverity,
  errorField,
  errorNumber,
  translateStatementError,
} from "../src/database_errors.js";

/** A `pg` error: the SQLSTATE is on a diagnostic field of the result. */
function pgError(sqlstate: string, fields: Record<string, string> = {}): Error {
  return Object.assign(new Error("PG::Error"), {
    result: { fields: { [PG_DIAG.sqlstate]: sqlstate, ...fields } },
  });
}

/** A `mysql2` error: a number on `errno`, no result at all. */
function mysqlError(errno: number): Error {
  return Object.assign(new Error("Mysql2::Error"), { errno });
}

describe("the driver's error number", () => {
  it("is read from whichever field the driver used", () => {
    expect(errorNumber({ errno: 1062 })).toBe(1062);
    expect(errorNumber({ errorNumber: 1062 })).toBe(1062);
    expect(errorNumber({ error_code: 1062 })).toBe(1062);
  });

  /**
   * PostgreSQL drivers put the SQLSTATE *string* on `code`. Reading it as a
   * number would answer for every PostgreSQL error.
   */
  it("ignores a code that is not a number", () => {
    expect(errorNumber({ code: "23505" })).toBeUndefined();
    expect(errorNumber({ code: 1062 })).toBe(1062);
  });

  /** Zero is a number MySQL could report, so a caller must not match it. */
  it("is nothing when there is no number", () => {
    expect(errorNumber(new Error("boom"))).toBeUndefined();
    expect(errorNumber(undefined)).toBeUndefined();
    expect(errorNumber("boom")).toBeUndefined();
    expect(errorNumber(null)).toBeUndefined();
  });
});

describe("a diagnostic field", () => {
  it("is read off the result", () => {
    const result = { fields: { [PG_DIAG.constraintName]: "index_users_on_email" } };

    expect(errorField(result, PG_DIAG.constraintName)).toBe("index_users_on_email");
    expect(errorField(result, PG_DIAG.columnName)).toBeUndefined();
    expect(errorField(undefined, PG_DIAG.constraintName)).toBeUndefined();
  });

  /**
   * The backend is exiting, so the next statement on this connection fails
   * too — retrying on it means retrying on a socket that is already closed.
   */
  it("says when the connection itself is going away", () => {
    expect(connectionTerminatingSeverity({ fields: { [PG_DIAG.severity]: "FATAL" } })).toBe(true);
    expect(connectionTerminatingSeverity({ fields: { [PG_DIAG.severity]: "PANIC" } })).toBe(true);
    expect(connectionTerminatingSeverity({ fields: { [PG_DIAG.severity]: "ERROR" } })).toBe(false);
    expect(connectionTerminatingSeverity(undefined)).toBe(false);
  });
});

describe("translating a postgresql error", () => {
  const cases: [string, string, new (...args: never[]) => Error][] = [
    ["a unique index rejected the row", SQLSTATE.uniqueViolation, RecordNotUnique],
    ["a foreign key had nothing to point at", SQLSTATE.foreignKeyViolation, InvalidForeignKey],
    ["a check constraint said no", SQLSTATE.checkViolation, CheckViolation],
    ["an exclusion constraint said no", SQLSTATE.exclusionViolation, ExclusionViolation],
    ["a not-null column was given nothing", SQLSTATE.notNullViolation, NotNullViolation],
    ["the value was longer than the column", SQLSTATE.valueLimitViolation, ValueTooLong],
    ["the number did not fit", SQLSTATE.numericValueOutOfRange, OutOfRange],
    ["the server picked a deadlock victim", SQLSTATE.deadlockDetected, Deadlocked],
    ["the transaction could not serialize", SQLSTATE.serializationFailure, SerializationFailure],
    ["we gave up waiting for a lock", SQLSTATE.lockNotAvailable, LockWaitTimeout],
    ["the query was cancelled", SQLSTATE.queryCanceled, QueryCanceled],
    ["the database already existed", SQLSTATE.duplicateDatabase, DatabaseAlreadyExists],
    ["there is no such database", SQLSTATE.undefinedDatabase, NoDatabaseError],
  ];

  for (const [what, sqlstate, expected] of cases) {
    it(what, () => {
      expect(translateStatementError(pgError(sqlstate))).toBeInstanceOf(expected);
    });
  }

  /**
   * A wrong class is worse than a vague one: it is the difference between a
   * caller retrying and a caller reporting.
   */
  it("leaves an unrecognised code as a plain statement failure", () => {
    const translated = translateStatementError(pgError("42601"));

    expect(translated).toBeInstanceOf(StatementInvalid);
    expect(translated).not.toBeInstanceOf(QueryAborted);
    expect(translated).not.toBeInstanceOf(TransactionRollbackError);
  });

  it("is a connection failure when the backend is exiting", () => {
    const translated = translateStatementError(pgError("57P01", { [PG_DIAG.severity]: "FATAL" }));

    expect(translated).toBeInstanceOf(ConnectionFailed);
  });

  /** A known code wins over the severity: the statement failed for a reason. */
  it("prefers the code to the severity", () => {
    const error = pgError(SQLSTATE.uniqueViolation, { [PG_DIAG.severity]: "FATAL" });

    expect(translateStatementError(error)).toBeInstanceOf(RecordNotUnique);
  });

  /** `node-postgres` puts the SQLSTATE on the error itself, not on a result. */
  it("reads a sqlstate off the error when there is no result", () => {
    const error = Object.assign(new Error("duplicate key"), { code: SQLSTATE.uniqueViolation });

    expect(translateStatementError(error)).toBeInstanceOf(RecordNotUnique);
  });
});

describe("translating a mysql error", () => {
  const cases: [string, number, new (...args: never[]) => Error][] = [
    ["a duplicate entry", MYSQL_ERROR.duplicateEntry, RecordNotUnique],
    ["no referenced row", MYSQL_ERROR.noReferencedRow, InvalidForeignKey],
    ["a row is still referenced", MYSQL_ERROR.rowIsReferenced2, InvalidForeignKey],
    ["a not-null column", MYSQL_ERROR.notNullViolation, NotNullViolation],
    ["data too long", MYSQL_ERROR.dataTooLong, ValueTooLong],
    ["out of range", MYSQL_ERROR.outOfRange, OutOfRange],
    ["a deadlock", MYSQL_ERROR.lockDeadlock, Deadlocked],
    ["a lock wait timeout", MYSQL_ERROR.lockWaitTimeout, LockWaitTimeout],
    ["a query timeout", MYSQL_ERROR.queryTimeout, LockWaitTimeout],
    ["an interrupted query", MYSQL_ERROR.queryInterrupted, QueryCanceled],
    ["the database already exists", MYSQL_ERROR.databaseCreateExists, DatabaseAlreadyExists],
    ["no such database", MYSQL_ERROR.badDbError, NoDatabaseError],
    ["the server went away", MYSQL_ERROR.serverGone, ConnectionFailed],
    ["the connection was lost", MYSQL_ERROR.serverLost, ConnectionFailed],
  ];

  for (const [what, errno, expected] of cases) {
    it(what, () => {
      expect(translateStatementError(mysqlError(errno))).toBeInstanceOf(expected);
    });
  }

  it("leaves an unrecognised number as a plain statement failure", () => {
    expect(translateStatementError(mysqlError(1064))).toBeInstanceOf(StatementInvalid);
  });
});

describe("what the translated error carries", () => {
  it("keeps the sql and the binds", () => {
    const translated = translateStatementError(pgError(SQLSTATE.uniqueViolation), {
      sql: "INSERT INTO users (email) VALUES ($1)",
      binds: ["a@example.com"],
    });

    expect(translated.sql).toBe("INSERT INTO users (email) VALUES ($1)");
    expect(translated.binds).toEqual(["a@example.com"]);
  });

  /** So the original backtrace is not lost behind ours. */
  it("keeps the driver's error as the cause", () => {
    const original = pgError(SQLSTATE.uniqueViolation);

    expect(translateStatementError(original).cause).toBe(original);
  });

  it("keeps the driver's message unless given one", () => {
    expect(translateStatementError(pgError(SQLSTATE.checkViolation)).message).toBe("PG::Error");
    expect(
      translateStatementError(pgError(SQLSTATE.checkViolation), { message: "rewritten" }).message,
    ).toBe("rewritten");
  });

  it("survives something that is not an error at all", () => {
    const translated = translateStatementError("boom");

    expect(translated).toBeInstanceOf(StatementInvalid);
    expect(translated.message).toBe("Invalid statement");
  });

  /** So a `catch` can name the class it saw. */
  it("is named after its own class", () => {
    expect(translateStatementError(pgError(SQLSTATE.deadlockDetected)).name).toBe("Deadlocked");
    expect(new StatementInvalid().name).toBe("StatementInvalid");
  });

  /**
   * A retry policy should be one `instanceof`, not a list that has to be kept
   * in step with the translation table.
   */
  it("groups the retryable failures under one class", () => {
    expect(translateStatementError(pgError(SQLSTATE.deadlockDetected))).toBeInstanceOf(
      TransactionRollbackError,
    );
    expect(translateStatementError(pgError(SQLSTATE.serializationFailure))).toBeInstanceOf(
      TransactionRollbackError,
    );
    expect(translateStatementError(pgError(SQLSTATE.uniqueViolation))).not.toBeInstanceOf(
      TransactionRollbackError,
    );
  });

  /** Aborted is not rolled back: the work may have been done. */
  it("keeps the aborted failures apart from the rolled-back ones", () => {
    expect(translateStatementError(pgError(SQLSTATE.queryCanceled))).toBeInstanceOf(QueryAborted);
    expect(translateStatementError(pgError(SQLSTATE.queryCanceled))).not.toBeInstanceOf(
      TransactionRollbackError,
    );
  });
});

describe("the errors raised before a statement exists", () => {
  /** The message names the fix, because the reader is usually new here. */
  it("names the database and the command that creates it", () => {
    const error = NoDatabaseError.dbError("blog_development");

    expect(error).toBeInstanceOf(NoDatabaseError);
    expect(error.message).toContain("blog_development");
    expect(error.message).toContain("bin/rails db:create");
    expect(error.message).toContain("config/database.yml");
  });

  /**
   * A wrong hostname and a wrong password look identical in a log, and
   * telling someone the wrong one sends them to the wrong file.
   */
  it("tells a wrong hostname from a wrong password", () => {
    const host = DatabaseConnectionError.hostnameError("db.internal");
    const user = DatabaseConnectionError.usernameError("blog");

    expect(host.message).toContain("db.internal");
    expect(host.message).toContain("hostname");
    expect(user.message).toContain("blog");
    expect(user.message).toContain("username/password");
    expect(host.message).not.toContain("username/password");
  });

  /**
   * Not a statement failure: nothing was sent, so there is no chance a write
   * half-happened and no reason to refuse a retry.
   */
  it("is not a statement failure", () => {
    const error = DatabaseConnectionError.hostnameError("db.internal");

    expect(error).toBeInstanceOf(ConnectionNotEstablished);
    expect(error).not.toBeInstanceOf(StatementInvalid);
    expect(error.name).toBe("DatabaseConnectionError");
    expect(new ConnectionNotEstablished().name).toBe("ConnectionNotEstablished");
  });
});
