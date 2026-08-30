/**
 * Turning caller-supplied fragments into SQL that means what it says.
 *
 * Bindings handle almost everything, and where a binding will do, nothing here
 * is needed — `where({ name })` is already safe. These cover the three places
 * a binding cannot reach: the inside of a LIKE pattern, an identifier, and a
 * clause the caller wrote as text.
 */

import type { Connection } from "./connection.js";

/**
 * Escapes the wildcards in a LIKE pattern. Rails' `sanitize_sql_like`.
 *
 * A binding stops injection but does not stop `%`. Searching for a user who
 * typed `50%` sends `%50%%` to the database, the trailing `%` is a wildcard,
 * and the search silently matches everything — a correctness bug that reads
 * like a ranking problem and survives for years. `_` is worse, because it
 * matches exactly one character and so still returns a plausible-looking
 * subset.
 *
 *     `%${sanitizeSqlLike(term)}%`
 *
 * The escape character itself is escaped first. Doing it in the other order
 * would turn a literal backslash into an escape for the `%` that follows it.
 */
export function sanitizeSqlLike(pattern: string, escape = "\\"): string {
  const escaped = escape.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  return pattern.replace(new RegExp(`([${escaped}%_])`, "g"), `${escape}$1`);
}

/**
 * A Rails array condition — a template and its values — as SQL and bindings.
 *
 *     sanitizeSqlArray(["name = ? AND age > ?", "Ada", 36])
 *     // { sql: "name = ? AND age > ?", bindings: ["Ada", 36] }
 *
 * The values are never interpolated into the string. That is the whole point:
 * the template stays a template, and the driver is what pairs it with the
 * values, so a value containing a quote cannot become syntax.
 *
 * Named placeholders — `:name` — are supported too, and are the better choice
 * once there is more than one, since a positional list is easy to reorder by
 * accident and nothing complains until the types happen to differ.
 */
export function sanitizeSqlArray(
  condition: [string, ...unknown[]] | [string, Record<string, unknown>],
): { sql: string; bindings: unknown[] } {
  const [template, ...rest] = condition;
  const named = rest.length === 1 && isPlainRecord(rest[0]);

  if (!named) {
    const wanted = countPlaceholders(template);

    if (wanted !== rest.length) {
      throw new Error(
        `wrong number of bind variables (${rest.length} for ${wanted}) in: ${template}`,
      );
    }

    return { sql: template, bindings: rest };
  }

  const values = rest[0] as Record<string, unknown>;
  const bindings: unknown[] = [];

  const sql = template.replace(/:(\w+)/g, (_match, name: string) => {
    if (!(name in values)) throw new Error(`missing value for :${name} in: ${template}`);
    bindings.push(values[name]);
    return "?";
  });

  return { sql, bindings };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype
  );
}

/** Question marks outside string literals, which are the ones that bind. */
function countPlaceholders(template: string): number {
  return (template.replace(/'[^']*'/g, "").match(/\?/g) ?? []).length;
}

/**
 * A WHERE fragment from whatever shape the caller passed. Rails'
 * `sanitize_sql_for_conditions`.
 */
export function sanitizeSqlForConditions(
  condition: string | [string, ...unknown[]] | [string, Record<string, unknown>],
): { sql: string; bindings: unknown[] } {
  return typeof condition === "string"
    ? { sql: condition, bindings: [] }
    : sanitizeSqlArray(condition);
}

/**
 * A SET fragment from an object of column to value. Rails'
 * `sanitize_sql_for_assignment`.
 *
 * Column names go through identifier quoting rather than a binding, because a
 * binding cannot stand where an identifier stands — so they are also the one
 * part a caller must not take from user input.
 */
export function sanitizeSqlForAssignment(
  connection: Connection,
  values: Record<string, unknown>,
): { sql: string; bindings: unknown[] } {
  const entries = Object.entries(values);

  return {
    sql: entries.map(([column]) => `${quoteColumnName(connection, column)} = ?`).join(", "),
    bindings: entries.map(([, value]) => value),
  };
}

/** Columns that may appear in an ORDER BY without being a raw-SQL risk. */
const PERMITTED_ORDER = /^\s*\w+(\.\w+)?\s*(asc|desc)?\s*(nulls\s+(first|last))?\s*$/i;

/**
 * Rejects an ORDER BY fragment that is not a plain column reference. Rails'
 * `disallow_raw_sql!`.
 *
 * `order(request.query.sort)` is the classic hole: a sort parameter is
 * attacker-controlled, it lands where no binding can go, and the obvious
 * exploit is a subquery in the ORDER BY. This is the check Rails added when it
 * stopped trusting that clause, and the permitted shape is deliberately narrow
 * — a column, optionally table-qualified, optionally with a direction and a
 * nulls placement, and nothing else.
 *
 * A caller with a genuinely dynamic clause should be picking from a list it
 * owns rather than reaching past this.
 */
export function disallowRawSql(fragments: readonly string[]): void {
  const offending = fragments.filter((one) => !PERMITTED_ORDER.test(one));

  if (offending.length > 0) {
    throw new Error(
      `Dangerous query method: ${offending.map((one) => JSON.stringify(one)).join(", ")}. ` +
        `Pass a column name, optionally with asc/desc — not raw SQL.`,
    );
  }
}

/** A column name, quoted for this adapter. Rails' `quote_column_name`. */
export function quoteColumnName(connection: Connection, column: string): string {
  return connection.quote(column);
}

/**
 * A table name, quoted for this adapter, keeping a schema qualifier apart.
 * Rails' `quote_table_name`.
 *
 * The difference from quoting a column: `public.posts` is two identifiers, and
 * quoting it whole produces `"public.posts"` — one table whose name contains a
 * dot, which does not exist. Each half is quoted on its own.
 */
export function quoteTableName(connection: Connection, table: string): string {
  return table
    .split(".")
    .map((part) => connection.quote(part))
    .join(".");
}

/** A schema name, quoted. Rails' `quote_schema_name`. */
export function quoteSchemaName(connection: Connection, schema: string): string {
  return connection.quote(schema);
}

/**
 * The name inside an already-quoted identifier.
 *
 * For reading back what the server reports, which comes quoted from some
 * catalogs and bare from others.
 */
export function unquoteIdentifier(identifier: string): string {
  const trimmed = identifier.trim();

  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replaceAll('""', '"');
  }

  if (trimmed.startsWith("`") && trimmed.endsWith("`")) {
    return trimmed.slice(1, -1).replaceAll("``", "`");
  }

  return trimmed;
}

/**
 * A string as a SQL literal. Rails' `quote_string`.
 *
 * Wanted only where a binding genuinely cannot go — a column DEFAULT in DDL is
 * the honest case. Everywhere else a binding is both safer and faster, and a
 * caller reaching for this in a WHERE clause has taken a wrong turn.
 */
export function quoteString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** A date as the literal this adapter reads. Rails' `quoted_date`. */
export function quotedDate(connection: Connection, value: Date): string {
  const iso = value.toISOString();

  return connection.adapter === "mysql" ? iso.slice(0, 23).replace("T", " ") : iso;
}

/** How this adapter spells true. Rails' `quoted_true`. */
export function quotedTrue(connection: Connection): string {
  return connection.adapter === "sqlite" ? "1" : "TRUE";
}

/** How this adapter spells false. Rails' `quoted_false`. */
export function quotedFalse(connection: Connection): string {
  return connection.adapter === "sqlite" ? "0" : "FALSE";
}

/**
 * A DEFAULT expression for DDL, quoted if it is a value and left alone if it
 * is an expression. Rails' `quote_default_expression`.
 *
 * The distinction the name hides: `DEFAULT 'now()'` stores the seven-character
 * string, `DEFAULT now()` stores the time the row was written. A function call
 * is passed through; anything else is quoted as the literal it is.
 */
export function quoteDefaultExpression(connection: Connection, value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? quotedTrue(connection) : quotedFalse(connection);
  if (typeof value === "number") return String(value);
  if (value instanceof Date) return quoteString(quotedDate(connection, value));

  const text = String(value);

  return /^\w+\s*\(.*\)$/.test(text) ? text : quoteString(text);
}
