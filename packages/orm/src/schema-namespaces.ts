/**
 * Where a table lives, and what a dump must not pin down. Ported from
 * `ConnectionAdapters::PostgreSQL::SchemaStatements`, `SchemaDumper`'s ignore
 * patterns and the MySQL table options.
 *
 * `schema-creation.ts` writes the DDL for a table. Two things sit around that
 * and are easy to leave out, both of which produce a schema file that loads
 * without complaint and rebuilds a *different* database:
 *
 * - **A table has a namespace.** PostgreSQL resolves an unqualified name
 *   against a search path, so `posts` means whichever `posts` the path finds
 *   first. An application with a schema per tenant has one table name and many
 *   tables; a dump that records the name without the path records something
 *   that means a different table depending on who loads it.
 * - **Some names should not be in the dump at all.** A foreign key nobody
 *   named gets a generated name, and writing that name into the schema file
 *   pins an identifier the server would have chosen anyway — so the file
 *   differs between machines, and a rebuild recreates a constraint whose name
 *   came from a hash of the machine it was first created on.
 *
 * The MySQL half is the mirror image: a table's engine, row format and
 * collation are not in its column list, and a dump that loses them rebuilds a
 * table that behaves differently under load and sorts differently in every
 * query.
 */

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/**
 * Quotes one entry of a search path.
 *
 * `sanitization.ts` quotes a schema name through the connection, which is the
 * right thing when there is one. A search path is written before any statement
 * runs and often before a connection exists, and it has an entry the
 * connection's quoting does not know about: `$user` is a legal search-path
 * entry and not a legal bare identifier, so unquoted it is a syntax error —
 * and it appears in the *default* path, which means the failure is on a path
 * nobody chose.
 */
export function quoteSearchPathEntry(name: string): string {
  return IDENTIFIER.test(name) ? name : `"${name.replaceAll('"', '""')}"`;
}

/**
 * The search path as the server sees it. Rails' `current_schemas`.
 *
 * `$user` is resolved to the connected user's own schema, and dropped when
 * that schema does not exist — which is what the server does, and why a path
 * of `"$user", public` on a database with no per-user schemas is simply
 * `public` rather than an error.
 */
export function currentSchemas(
  searchPath: string,
  { user, existing }: { user?: string; existing?: readonly string[] } = {},
): string[] {
  const named = searchPath
    .split(",")
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter((entry) => entry.length > 0)
    .map((entry) => (entry === "$user" ? user : entry))
    .filter((entry): entry is string => entry !== undefined);

  return existing === undefined ? named : named.filter((entry) => existing.includes(entry));
}

/** Rails' `schema_search_path=` — the statement that sets it. */
export function setSearchPathSql(schemas: readonly string[]): string {
  return `SET search_path TO ${schemas.map((name) => quoteSearchPathEntry(name)).join(", ")}`;
}

export function createSchemaSql(
  name: string,
  { ifNotExists = false }: { ifNotExists?: boolean } = {},
): string {
  return `CREATE SCHEMA${ifNotExists ? " IF NOT EXISTS" : ""} ${quoteSearchPathEntry(name)}`;
}

/**
 * Rails' `drop_schema` — always cascading.
 *
 * A schema is dropped to remove a tenant or a test namespace, and it always
 * has tables in it. Without `CASCADE` the statement fails on exactly the
 * schemas anybody would want to drop, so a non-cascading form would only ever
 * be written by mistake.
 */
export function dropSchemaSql(
  name: string,
  { ifExists = false }: { ifExists?: boolean } = {},
): string {
  return `DROP SCHEMA${ifExists ? " IF EXISTS" : ""} ${quoteSearchPathEntry(name)} CASCADE`;
}

/** Rails' `rename_schema`. */
export function renameSchema(name: string, newName: string): string {
  return `ALTER SCHEMA ${quoteSearchPathEntry(name)} RENAME TO ${quoteSearchPathEntry(newName)}`;
}

/**
 * Splits `analytics.events` into its parts. Rails' `quoted_scope`.
 *
 * Only on the *first* dot, because a schema name may not contain one while a
 * table name quoted into existence may. Split on the last, a table called
 * `reports.2024` in the public schema would be read as a table `2024` in a
 * schema `reports` that does not exist.
 */
export function splitSchemaName(qualified: string): { schema?: string; table: string } {
  const at = qualified.indexOf(".");

  if (at === -1) return { table: qualified };

  return { schema: qualified.slice(0, at), table: qualified.slice(at + 1) };
}

/**
 * A name qualified against a search path, when it needs to be.
 *
 * Left unqualified when the schema is the first entry in the path: the
 * qualification is redundant there, and a dump full of redundant
 * qualifications is one that cannot be loaded into a database using a
 * different path — which is the usual reason for having one.
 */
export function qualifiedTableName(
  table: string,
  { schema, searchPath = [] }: { schema?: string; searchPath?: readonly string[] } = {},
): string {
  if (schema === undefined || schema === searchPath[0]) return table;

  return `${schema}.${table}`;
}

// --- what a dump should not record -----------------------------------------

/**
 * The names a database generated rather than an application chose. Rails'
 * `fk_ignore_pattern` and friends.
 *
 * Matched by shape, because that is all there is to go on: the name arrives
 * from the server with nothing saying who chose it.
 */
export const GENERATED_NAME_PATTERNS: Readonly<Record<string, RegExp>> = {
  foreignKey: /^fk_rails_[0-9a-f]{10}$/,
  check: /^chk_rails_[0-9a-f]{10}$/,
  exclusion: /^excl_rails_[0-9a-f]{10}$/,
  unique: /^uniq_rails_[0-9a-f]{10}$/,
};

/**
 * Whether a constraint's name belongs in the schema dump. Rails'
 * `export_name_on_schema_dump?`.
 *
 * A generated name is left out so the dump says what the constraint *is* and
 * lets the name be derived again. Written down, the file records an identifier
 * derived from the table and column names as they were on the machine that
 * first created it — so two developers' dumps differ, the diff is noise, and
 * a rename upstream silently stops matching.
 *
 * A name the application chose is always kept: it may be referenced by a
 * migration, by a query hint, or by an operator at a console.
 */
export function exportNameOnSchemaDump(
  name: string | undefined,
  kind: keyof typeof GENERATED_NAME_PATTERNS = "foreignKey",
): boolean {
  if (name === undefined) return false;

  return !(GENERATED_NAME_PATTERNS[kind] as RegExp).test(name);
}

// --- what a table is, beyond its columns -----------------------------------

export interface TableAttributes {
  engine?: string;
  rowFormat?: string;
  collation?: string;
  charset?: string;
  comment?: string;
}

/**
 * The options a dump has to carry with a table. Rails' `table_options`.
 *
 * None of these are in the column list, and each changes what the rebuilt
 * table does rather than what it holds: the engine decides whether there are
 * transactions at all, the row format decides how large a row may be before an
 * insert starts failing, and the collation decides what `WHERE name = 'é'`
 * matches.
 *
 * Emitted only when set, so a dump of a database on its defaults does not pin
 * those defaults — which is what would make the file fail to load on a server
 * configured differently.
 */
export function tableOptions(attributes: TableAttributes = {}): string {
  const parts: string[] = [];

  if (attributes.engine !== undefined) parts.push(`ENGINE=${attributes.engine}`);
  if (attributes.rowFormat !== undefined) parts.push(`ROW_FORMAT=${attributes.rowFormat}`);
  if (attributes.charset !== undefined) parts.push(`DEFAULT CHARSET=${attributes.charset}`);
  if (attributes.collation !== undefined) parts.push(`COLLATE=${attributes.collation}`);

  if (attributes.comment !== undefined) {
    parts.push(`COMMENT=${JSON.stringify(attributes.comment).replaceAll('"', "'")}`);
  }

  return parts.join(" ");
}

/**
 * The collation a table sorts and compares with. Rails' `table_collation`.
 *
 * Falls back to the database's, because that is what the server does — and a
 * table reported as having no collation would make a dump omit the one thing
 * that decides whether two names are equal.
 */
export function tableCollation(
  table: string,
  collations: Readonly<Record<string, string>>,
  databaseCollation?: string,
): string | undefined {
  return collations[table] ?? databaseCollation;
}
