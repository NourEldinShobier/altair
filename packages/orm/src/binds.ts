/**
 * Collecting bind values as a statement is built. Ported from
 * `ActiveRecord::Relation::QueryAttribute`, `Arel::Collectors::SubstituteBinds`
 * and the remaining `Quoting` methods.
 *
 * `sanitization.ts` can quote a value into SQL. What is missing is the other
 * approach, and it is the one that should be used: leaving a placeholder and
 * carrying the value beside the statement.
 *
 * Quoting produces a statement whose text depends on the data, so the database
 * plans it fresh every time and a workload of a million lookups has a million
 * plans. Binding produces one statement and a million sets of values.
 *
 * The safety argument is the better known one and the harder to get wrong by
 * degrees. A quoted value is safe only if the quoting is right for the
 * adapter, the encoding, and the column — three things that are usually right
 * and occasionally not — while a bound value is never SQL at all.
 *
 * The part that actually causes bugs is the *numbering*. PostgreSQL numbers
 * placeholders and the others do not, so a fragment built in isolation and
 * spliced into a larger statement has to be renumbered. Getting that wrong
 * does not fail loudly: it binds the right number of values in the wrong
 * order, and the query returns somebody else's rows.
 */

import type { Connection } from "./connection.js";

/** One value, and the column it is going into. */
export interface BindAttribute {
  name: string;
  value: unknown;
  /** How the value becomes what the database stores. */
  serialize?: (value: unknown) => unknown;
}

/** Rails' `build_bind_attribute`. */
export function buildBindAttribute(
  name: string,
  value: unknown,
  serialize?: (value: unknown) => unknown,
): BindAttribute {
  return serialize === undefined ? { name, value } : { name, value, serialize };
}

/** What a bind is worth to the driver. Rails' `type_casted_binds`. */
export function typeCastedBinds(binds: readonly BindAttribute[]): unknown[] {
  return binds.map((bind) => (bind.serialize ? bind.serialize(bind.value) : bind.value));
}

/**
 * A statement being built, with its values.
 *
 * The placeholders are produced by the collector rather than written by the
 * caller, which is what makes the numbering impossible to get wrong: a caller
 * that writes `$1` by hand is correct until its fragment is used second.
 */
export class BindCollector {
  readonly #parts: string[] = [];
  readonly #binds: BindAttribute[] = [];
  readonly #connection: Connection;

  constructor(connection: Connection) {
    this.#connection = connection;
  }

  /** Appends SQL that carries no values. */
  append(sql: string): this {
    this.#parts.push(sql);

    return this;
  }

  /**
   * Appends a placeholder and remembers the value. Rails' `add_bind`.
   *
   * The placeholder's number comes from how many binds have been collected so
   * far, so it is right by construction rather than by the caller counting.
   */
  addBind(bind: BindAttribute): this {
    this.#parts.push(this.#connection.placeholder(this.#binds.length));
    this.#binds.push(bind);

    return this;
  }

  /** Several at once, comma-separated. Rails' `add_binds`. */
  addBinds(binds: readonly BindAttribute[], separator = ", "): this {
    const placeholders = binds.map((bind, offset) =>
      this.#connection.placeholder(this.#binds.length + offset),
    );

    this.#parts.push(placeholders.join(separator));
    this.#binds.push(...binds);

    return this;
  }

  /** Rails' `has_binds?`. */
  hasBinds(): boolean {
    return this.#binds.length > 0;
  }

  /** Rails' `get_bind_values`. */
  getBindValues(): unknown[] {
    return typeCastedBinds(this.#binds);
  }

  /** The binds themselves, for a caller that needs their names. */
  getBinding(): readonly BindAttribute[] {
    return this.#binds;
  }

  get sql(): string {
    return this.#parts.join("");
  }

  /** Rails' `to_sql_and_binds`. */
  toSqlAndBinds(): { sql: string; binds: unknown[] } {
    return { sql: this.sql, binds: this.getBindValues() };
  }

  /**
   * Splices another collector's statement in, renumbering its placeholders.
   * Rails' `SubstituteBinds`.
   *
   * This is the operation the whole class exists for. A fragment built on its
   * own numbers from one; used as the second half of a statement its values
   * come after the first half's, and pasting the text unchanged binds the
   * right number of values in the wrong order — which returns somebody else's
   * rows rather than failing.
   */
  merge(other: BindCollector, joiner = " "): this {
    const offset = this.#binds.length;
    let renumbered = other.sql;

    if (this.#connection.adapter === "postgres") {
      // Highest first, so rewriting $1 to $3 cannot then be rewritten again by
      // the pass that handles $3.
      const numbers = Array.from(other.getBinding(), (_bind, at) => at).reverse();

      for (const at of numbers) {
        renumbered = renumbered.replaceAll(`$${String(at + 1)}`, `$${String(at + 1 + offset)}`);
      }
    }

    this.#parts.push(
      offset === 0 && this.#parts.length === 0 ? renumbered : `${joiner}${renumbered}`,
    );
    this.#binds.push(...other.getBinding());

    return this;
  }
}

/**
 * A literal that carries its own values. Rails' `bound_sql_literal_for`.
 *
 * For the cases a query builder cannot express — a window function, a
 * database-specific operator — without giving up on binds and going back to
 * interpolation, which is where the injection lives.
 */
export function boundSqlLiteralFor(
  sql: string,
  values: readonly unknown[],
): { sql: string; binds: BindAttribute[] } {
  return {
    sql,
    binds: values.map((value, at) => buildBindAttribute(`literal_${String(at)}`, value)),
  };
}

/** A table name quoted and ready to be selected from. Rails' `quoted_table_name`. */
export function quotedTableName(connection: Connection, table: string): string {
  return table
    .split(".")
    .map((part) => connection.quote(part))
    .join(".");
}

/** Rails' `quoted_primary_key`. */
export function quotedPrimaryKey(connection: Connection, primaryKey: string): string {
  return connection.quote(primaryKey);
}

/**
 * A table name on the left of an assignment. Rails'
 * `quote_table_name_for_assignment`.
 *
 * MySQL will not take a qualified name there — `UPDATE posts SET posts.title`
 * is a syntax error — so only the column survives.
 */
export function quoteTableNameForAssignment(
  connection: Connection,
  table: string,
  column: string,
): string {
  if (connection.adapter === "mysql") return connection.quote(column);

  return `${quotedTableName(connection, table)}.${connection.quote(column)}`;
}

/** The columns of an index, quoted, with any ordering kept. Rails' `quoted_columns_for_index`. */
export function quotedColumnsForIndex(
  connection: Connection,
  columns: readonly string[],
  orders: Readonly<Record<string, "ASC" | "DESC">> = {},
): string[] {
  return columns.map((column) => {
    const order = orders[column];

    return order === undefined ? connection.quote(column) : `${connection.quote(column)} ${order}`;
  });
}

/** How each adapter spells a boolean when it is not a bind. */
export function unquotedTrue(connection: Connection): unknown {
  return connection.adapter === "sqlite" ? 1 : true;
}

export function unquotedFalse(connection: Connection): unknown {
  return connection.adapter === "sqlite" ? 0 : false;
}

/** A time as a literal, to the precision the column keeps. Rails' `quoted_time`. */
export function quotedTime(connection: Connection, at: Date): string {
  const iso = at.toISOString();

  return connection.adapter === "mysql" ? iso.slice(0, 23).replace("T", " ") : iso;
}

/**
 * Binary data as a literal. Rails' `quoted_binary` / `escape_bytea`.
 *
 * PostgreSQL's hex form, which is the one that survives a value containing a
 * quote, a backslash or a null byte — all three of which an uploaded file
 * contains within its first few bytes.
 */
export function quotedBinary(connection: Connection, bytes: Uint8Array): string {
  if (connection.adapter === "postgres") return `'\\x${Buffer.from(bytes).toString("hex")}'`;

  return `X'${Buffer.from(bytes).toString("hex")}'`;
}

export function escapeBytea(bytes: Uint8Array): string {
  return `\\x${Buffer.from(bytes).toString("hex")}`;
}

export function unescapeBytea(value: string): Uint8Array {
  const hex = value.startsWith("\\x") ? value.slice(2) : value;

  return new Uint8Array(Buffer.from(hex, "hex"));
}

/**
 * Text safe to put in a SQL comment. Rails' `sanitize_as_sql_comment`.
 *
 * A closing comment marker ends the comment, so anything after it is executed.
 * A comment carrying
 * a controller and action — which is what query tagging is for — is a comment
 * carrying whatever was in the URL.
 */
export function sanitizeAsSqlComment(value: string): string {
  return value.replaceAll("/*", "").replaceAll("*/", "").replaceAll("\n", " ");
}

/**
 * An ORDER BY fragment, checked. Rails' `sanitize_sql_for_order`.
 *
 * A column name and a direction, nothing else. `ORDER BY` is a common
 * injection point precisely because it cannot be bound — a placeholder is a
 * value and this position needs an identifier — so it has to be validated
 * instead.
 */
export class UnsafeOrder extends Error {
  constructor(fragment: string) {
    super(
      `"${fragment}" is not a column and a direction. An ORDER BY cannot take a bind ` +
        `parameter, so anything here is spliced into the statement — pass a column name.`,
    );
    this.name = "UnsafeOrder";
  }
}

const ORDER =
  /^\s*[a-zA-Z_][\w$]*(?:\.[a-zA-Z_][\w$]*)?(?:\s+(?:asc|desc))?(?:\s+nulls\s+(?:first|last))?\s*$/i;

export function sanitizeSqlForOrder(fragment: string): string {
  if (!ORDER.test(fragment)) throw new UnsafeOrder(fragment);

  return fragment.trim();
}

/** How a type is spelled in DDL. Rails' `type_to_sql`. */
export function typeToSql(
  connection: Connection,
  type: string,
  options: { limit?: number; precision?: number; scale?: number } = {},
): string {
  const base = type.toUpperCase();

  if (options.precision !== undefined) {
    const scale = options.scale === undefined ? "" : `,${String(options.scale)}`;

    return `${base}(${String(options.precision)}${scale})`;
  }

  if (options.limit !== undefined) return `${base}(${String(options.limit)})`;

  // SQLite has no varchar length at all, and giving it one is accepted and
  // ignored — which reads as a constraint that is not there.
  return connection.adapter === "sqlite" && base === "VARCHAR" ? "TEXT" : base;
}
