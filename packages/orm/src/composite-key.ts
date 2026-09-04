/**
 * Primary keys made of more than one column, ported from
 * `ActiveRecord::AttributeMethods::CompositePrimaryKey`, `ActiveRecord::Key`
 * and the `query_constraints` half of `ActiveRecord::Persistence`.
 *
 * The whole feature exists because a single `id` is an assumption, not a fact.
 * A join table's identity is the pair it joins. A tenanted table's identity is
 * `(account_id, id)` — and there the composite key is not a modelling nicety
 * but the thing that stops one tenant's `UPDATE` reaching another tenant's row
 * when an id happens to collide.
 *
 * Which is why every function here refuses a partial key rather than filling
 * the gap. A key with one of two columns missing still produces valid SQL: it
 * just matches more rows than the caller meant, and the failure is a silent
 * over-write rather than an error.
 */

/** A primary key: one column, or several. Rails' `ActiveRecord::Key`. */
export type PrimaryKey = string | readonly string[];

/** Rails' `composite?`. */
export function composite(key: PrimaryKey): boolean {
  return Array.isArray(key) && key.length > 1;
}

/** Rails' `composite_primary_key?`. */
export function compositePrimaryKey(model: { primaryKey: PrimaryKey }): boolean {
  return composite(model.primaryKey);
}

/** The key as a list, whatever shape it was declared in. */
export function keyColumns(key: PrimaryKey): string[] {
  return Array.isArray(key) ? [...key] : [key as string];
}

export class PartialCompositeKey extends Error {
  constructor(key: readonly string[], missing: readonly string[]) {
    super(
      `A key of (${key.join(", ")}) is missing ${missing.join(", ")}. A partial composite ` +
        `key still produces valid SQL — it just matches more rows than intended, so an ` +
        `UPDATE or DELETE built from one silently reaches records it should not.`,
    );
    this.name = "PartialCompositeKey";
  }
}

/**
 * The value of the key. Rails' `id`.
 *
 * An array for a composite key, so a caller cannot mistake `[1, 2]` for the
 * scalar `1` and then compare it against a single column.
 */
export function idFor(record: Record<string, unknown>, key: PrimaryKey): unknown {
  if (!composite(key)) return record[key as string];

  return keyColumns(key).map((column) => record[column]);
}

/**
 * Whether every part of the key has a value. Rails'
 * `primary_key_values_present?`.
 *
 * All of them, not any. A half-populated composite key is what a partial
 * `WHERE` is built from.
 */
export function primaryKeyValuesPresent(record: Record<string, unknown>, key: PrimaryKey): boolean {
  return keyColumns(key).every((column) => {
    const value = record[column];

    return value !== null && value !== undefined;
  });
}

/**
 * Sets the key. Rails' `id=`.
 *
 * Refuses anything that is not a list of the right length for a composite key.
 * Rails raises a `TypeError` on a non-enumerable; the length check is ours,
 * because `record.id = [1]` on a two-column key otherwise leaves the second
 * column holding whatever it held before.
 */
export function setIdFor(record: Record<string, unknown>, key: PrimaryKey, value: unknown): void {
  if (!composite(key)) {
    record[key as string] = value;

    return;
  }

  const columns = keyColumns(key);

  if (!Array.isArray(value) || value.length !== columns.length) {
    throw new TypeError(
      `Expected ${columns.length} values for (${columns.join(", ")}), got ${JSON.stringify(value)}.`,
    );
  }

  columns.forEach((column, index) => {
    record[column] = (value as unknown[])[index];
  });
}

/** Rails' `id?` — whether the key is queryable, meaning every part is set. */
export function idPresent(record: Record<string, unknown>, key: PrimaryKey): boolean {
  return primaryKeyValuesPresent(record, key);
}

/** Rails' `id_before_type_cast`, over a record's raw attribute values. */
export function idBeforeTypeCast(
  beforeTypeCast: Record<string, unknown>,
  key: PrimaryKey,
): unknown {
  return idFor(beforeTypeCast, key);
}

/** Rails' `id_was` — the key as it was when the record was loaded. */
export function idWas(was: Record<string, unknown>, key: PrimaryKey): unknown {
  return idFor(was, key);
}

/** Rails' `id_in_database`. */
export function idInDatabase(inDatabase: Record<string, unknown>, key: PrimaryKey): unknown {
  return idFor(inDatabase, key);
}

/** Rails' `id_for_database` — the key as the adapter will bind it. */
export function idForDatabase(
  record: Record<string, unknown>,
  key: PrimaryKey,
  serialize: (value: unknown, column: string) => unknown = (value) => value,
): unknown {
  if (!composite(key)) return serialize(record[key as string], key as string);

  return keyColumns(key).map((column) => serialize(record[column], column));
}

/**
 * The `WHERE` an update or delete of one record is built from. Rails'
 * `_query_constraints_hash`.
 *
 * Refuses a partial key. This is the single most load-bearing check in the
 * file: the SQL is valid either way, so the only signal that a column was
 * missing is the number of rows the statement touched — noticed, if at all,
 * long after the write.
 */
export function queryConstraintsHash(
  record: Record<string, unknown>,
  key: PrimaryKey,
): Record<string, unknown> {
  const columns = keyColumns(key);
  const missing = columns.filter(
    (column) => record[column] === null || record[column] === undefined,
  );

  if (missing.length > 0) throw new PartialCompositeKey(columns, missing);

  return Object.fromEntries(columns.map((column) => [column, record[column]]));
}

/**
 * The same, from the values a record was loaded with. Rails'
 * `_in_memory_query_constraints_hash`.
 *
 * Used by `reload`, and it has to be the loaded values rather than the current
 * ones: reloading a record whose key column was edited in memory would
 * otherwise fetch a *different* row and overwrite the record with it.
 */
export function inMemoryQueryConstraintsHash(
  loaded: Record<string, unknown>,
  key: PrimaryKey,
): Record<string, unknown> {
  return queryConstraintsHash(loaded, key);
}

// --- declared query constraints -------------------------------------------

const declared = new Map<string, readonly string[]>();

/**
 * Declares the columns a model queries itself by. Rails' `query_constraints`.
 *
 * Separate from the primary key, because the two answer different questions.
 * The primary key is what the database enforces uniqueness on; the query
 * constraint is what this application wants in every `WHERE` — usually a
 * tenant column, so that a bug can never produce a statement that crosses
 * tenants even when it has the right `id`.
 */
export function queryConstraints(model: string, ...columns: string[]): readonly string[] {
  if (columns.length === 0) {
    throw new Error("You must specify at least one column to query by.");
  }

  const list = Object.freeze([...columns]);
  declared.set(model, list);

  return list;
}

export function hasQueryConstraints(model: string): boolean {
  return declared.has(model);
}

export function queryConstraintsList(model: string): readonly string[] | undefined {
  return declared.get(model);
}

export function clearQueryConstraints(): void {
  declared.clear();
}

/**
 * What to actually put in the `WHERE`. Rails'
 * `composite_query_constraints_list`.
 *
 * The declared constraints if there are any, otherwise the primary key — as a
 * list either way, so callers have one shape to handle rather than branching
 * on whether a model happens to be composite.
 */
export function compositeQueryConstraintsList(
  model: string,
  primaryKey: PrimaryKey,
): readonly string[] {
  return declared.get(model) ?? keyColumns(primaryKey);
}

// --- join keys -------------------------------------------------------------

/** One side of a join: which column on which end. */
export interface JoinKeys {
  primaryKey: PrimaryKey;
  foreignKey: PrimaryKey;
  primaryType?: string;
  foreignType?: string;
}

/**
 * Which columns a `belongsTo` joins on. Rails' `join_primary_key` and
 * `join_foreign_key` on `BelongsToReflection`.
 *
 * Inverted relative to a `hasMany`: on a `belongsTo` the foreign key lives on
 * *this* table, so the join reads from the local foreign key to the other
 * table's primary key. Getting the direction wrong produces a join that
 * returns rows — just the wrong ones.
 */
export function belongsToJoinKeys(
  foreignKey: PrimaryKey,
  associationPrimaryKey: PrimaryKey,
  foreignType?: string,
): JoinKeys {
  return {
    primaryKey: associationPrimaryKey,
    foreignKey,
    ...(foreignType === undefined ? {} : { foreignType }),
  };
}

/** The other direction. Rails' `join_primary_key`/`join_foreign_key` on `HasMany`. */
export function hasManyJoinKeys(
  foreignKey: PrimaryKey,
  activeRecordPrimaryKey: PrimaryKey,
  foreignType?: string,
): JoinKeys {
  return {
    primaryKey: foreignKey,
    foreignKey: activeRecordPrimaryKey,
    ...(foreignType === undefined ? {} : { primaryType: foreignType }),
  };
}

/**
 * The join condition, column by column. Rails builds this in
 * `AssociationScope#last_chain_scope`.
 *
 * Refuses a mismatch in width. A two-column key joined against a one-column
 * one is a schema mistake, and the alternative to refusing is a join that
 * matches on the first column alone — which for a tenanted table means rows
 * from every tenant.
 */
export function joinConditions(keys: JoinKeys): { left: string; right: string }[] {
  const left = keyColumns(keys.foreignKey);
  const right = keyColumns(keys.primaryKey);

  if (left.length !== right.length) {
    throw new Error(
      `Cannot join (${left.join(", ")}) against (${right.join(", ")}): different widths. ` +
        `Joining on the columns they have in common would match across every value of the rest.`,
    );
  }

  return left.map((column, index) => ({ left: column, right: right[index] as string }));
}

// --- naming and fixtures ---------------------------------------------------

/**
 * The primary key a model gets when nothing says otherwise. Rails'
 * `get_primary_key`.
 */
export function getPrimaryKey(
  baseName: string | undefined,
  prefixType?: "table_name" | "table_name_with_underscore",
): string {
  if (baseName !== undefined && prefixType === "table_name") return `${baseName}id`;
  if (baseName !== undefined && prefixType === "table_name_with_underscore") {
    return `${baseName}_id`;
  }

  return "id";
}

/** Rails' `internal_string_options_for_primary_key`. */
export function internalStringOptionsForPrimaryKey(): { primaryKey: true } {
  return { primaryKey: true };
}

/** The largest id a fixture may be given. Rails' `MAX_ID`. */
export const MAX_ID = 2 ** 30 - 1;

/**
 * A stable id for a fixture label. Rails' `identify`.
 *
 * A hash rather than a counter, so the same label is the same id in every
 * process and on every machine — which is what lets one fixture file reference
 * another by name without either knowing an insertion order.
 */
export function identify(label: string): number {
  // CRC-32, the same function Rails uses, so ids match across the two.
  let crc = 0xffff_ffff;

  for (let index = 0; index < label.length; index += 1) {
    crc ^= label.charCodeAt(index) & 0xff;

    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb8_8320 : crc >>> 1;
    }
  }

  return ((crc ^ 0xffff_ffff) >>> 0) % MAX_ID;
}

/**
 * The same, for a composite key. Rails' `composite_identify`.
 *
 * Each column gets a different value derived from the one hash, so two columns
 * of one fixture never collide — which they would if the label's hash were
 * simply reused for both, and a `(a, b)` key of `(7, 7)` is exactly the sort of
 * coincidence that makes a broken join look like it works.
 */
export function compositeIdentify(label: string, key: readonly string[]): Record<string, number> {
  const base = identify(label);

  return Object.fromEntries(key.map((column, index) => [column, (base << index) % MAX_ID]));
}

/**
 * Whether a finder was handed several ids. Rails' `expects_multiple_ids?`.
 *
 * For a composite key, `find([1, 2])` is one record and `find([[1, 2]])` is a
 * list of one — a distinction with no visual weight and a completely different
 * result, so it is worth a named function rather than an inline check.
 */
/**
 * The `WHERE` one id means. Rails' `Key#where_hash`.
 *
 * Distinct from `queryConstraintsHash`, which reads the columns off a record
 * it already has. This is the finder's direction: a caller hands over an id
 * and the key says which columns it lands on, so `[4, 7]` against a key of
 * `(account_id, id)` becomes both columns rather than an `IN` on one.
 *
 * A short id is refused. Zipping a missing value to `undefined` would drop the
 * column from the hash and leave a `WHERE` on the tenant alone — the exact
 * cross-tenant match this file exists to prevent, and it would look like a
 * successful lookup.
 */
export function whereHashFor(key: PrimaryKey, id: unknown): Record<string, unknown> {
  if (!composite(key)) return { [key as string]: id };

  const columns = keyColumns(key);

  if (!Array.isArray(id) || id.length !== columns.length) {
    throw new PartialCompositeKey(
      columns,
      columns.slice(Array.isArray(id) ? id.length : 0).map((column) => column),
    );
  }

  return Object.fromEntries(columns.map((column, index) => [column, id[index]]));
}

export function expectsMultipleIds(key: PrimaryKey, ids: unknown): boolean {
  if (!Array.isArray(ids)) return false;
  if (!composite(key)) return true;

  return ids.every((each) => Array.isArray(each));
}

/**
 * What a `DISTINCT` has to select when the key is composite. Rails'
 * `distinct_relation_for_primary_key`.
 *
 * Every key column, not just the first: `SELECT DISTINCT a` over a key of
 * `(a, b)` collapses rows that are genuinely different records.
 */
export function distinctRelationForPrimaryKey(
  key: PrimaryKey,
  orderColumns: readonly string[] = [],
): string[] {
  const columns = keyColumns(key);

  // Ordering columns have to be selected too, or the database refuses the
  // query: you cannot order by something a DISTINCT did not keep.
  return [...columns, ...orderColumns.filter((column) => !columns.includes(column))];
}
