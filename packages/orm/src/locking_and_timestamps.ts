/**
 * Optimistic locking, timestamp columns, and what a record shows when it is
 * printed — ported from `ActiveRecord::Locking::Optimistic`,
 * `Locking::Pessimistic`, `Timestamp` and `Core#inspect`.
 *
 * Three features that look unrelated and share one property: each is a place
 * where the obvious implementation is silently wrong.
 *
 * **Optimistic locking** is a version column and a `WHERE version = ?` on every
 * update. The subtlety is not the mechanism, it is the exceptions:
 *
 * - `touch` must not bump the version. A touch is a timestamp update, and
 *   bumping the version on one makes every concurrent editor's save fail for a
 *   reason unrelated to what they changed — the classic case being a counter
 *   cache touching a parent while somebody edits it.
 * - A zero rows updated means somebody else got there first, not that the
 *   record is gone. Reporting it as "not found" sends the reader looking for a
 *   deletion that never happened.
 *
 * **Timestamps** are two columns written at different moments, and the
 * *creation* one has to be written on create only. Rails keeps separate lists
 * rather than one, because `updated_at` on create and `created_at` on update
 * are both wrong in ways nothing complains about: the first is harmless, the
 * second rewrites history.
 *
 * **`inspect`** is where a password digest or an API token ends up in a log,
 * an exception tracker, and a screenshot, because printing a record is the
 * most casual thing anybody does with one.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { StaleObjectError } from "./model.js";
import type { LockMode } from "./relation.js";

// --- optimistic locking ---------------------------------------------------------

/** Rails' `locking_column` default. */
export const DEFAULT_LOCKING_COLUMN = "lock_version";

let lockingColumn = DEFAULT_LOCKING_COLUMN;

export function setLockingColumn(name: string): void {
  lockingColumn = name;
}

/** Rails' `reset_locking_column`. */
export function resetLockingColumn(): string {
  lockingColumn = DEFAULT_LOCKING_COLUMN;

  return lockingColumn;
}

export function currentLockingColumn(): string {
  return lockingColumn;
}

/**
 * The `WHERE` an optimistically locked update carries.
 *
 * The version the record was *loaded* with, not the one it now holds. Using
 * the current value would match the row the update is about to write and lock
 * nothing at all — a lock that always succeeds is worse than none, because it
 * looks like one.
 */
export function lockingCondition(
  loadedVersion: number,
  column = currentLockingColumn(),
): Record<string, number> {
  return { [column]: loadedVersion };
}

/**
 * What an optimistically locked update writes for the version.
 *
 * A null in the column is treated as zero. Rails allows the column to be added
 * to an existing table, and every row written before the migration has a null
 * there — treating that as "no version" would exempt exactly the old rows,
 * which are the ones most likely to be edited concurrently.
 */
export function nextLockVersion(current: number | null | undefined): number {
  return (current ?? 0) + 1;
}

/**
 * Rails' `_update_record` result check for a locked update.
 *
 * Zero rows means somebody else saved first. Reported as staleness rather than
 * as a missing record, because the two need opposite responses: reload and
 * retry, versus stop.
 */
export function checkLockedUpdate(
  affectedRows: number,
  modelName: string,
  id: unknown,
  action = "update",
): void {
  if (affectedRows === 0) throw new StaleObjectError(modelName, id, action);
}

/** The process-wide setting, and the block that is overriding it. */
let preserveLockVersion = false;
const preserving = new AsyncLocalStorage<boolean>();

/**
 * Rails' `preserve_lock_version_on_touch`.
 *
 * A touch writes a timestamp and nothing else, so bumping the version on one
 * makes every concurrent editor's save fail for a reason unrelated to what
 * they changed. The usual way this happens is a counter cache touching a
 * parent while somebody has that parent's form open.
 */
export function preserveLockVersionOnTouch(): boolean {
  return preserving.getStore() ?? preserveLockVersion;
}

export function setPreserveLockVersionOnTouch(preserve: boolean): void {
  preserveLockVersion = preserve;
}

/**
 * Runs a body with the version preserved across touches.
 *
 * Scoped rather than saved and restored. Holding it in a module-level variable
 * made one caller's block the setting for every request running beside it —
 * and what it turns off is conflict detection, so a concurrent save that
 * should have failed as stale would have succeeded and overwritten somebody's
 * edit. Leaving the scope also restores what surrounded it, so nesting works
 * and a body that throws leaves nothing behind.
 */
export async function preservingLockVersionOnTouch<T>(body: () => Promise<T> | T): Promise<T> {
  return await preserving.run(true, async () => await body());
}

// --- pessimistic locking -----------------------------------------------------------

export interface LockOptions {
  mode?: LockMode;
  /** Fail immediately rather than queueing. */
  noWait?: boolean;
  /** Skip rows somebody else has, rather than waiting for them. */
  skipLocked?: boolean;
  /** Seconds to wait before giving up. */
  wait?: number;
}

/**
 * Rails' `lock_options` — the clause a `lock` adds.
 *
 * `noWait` and `skipLocked` are mutually exclusive, and the combination is
 * refused rather than resolved. They are opposite answers to the same
 * question, and a caller that asked for both has a bug that would otherwise be
 * decided by whichever check ran first.
 */
export function lockOptions({ mode = "update", noWait, skipLocked }: LockOptions = {}): string {
  if (noWait === true && skipLocked === true) {
    throw new Error(
      "A lock cannot both refuse to wait and skip locked rows: NOWAIT fails when a row is taken " +
        "and SKIP LOCKED silently omits it. They are opposite answers to the same question.",
    );
  }

  const clause = mode === "update" ? "FOR UPDATE" : `FOR ${mode.toUpperCase()}`;

  if (noWait === true) return `${clause} NOWAIT`;
  if (skipLocked === true) return `${clause} SKIP LOCKED`;

  return clause;
}

/**
 * Rails' `lock_wait` — how long to queue for a row somebody else holds.
 *
 * Bounded by default. An unbounded wait is how one long transaction becomes
 * every request queueing behind it, and the symptom is a service that stops
 * responding without anything appearing in a log.
 */
export function lockWait(seconds: number | undefined, fallback = 5): number {
  if (seconds === undefined) return fallback;

  if (seconds <= 0) {
    throw new Error(
      `A lock wait of ${seconds} means no wait at all, which is NOWAIT — say that instead, so a ` +
        `reader can tell a deliberate no-wait from a timeout somebody forgot to set.`,
    );
  }

  return seconds;
}

/** The statement that sets it for the current session. */
export function lockThread(seconds: number, adapter = "postgres"): string {
  return adapter === "mysql"
    ? `SET innodb_lock_wait_timeout = ${Math.ceil(seconds)}`
    : `SET LOCAL lock_timeout = '${Math.ceil(seconds * 1000)}ms'`;
}

// --- timestamps ---------------------------------------------------------------------

export const CREATE_TIMESTAMPS: readonly string[] = ["created_at", "created_on"];
export const UPDATE_TIMESTAMPS: readonly string[] = ["updated_at", "updated_on"];

/**
 * Rails' `timestamp_attributes_for_create_in_model` — the ones the table has.
 *
 * Filtered against the real columns rather than assumed. Writing to a column
 * that is not there is an error on every adapter, and a model without
 * timestamps is entirely ordinary.
 */
export function timestampAttributesForCreateInModel(columns: readonly string[]): string[] {
  return CREATE_TIMESTAMPS.filter((name) => columns.includes(name));
}

/** Rails' `timestamp_attributes_for_update_in_model`. */
export function timestampAttributesForUpdateInModel(columns: readonly string[]): string[] {
  return UPDATE_TIMESTAMPS.filter((name) => columns.includes(name));
}

/** Rails' `all_timestamp_attributes_in_model`. */
export function allTimestampAttributesInModel(columns: readonly string[]): string[] {
  return [
    ...timestampAttributesForCreateInModel(columns),
    ...timestampAttributesForUpdateInModel(columns),
  ];
}

/** Rails' `timestamp_column_names` — both lists, whether the table has them or not. */
export function timestampColumnNames(): string[] {
  return [...CREATE_TIMESTAMPS, ...UPDATE_TIMESTAMPS];
}

/**
 * What a create writes. Rails' `_create_record` timestamp step.
 *
 * One value for every column, not `now()` per column. Two columns written from
 * two clock reads can differ by a millisecond, and a record whose `created_at`
 * is after its `updated_at` breaks every "changed since creation" check ever
 * written against it.
 */
export function createTimestamps(columns: readonly string[], at: Date): Record<string, Date> {
  return Object.fromEntries(allTimestampAttributesInModel(columns).map((name) => [name, at]));
}

/**
 * What an update writes.
 *
 * The update columns only. `created_at` rewritten on update is not a harmless
 * inaccuracy — it destroys the one fact nothing else records.
 */
export function updateTimestamps(columns: readonly string[], at: Date): Record<string, Date> {
  return Object.fromEntries(timestampAttributesForUpdateInModel(columns).map((name) => [name, at]));
}

// --- what a record shows -----------------------------------------------------------

const DEFAULT_FILTERED = ["password", "password_digest", "token", "secret", "api_key", "ssn"];

let filtered: string[] = [...DEFAULT_FILTERED];

/**
 * Rails' `filter_attributes` — the attributes `inspect` will not print.
 *
 * Matched as a substring, so `password_confirmation` and `reset_password_token`
 * are covered without naming each. An allowlist would be safer in principle
 * and useless in practice: nobody maintains one, and an unmaintained allowlist
 * hides the attributes people actually want to see while leaking the new one
 * somebody just added.
 */
export function filterAttributes(names?: readonly string[]): string[] {
  if (names !== undefined) filtered = [...names];

  return [...filtered];
}

export function resetFilterAttributes(): void {
  filtered = [...DEFAULT_FILTERED];
}

/** Rails' `inspection_filter` — whether one attribute is hidden. */
export function inspectionFilter(name: string, patterns: readonly string[] = filtered): boolean {
  const lower = name.toLowerCase();

  return patterns.some((pattern) => lower.includes(pattern.toLowerCase()));
}

/**
 * Rails' `inspect_with_attributes`.
 *
 * Filtered values are replaced rather than omitted, so a reader can see that
 * the attribute exists and was withheld. An omitted attribute reads as one the
 * record does not have, which sends somebody looking for a migration.
 */
export function inspectWithAttributes(
  modelName: string,
  attributes: Record<string, unknown>,
  limit = 10,
): string {
  const names = Object.keys(attributes);
  const shown = names.slice(0, limit);

  const parts = shown.map((name) => {
    const value = inspectionFilter(name) ? "[FILTERED]" : showValue(attributes[name]);

    return `${name}: ${value}`;
  });

  // Said out loud rather than trailing off: a truncated inspect that does not
  // say it was truncated is read as the whole record, and the attribute
  // somebody is looking for is assumed missing.
  if (names.length > shown.length) {
    parts.push(`... ${names.length - shown.length} more`);
  }

  return `#<${modelName} ${parts.join(", ")}>`;
}

function showValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value instanceof Date) return value.toISOString();

  return String(value);
}

const sensitiveDeclarations = new Set<string>();

/**
 * Rails' `on_sensitive_attribute_declared` — a hook for `encrypts` and friends.
 *
 * Fired at declaration rather than at first use, so a model that declares an
 * encrypted attribute gets it added to the filter list at load time. Adding it
 * on first read would mean the first `inspect` of the process prints it.
 */
export function onSensitiveAttributeDeclared(modelName: string, attribute: string): void {
  sensitiveDeclarations.add(`${modelName}#${attribute}`);

  if (!inspectionFilter(attribute)) filtered = [...filtered, attribute];
}

/** Rails' `sensitive_attribute_was_declared?`. */
export function sensitiveAttributeWasDeclared(modelName: string, attribute: string): boolean {
  return sensitiveDeclarations.has(`${modelName}#${attribute}`);
}

export function resetSensitiveAttributes(): void {
  sensitiveDeclarations.clear();
}

/**
 * Rails' `readonly_attribute?`.
 *
 * A readonly attribute is dropped from an update rather than raising. Raising
 * would make every `save` on a record with one fail, including saves that did
 * not touch it — and the attribute is usually one the database maintains.
 */
export function readonlyAttribute(name: string, readonlyNames: readonly string[]): boolean {
  return readonlyNames.includes(name);
}

/** The changes an update actually sends. */
export function extractAttributes(
  changes: Record<string, unknown>,
  readonlyNames: readonly string[] = [],
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(changes).filter(([name]) => !readonlyAttribute(name, readonlyNames)),
  );
}

/**
 * Rails' `initialize_attributes` — defaults for a record that is not from a row.
 *
 * Columns with no default get `null` rather than being absent. An absent
 * attribute and one that is explicitly null read the same on the way out and
 * differently on the way in: the first is omitted from the insert, so the
 * database default applies, and a model that set the value to null explicitly
 * would find the default there instead.
 */
export function initializeAttributes(
  columns: readonly { name: string; default?: unknown }[],
): Record<string, unknown> {
  return Object.fromEntries(columns.map((column) => [column.name, column.default ?? null]));
}
