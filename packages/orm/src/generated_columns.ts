/**
 * Columns the database computes, ported from the `as:` / `stored:` column
 * options in Rails' MySQL, PostgreSQL and SQLite schema creation.
 *
 * A generated column is one whose value is an expression over the other
 * columns of its own row — `first_name || ' ' || last_name`, a `lower(email)`
 * for a case-insensitive unique index, a JSON field pulled out so it can be
 * indexed. The application never writes it, and it cannot drift from the
 * columns it is derived from, which is the whole point: a `full_name` kept in
 * sync by a callback is a `full_name` that is wrong for every row written by
 * anything that is not the application.
 *
 * There are two kinds, and the difference is where the cost is paid:
 *
 * - **Stored** is computed on write and kept on disk. It costs space and makes
 *   writes slightly slower, and it can be indexed on every database.
 * - **Virtual** is computed on read and stored nowhere. It costs nothing to
 *   write and is recomputed on every row every time it is selected.
 *
 * The trap this module exists for is that the three databases disagree about
 * which they support and about how to spell it, and every disagreement fails
 * at migration time in production rather than at write time in development:
 *
 * - **PostgreSQL before 18 has no virtual columns at all.** A migration
 *   written on MySQL — where virtual is the *default* — runs there and then
 *   fails on the PostgreSQL it is deployed to, halfway through a deploy.
 * - **MariaDB spells stored `PERSISTENT`.** MySQL's `STORED` is a syntax error
 *   on it, which is the kind of thing discovered by a CI matrix or by a
 *   customer.
 * - **MySQL's default is virtual; SQLite says so explicitly.** Emitting
 *   nothing is right on one and ambiguous on the other.
 */

/** How a column is computed. Rails' `as:` and `stored:`. */
export interface GeneratedColumnOptions {
  /** The expression, in the database's own SQL. Rails' `as:`. */
  as: string;
  /** Computed on write and kept on disk, rather than computed on read. */
  stored?: boolean;
}

export class VirtualColumnUnsupported extends Error {
  constructor(column: string, adapter: string) {
    super(
      `${adapter} cannot compute ${JSON.stringify(column)} on read: it has no virtual generated ` +
        `columns. Pass { stored: true } to keep the value on disk instead. This is refused here, ` +
        `rather than by the server, because the migration that declares it usually runs on a ` +
        `different database in development and would fail halfway through a deploy.`,
    );
    this.name = "VirtualColumnUnsupported";
  }
}

export class GeneratedColumnHasDefault extends Error {
  constructor(column: string) {
    super(
      `${JSON.stringify(column)} is computed by the database, so it cannot also have a default. ` +
        `A default is what a column takes when nobody writes it, and nobody can write a ` +
        `generated column at all.`,
    );
    this.name = "GeneratedColumnHasDefault";
  }
}

/**
 * Whether a generated column is kept on disk. Rails' `virtual_stored?`.
 *
 * Virtual by default, matching MySQL and SQLite — and the reason PostgreSQL is
 * refused rather than quietly upgraded to stored. Silently storing a column
 * somebody asked not to store changes the table's size and its write cost, and
 * a schema dump would then disagree with the migration that produced it.
 */
export function virtualStored(options: GeneratedColumnOptions): boolean {
  return options.stored === true;
}

/**
 * The SQL that makes a column generated, appended to its type.
 *
 * `column` is only used to name the column in an error, which is what makes
 * the error worth reading: "a generated column is wrong" is not a message
 * anybody can act on in a migration with fifteen of them.
 */
export function generatedClause(
  adapter: string,
  column: string,
  options: GeneratedColumnOptions,
  { mariadb = false }: { mariadb?: boolean } = {},
): string {
  const stored = virtualStored(options);

  if (adapter === "postgres") {
    if (!stored) throw new VirtualColumnUnsupported(column, "PostgreSQL");

    return ` GENERATED ALWAYS AS (${options.as}) STORED`;
  }

  if (adapter === "mysql") {
    // MySQL's default is virtual, so the keyword is only worth emitting for
    // stored — and MariaDB, which is otherwise wire-compatible, calls that
    // `PERSISTENT` and rejects `STORED` outright.
    return ` AS (${options.as})${stored ? (mariadb ? " PERSISTENT" : " STORED") : ""}`;
  }

  // SQLite says which it is either way. Its default is virtual too, but a
  // schema dump that says so reads the same on every adapter.
  return ` AS (${options.as}) ${stored ? "STORED" : "VIRTUAL"}`;
}

/**
 * Refuses a column that is both computed and defaulted.
 *
 * Separate from `generatedClause` because it is true on every adapter and has
 * nothing to do with which one is in use.
 */
export function checkGeneratedColumn(
  column: string,
  options: { as?: string; default?: unknown },
): void {
  if (options.as !== undefined && options.default !== undefined) {
    throw new GeneratedColumnHasDefault(column);
  }
}
