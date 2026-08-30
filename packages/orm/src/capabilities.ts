/**
 * What each database can actually do.
 *
 * Rails asks its adapter these questions by name — `supports_check_constraints?`,
 * `supports_deferrable_constraints?` — rather than asking which database it is,
 * and the difference matters once there is more than one caller. A migration
 * that guards a CHECK constraint with `adapter === "postgres"` is wrong the
 * moment MySQL 8 grows them, and nothing about the check says what it was
 * really asking. The named question survives the answer changing.
 *
 * The table is deliberately one place rather than a predicate each. Support is
 * a property of the database, and a single table is what makes it possible to
 * read down a column and see what one adapter can do, or across a row and see
 * who is the odd one out.
 *
 * Versions are the honest caveat. These answers are for the versions this
 * project targets — PostgreSQL 13+, MySQL 8.0.16+, SQLite 3.35+ — and a few
 * are false for older servers that would otherwise qualify. Where Rails asks
 * the live server, this answers from the table; that is a real difference, and
 * `databaseVersion` is here so a caller that needs the sharper answer can get
 * it.
 */

import type { Adapter } from "./connection.js";

/** Every adapter there is, so callers can fold across all three. */
export const ADAPTERS = ["postgres", "mysql", "sqlite"] as const satisfies readonly Adapter[];

export interface Capabilities {
  /** INSERT and UPDATE can hand the affected row straight back. */
  returning: boolean;
  /** UPDATE ... RETURNING specifically, which SQLite gained later than INSERT. */
  updateReturning: boolean;
  /** Nested transactions via SAVEPOINT. */
  savepoints: boolean;
  /** DDL can be rolled back, so a failed migration leaves nothing behind. */
  ddlTransactions: boolean;
  /** SET TRANSACTION ISOLATION LEVEL. */
  transactionIsolation: boolean;
  /** Advisory locks, for coordinating migrations across processes. */
  advisoryLocks: boolean;
  /** CHECK constraints as named, droppable objects. */
  checkConstraints: boolean;
  /** UNIQUE as a named constraint rather than only a unique index. */
  uniqueConstraints: boolean;
  /** EXCLUDE constraints. */
  exclusionConstraints: boolean;
  /** DEFERRABLE INITIALLY DEFERRED on a constraint. */
  deferrableConstraints: boolean;
  /** Foreign keys that are enforced. */
  foreignKeys: boolean;
  /** VALIDATE CONSTRAINT, for adding a foreign key without a full-table lock. */
  validateConstraints: boolean;
  /** Partial indexes — CREATE INDEX ... WHERE. */
  partialIndex: boolean;
  /** Indexes on an expression rather than a bare column. */
  expressionIndex: boolean;
  /** ASC and DESC per column within one index. */
  indexSortOrder: boolean;
  /** INCLUDE columns on an index. */
  indexInclude: boolean;
  /** Indexes declared inside CREATE TABLE. */
  indexesInCreate: boolean;
  /** NULLS NOT DISTINCT on a unique index. */
  nullsNotDistinct: boolean;
  /** Views. */
  views: boolean;
  /** Materialized views. */
  materializedViews: boolean;
  /** COMMENT ON, for documenting tables and columns in the schema itself. */
  comments: boolean;
  /** Comments written inline in CREATE TABLE rather than as separate statements. */
  commentsInCreate: boolean;
  /** WITH ... AS common table expressions. */
  commonTableExpressions: boolean;
  /** A native JSON column type. */
  json: boolean;
  /** Generated / computed columns. */
  virtualColumns: boolean;
  /** Identity columns — GENERATED ... AS IDENTITY. */
  identityColumns: boolean;
  /** ON CONFLICT / ON DUPLICATE KEY, in any spelling. */
  insertOnConflict: boolean;
  /** A conflict target — ON CONFLICT (column) — rather than "any conflict". */
  insertConflictTarget: boolean;
  /** Several ALTER TABLE changes in one statement. */
  bulkAlter: boolean;
  /** Query planner hints. */
  optimizerHints: boolean;
  /** Server extensions, as PostgreSQL means the word. */
  extensions: boolean;
  /** Foreign tables. */
  foreignTables: boolean;
  /** Native table partitioning. */
  nativePartitioning: boolean;
  /** Sub-second precision on datetime columns. */
  datetimeWithPrecision: boolean;
  /** EXPLAIN. */
  explain: boolean;
}

/**
 * SQLite's answers are the ones most worth reading twice.
 *
 * It has more than its reputation suggests — RETURNING since 3.35, partial and
 * expression indexes, generated columns, CTEs, real DDL transactions — and
 * less where it counts for a migration: no advisory locks, so nothing
 * coordinates two processes migrating at once, and ALTER TABLE is narrow
 * enough that changing a column means rebuilding the table.
 */
const TABLE: Record<Adapter, Capabilities> = {
  postgres: {
    returning: true,
    updateReturning: true,
    savepoints: true,
    ddlTransactions: true,
    transactionIsolation: true,
    advisoryLocks: true,
    checkConstraints: true,
    uniqueConstraints: true,
    exclusionConstraints: true,
    deferrableConstraints: true,
    foreignKeys: true,
    validateConstraints: true,
    partialIndex: true,
    expressionIndex: true,
    indexSortOrder: true,
    indexInclude: true,
    indexesInCreate: false,
    nullsNotDistinct: true,
    views: true,
    materializedViews: true,
    comments: true,
    commentsInCreate: false,
    commonTableExpressions: true,
    json: true,
    virtualColumns: true,
    identityColumns: true,
    insertOnConflict: true,
    insertConflictTarget: true,
    bulkAlter: true,
    optimizerHints: false,
    extensions: true,
    foreignTables: true,
    nativePartitioning: true,
    datetimeWithPrecision: true,
    explain: true,
  },
  mysql: {
    returning: false,
    updateReturning: false,
    savepoints: true,
    ddlTransactions: false,
    transactionIsolation: true,
    advisoryLocks: true,
    checkConstraints: true,
    uniqueConstraints: false,
    exclusionConstraints: false,
    deferrableConstraints: false,
    foreignKeys: true,
    validateConstraints: false,
    partialIndex: false,
    expressionIndex: true,
    indexSortOrder: true,
    indexInclude: false,
    indexesInCreate: true,
    nullsNotDistinct: false,
    views: true,
    materializedViews: false,
    comments: true,
    commentsInCreate: true,
    commonTableExpressions: true,
    json: true,
    virtualColumns: true,
    identityColumns: false,
    insertOnConflict: true,
    insertConflictTarget: false,
    bulkAlter: true,
    optimizerHints: true,
    extensions: false,
    foreignTables: false,
    nativePartitioning: true,
    datetimeWithPrecision: true,
    explain: true,
  },
  sqlite: {
    returning: true,
    updateReturning: true,
    savepoints: true,
    ddlTransactions: true,
    transactionIsolation: false,
    advisoryLocks: false,
    checkConstraints: true,
    uniqueConstraints: true,
    exclusionConstraints: false,
    deferrableConstraints: true,
    foreignKeys: true,
    validateConstraints: false,
    partialIndex: true,
    expressionIndex: true,
    indexSortOrder: true,
    indexInclude: false,
    indexesInCreate: false,
    nullsNotDistinct: false,
    views: true,
    materializedViews: false,
    comments: false,
    commentsInCreate: false,
    commonTableExpressions: true,
    json: true,
    virtualColumns: true,
    identityColumns: false,
    insertOnConflict: true,
    insertConflictTarget: true,
    bulkAlter: false,
    optimizerHints: false,
    extensions: false,
    foreignTables: false,
    nativePartitioning: false,
    datetimeWithPrecision: true,
    explain: true,
  },
};

/** What this adapter can do. */
export function capabilitiesFor(adapter: Adapter): Capabilities {
  return TABLE[adapter];
}

/**
 * The longest identifier each server will accept.
 *
 * A generated index name is the usual way to find the limit: `index_` plus a
 * table plus three column names passes 63 without much trying, and PostgreSQL
 * does not error — it truncates, silently, and then two different indexes
 * collide under one name.
 */
const IDENTIFIER_LENGTHS: Record<Adapter, number> = {
  postgres: 63,
  mysql: 64,
  sqlite: 2_000,
};

export function maxIdentifierLength(adapter: Adapter): number {
  return IDENTIFIER_LENGTHS[adapter];
}

/**
 * The column types each adapter spells differently.
 *
 * Only the ones that actually diverge are here. Anything the three agree on —
 * `integer`, `text`, `date` — needs no table, and putting it in one would
 * invite the belief that the table is exhaustive.
 */
const NATIVE_TYPES: Record<Adapter, Record<string, string>> = {
  postgres: {
    primaryKey: "bigserial primary key",
    string: "character varying",
    binary: "bytea",
    boolean: "boolean",
    datetime: "timestamp",
    json: "jsonb",
    uuid: "uuid",
  },
  mysql: {
    primaryKey: "bigint auto_increment primary key",
    string: "varchar(255)",
    binary: "blob",
    boolean: "tinyint(1)",
    datetime: "datetime",
    json: "json",
    uuid: "char(36)",
  },
  sqlite: {
    primaryKey: "integer primary key autoincrement",
    string: "varchar",
    binary: "blob",
    boolean: "boolean",
    datetime: "datetime",
    json: "json",
    uuid: "varchar(36)",
  },
};

export function nativeDatabaseTypes(adapter: Adapter): Record<string, string> {
  return NATIVE_TYPES[adapter];
}
