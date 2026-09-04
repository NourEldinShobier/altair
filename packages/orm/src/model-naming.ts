/**
 * What a model's table, primary key and sequence are called, ported from
 * `ActiveRecord::ModelSchema` and the identifier limits in each adapter.
 *
 * Every name here is derived by convention and every one of them is
 * overridable, and the interesting part is what happens in between — because a
 * derived name and an overridden one behave differently in exactly one way
 * that matters: **a derived name has to be recomputed when anything it was
 * derived from changes, and an overridden one must never be.**
 *
 * A subclass inherits its parent's *prefix* and derives its own table name; a
 * subclass of a model with an explicit `table_name` inherits that name
 * outright. Getting that backwards gives an STI subclass its own table — which
 * does not exist — or gives two unrelated models one table, which is worse
 * because it works until the columns diverge.
 *
 * The other theme is length. Every server truncates an identifier past its
 * limit rather than refusing it, so two generated names that differ only past
 * the cutoff silently become one — and the collision surfaces on whichever
 * database already had the first.
 */

import { pluralize, singularize, tableize, underscore } from "@altair/support";

// --- table names ------------------------------------------------------------------------

export interface NamingConfig {
  tableNamePrefix: string;
  tableNameSuffix: string;
  pluralizeTableNames: boolean;
}

export function defaultNamingConfig(): NamingConfig {
  return { tableNamePrefix: "", tableNameSuffix: "", pluralizeTableNames: true };
}

/**
 * Rails' `full_table_name_prefix` — the prefix including every enclosing
 * module's.
 *
 * Walked outward through the namespace rather than read off the class, because
 * `Admin::Reports::Post` should get `admin_reports_` — and reading only the
 * innermost gives `reports_`, a table that exists in neither schema.
 */
export function fullTableNamePrefix(
  namespaces: readonly { tableNamePrefix?: string }[],
  base = "",
): string {
  return namespaces.reduce((prefix, each) => `${prefix}${each.tableNamePrefix ?? ""}`, base);
}

/** Rails' `full_table_name_suffix`. */
export function fullTableNameSuffix(
  namespaces: readonly { tableNameSuffix?: string }[],
  base = "",
): string {
  return namespaces.reduce((suffix, each) => `${each.tableNameSuffix ?? ""}${suffix}`, base);
}

/**
 * Rails' `undecorated_table_name` plus the prefix and suffix.
 *
 * The class name is tableized — underscored and pluralised — unless
 * pluralisation is off, which is what an application mapping onto a legacy
 * schema needs. Both halves are applied after, so a prefix is not itself
 * pluralised.
 */
export function deriveTableName(
  className: string,
  config: NamingConfig = defaultNamingConfig(),
): string {
  const base = config.pluralizeTableNames
    ? tableize(className)
    : underscore(className.split("::").at(-1) ?? className);

  return `${config.tableNamePrefix}${base}${config.tableNameSuffix}`;
}

export interface ModelNaming {
  className: string;
  /** Set only when the application said so, like the table name. */
  explicitPrimaryKey?: string;
  /** Set only when the application said so. */
  explicitTableName?: string;
  /** The class this one inherits from, if any. */
  parent?: ModelNaming;
  /** Whether this is an STI subclass rather than an independent model. */
  singleTableInheritance?: boolean;
  config?: NamingConfig;
}

/**
 * The table a model reads from.
 *
 * The rule that matters: an STI subclass uses its *base* class's table, and an
 * independent subclass derives its own. Backwards, an STI subclass looks for a
 * table that does not exist, or two unrelated models share one — and the
 * second works until their columns diverge, which is much later.
 */
export function tableName(model: ModelNaming): string {
  if (model.explicitTableName !== undefined) return model.explicitTableName;

  if (model.singleTableInheritance === true && model.parent !== undefined) {
    return tableName(model.parent);
  }

  return deriveTableName(model.className, model.config ?? defaultNamingConfig());
}

const tableNameCache = new WeakMap<object, string>();

/**
 * Rails' `reset_table_name`.
 *
 * Forgets a *derived* name so it is computed again. An explicit one is left
 * alone, because the whole point of setting it is that nothing recomputes it —
 * and a reset that cleared it would silently move a legacy model onto a
 * conventionally named table.
 */
export function resetTableName(model: ModelNaming, key: object): string {
  tableNameCache.delete(key);

  return tableName(model);
}

export function cachedTableName(model: ModelNaming, key: object): string {
  const held = tableNameCache.get(key);

  if (held !== undefined) return held;

  const computed = tableName(model);
  tableNameCache.set(key, computed);

  return computed;
}

/**
 * Rails' `extract_schema_qualified_name` — `public.posts` into its two halves.
 *
 * Quoted parts are unquoted and a quoted dot is not a separator: a table
 * genuinely named `"my.table"` exists, and splitting it would produce a schema
 * nobody created.
 */
export function extractSchemaQualifiedName(name: string): { schema?: string; identifier: string } {
  const parts: string[] = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < name.length; index += 1) {
    const character = name[index];

    if (character === '"') {
      // A doubled quote inside a quoted identifier is one literal quote.
      if (quoted && name[index + 1] === '"') {
        current += '"';
        index += 1;
        continue;
      }

      quoted = !quoted;
      continue;
    }

    if (character === "." && !quoted) {
      parts.push(current);
      current = "";
      continue;
    }

    current += character;
  }

  parts.push(current);

  const identifier = parts.at(-1) ?? "";
  const schema = parts.length > 1 ? parts.slice(0, -1).join(".") : undefined;

  return schema === undefined ? { identifier } : { schema, identifier };
}

// --- identifier limits ---------------------------------------------------------------------

export const IDENTIFIER_LIMITS: Readonly<Record<string, number>> = {
  postgres: 63,
  mysql: 64,
  sqlite: 2000,
};

/** Rails' `table_name_length`. */
export function tableNameLength(adapter: string): number {
  return IDENTIFIER_LIMITS[adapter] ?? 63;
}

/** Rails' `index_name_length`. */
export function indexNameLength(adapter: string): number {
  return tableNameLength(adapter);
}

/**
 * Rails' `table_alias_length`.
 *
 * The same limit, and it bites sooner: an alias is generated from a table name
 * plus a join suffix, so a table already near the limit produces aliases that
 * truncate to the same thing — and a query joining the same table twice then
 * silently joins it to itself once.
 */
export function tableAliasLength(adapter: string): number {
  return tableNameLength(adapter);
}

export class IdentifierTooLong extends Error {
  constructor(name: string, limit: number, adapter: string) {
    super(
      `${JSON.stringify(name)} is ${name.length} characters and ${adapter} allows ${limit}. It ` +
        `would be truncated rather than refused, so two names differing only past the cutoff ` +
        `become one — and the collision appears on whichever database already had the first.`,
    );
    this.name = "IdentifierTooLong";
  }
}

export function checkIdentifierLength(name: string, adapter: string): string {
  const limit = tableNameLength(adapter);

  if (name.length > limit) throw new IdentifierTooLong(name, limit, adapter);

  return name;
}

/**
 * Rails' `table_alias_for` — the alias a joined table gets.
 *
 * Truncated *with a digest* rather than plainly when it is too long, so two
 * aliases that would collide do not. A plain truncation is the failure this
 * exists to prevent.
 */
export function aliasFor(tableName: string, suffix: string, adapter = "postgres"): string {
  const candidate = `${tableName}_${suffix}`.replaceAll(".", "_");
  const limit = tableAliasLength(adapter);

  if (candidate.length <= limit) return candidate;

  const digest = shortDigest(candidate);

  return `${candidate.slice(0, limit - digest.length - 1)}_${digest}`;
}

function shortDigest(value: string): string {
  let hash = 0x811c9dc5;

  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193) >>> 0;
  }

  return hash.toString(36).slice(0, 6);
}

/**
 * Rails' `aliased_table_name` — a unique alias among those already taken.
 *
 * Numbered from two, because the first occurrence keeps the bare name: a query
 * joining a table once should read as it always did, and only the second
 * onwards need distinguishing.
 */
export function aliasedTable(
  tableName: string,
  taken: ReadonlySet<string>,
  adapter = "postgres",
): string {
  if (!taken.has(tableName)) return tableName;

  for (let count = 2; ; count += 1) {
    const candidate = aliasFor(tableName, String(count), adapter);

    if (!taken.has(candidate)) return candidate;
  }
}

// --- primary keys --------------------------------------------------------------------------

/**
 * Rails' `primary_key` derivation — `id` unless told otherwise.
 *
 * An STI subclass takes its base class's, because they share a table and a
 * table has one primary key. A subclass deriving its own would generate a
 * `WHERE` against a column the table does not have.
 */
export function primaryKeyName(model: ModelNaming): string {
  if (model.explicitPrimaryKey !== undefined) return model.explicitPrimaryKey;

  if (model.singleTableInheritance === true && model.parent !== undefined) {
    return primaryKeyName(model.parent);
  }

  return "id";
}

const primaryKeys = new Map<string, string>();

export function setPrimaryKey(modelName: string, key: string): void {
  primaryKeys.set(modelName, key);
}

/** Rails' `reset_primary_key`. */
export function resetPrimaryKey(modelName: string): void {
  primaryKeys.delete(modelName);
}

/**
 * Rails' `active_primary_key` — the key in effect right now.
 *
 * Explicit beats derived, and an explicit key set after boot still wins: a
 * model whose key is configured from an initializer is ordinary, and caching
 * the derived answer at load time would make the configuration do nothing.
 */
export function activePrimaryKey(model: ModelNaming & { explicitPrimaryKey?: string }): string {
  return primaryKeys.get(model.className) ?? primaryKeyName(model);
}

export function resetPrimaryKeys(): void {
  primaryKeys.clear();
}

/**
 * Rails' `inferred_id` — the foreign key another model uses to point here.
 *
 * The *singular* class name plus `_id`, not the table name plus `_id`: the
 * table is plural, and `posts_id` is a column nobody generates and every
 * convention would miss.
 */
export function inferredId(className: string): string {
  const base = className.split("::").at(-1) ?? className;

  return `${underscore(singularize(base))}_id`;
}

/** Rails' `primary_key_type` — what a generated key column is. */
export function primaryKeyType(configured?: string): string {
  // `bigint` rather than `integer`. A table that outgrows a 32-bit key needs a
  // migration that rewrites every row and every index referencing it, and the
  // moment it becomes necessary is the moment the table is least able to
  // afford one.
  return configured ?? "bigint";
}

/**
 * Rails' `prefetch_primary_key?` — whether the id has to be generated first.
 *
 * True where the database cannot report it back after an insert. Getting it
 * wrong the other way is what leaves a newly created record with no id, so
 * every association built against it points at nothing.
 */
export function prefetchPrimaryKey(adapter: string, keyType = "bigint"): boolean {
  return adapter === "oracle" || keyType === "uuid";
}

// --- sequences -------------------------------------------------------------------------------

/**
 * Rails' `sequence_name`.
 *
 * Derived from the table and the key, and truncated with a digest for the same
 * reason aliases are: two long tables whose sequence names truncate together
 * would share a sequence, so both would draw from one counter and one of them
 * would skip most of its ids.
 */
export function sequenceName(tableName: string, primaryKey = "id", adapter = "postgres"): string {
  const candidate = `${tableName}_${primaryKey}_seq`;
  const limit = tableNameLength(adapter);

  if (candidate.length <= limit) return candidate;

  const digest = shortDigest(candidate);

  return `${candidate.slice(0, limit - digest.length - 5)}_${digest}_seq`;
}

const sequences = new Map<string, string>();

export function setPkSequence(modelName: string, sequence: string): void {
  sequences.set(modelName, sequence);
}

/** Rails' `reset_sequence_name`. */
export function resetSequence(modelName: string): void {
  sequences.delete(modelName);
}

export function activeSequence(modelName: string, tableName: string, primaryKey = "id"): string {
  return sequences.get(modelName) ?? sequenceName(tableName, primaryKey);
}

export function resetSequences(): void {
  sequences.clear();
}

/** The statement that draws the next value. */
export function nextSequenceValue(sequence: string, adapter = "postgres"): string {
  if (adapter !== "postgres") {
    throw new Error(
      `Only Postgres draws a sequence value before the insert. On ${adapter} the id comes back ` +
        `from the insert itself, and asking for one first would consume a value the row never ` +
        `uses — leaving a gap that reads as a deleted record.`,
    );
  }

  return `SELECT nextval('${sequence.replaceAll("'", "''")}')`;
}

// --- names for the other side of an association -------------------------------------------------
//
// `deriveJoinTableName` is not here: `association-target.ts` already has it.

/** Rails' `join_foreign_key` / `join_primary_key` for a plain association. */
export function joinForeignKey(reflection: { foreignKey?: string; name: string }): string {
  return reflection.foreignKey ?? inferredId(reflection.name);
}

export function joinPrimaryKey(reflection: { primaryKey?: string }): string {
  return reflection.primaryKey ?? "id";
}

/**
 * Rails' `join_foreign_type` / `join_primary_type` — the polymorphic pair.
 *
 * `undefined` for a non-polymorphic association rather than a guessed column
 * name, because a join built with a type condition against a table that has no
 * type column fails in the adapter with a message about SQL.
 */
export function joinForeignType(reflection: {
  polymorphic?: boolean;
  foreignType?: string;
  name: string;
}): string | undefined {
  if (reflection.polymorphic !== true) return undefined;

  return reflection.foreignType ?? `${underscore(reflection.name)}_type`;
}

export function joinPrimaryType(reflection: { polymorphic?: boolean }): string | undefined {
  return reflection.polymorphic === true ? "type" : undefined;
}

/** Rails' `join_id_for` — the value one side contributes to the join. */
export function joinIdFor(owner: Record<string, unknown>, key: string): unknown {
  return owner[key];
}

/** Rails' `pluralize_table_names` applied to one name, for a caller that needs it. */
export function tableizeName(className: string, pluralizeTableNames = true): string {
  const base = className.split("::").at(-1) ?? className;

  return pluralizeTableNames ? pluralize(underscore(base)) : underscore(base);
}
