/**
 * What database is actually on the other end, ported from the introspection
 * methods on `ActiveRecord::ConnectionAdapters::AbstractAdapter` —
 * `database_version`, `current_database`, `current_schema`, `charset`,
 * `collation`, `database_exists?`, `supports_advisory_locks?`.
 *
 * A connection string says what somebody meant to connect to. This says what
 * they got, and the difference is where a class of very quiet bugs lives.
 *
 * The clearest is MySQL's `utf8`. It is not UTF-8: it holds three bytes per
 * character, so every four-byte character — every emoji, and a good deal of
 * Chinese — is either rejected or silently truncated at the first one, taking
 * the rest of the string with it. A column that looks fine in every test with
 * Latin text loses half a user's message the first time somebody uses an
 * emoji. Reading the charset back is how that is caught at boot rather than in
 * a support ticket months later.
 */

import type { Connection } from "./connection.js";

/** One row of whatever a `SELECT` for a single value returned. */
async function scalar(connection: Connection, sql: string): Promise<string | undefined> {
  try {
    const rows = await connection.query<Record<string, unknown>>(sql);
    const first = rows[0];

    if (!first) return undefined;

    const value = Object.values(first)[0];

    return value === null || value === undefined ? undefined : String(value);
  } catch {
    // Introspection must never be the thing that takes an application down.
    // A permission that does not allow reading a system view, an adapter that
    // spells a catalogue differently — the answer is "I do not know", which is
    // what the caller can act on.
    return undefined;
  }
}

/**
 * The server's version. Rails' `database_version`.
 *
 * The string as the server reports it, not a parsed one: every server spells
 * this differently — `8.0.35`, `15.4`, `3.45.1`, and MariaDB puts its own name
 * in the middle — and a parser that got it wrong would be worse than the raw
 * string a person can read.
 */
export async function databaseVersion(connection: Connection): Promise<string | undefined> {
  switch (connection.adapter) {
    case "postgres":
      return await scalar(connection, "SELECT version()");
    case "mysql":
      return await scalar(connection, "SELECT VERSION()");
    default:
      return await scalar(connection, "SELECT sqlite_version()");
  }
}

/** The database this connection is using. Rails' `current_database`. */
export async function currentDatabase(connection: Connection): Promise<string | undefined> {
  switch (connection.adapter) {
    case "postgres":
      return await scalar(connection, "SELECT current_database()");
    case "mysql":
      return await scalar(connection, "SELECT DATABASE()");
    default:
      // SQLite's database is a file, and its path is the useful answer.
      return await scalar(connection, "SELECT file FROM pragma_database_list WHERE name = 'main'");
  }
}

/**
 * The schema new tables land in. Rails' `current_schema`.
 *
 * PostgreSQL only, where it is a real question: a search path putting a
 * tenant's schema first means the same statement reaches a different table
 * depending on the connection. Elsewhere there is one namespace and the
 * honest answer is that there is nothing to report.
 */
export async function currentSchema(connection: Connection): Promise<string | undefined> {
  if (connection.adapter !== "postgres") return undefined;

  return await scalar(connection, "SELECT current_schema()");
}

/**
 * The character set the database was created with. Rails' `charset`.
 *
 * Worth reading on MySQL specifically, where `utf8` means three bytes and
 * `utf8mb4` means four — see the note at the top of this file.
 */
export async function charsetCurrent(connection: Connection): Promise<string | undefined> {
  switch (connection.adapter) {
    case "mysql":
      return await scalar(connection, "SELECT @@character_set_database");
    case "postgres":
      return await scalar(
        connection,
        "SELECT pg_encoding_to_char(encoding) FROM pg_database WHERE datname = current_database()",
      );
    default:
      return await scalar(connection, "PRAGMA encoding");
  }
}

/** How text is sorted and compared. Rails' `collation`. */
export async function collationCurrent(connection: Connection): Promise<string | undefined> {
  switch (connection.adapter) {
    case "mysql":
      return await scalar(connection, "SELECT @@collation_database");
    case "postgres":
      return await scalar(
        connection,
        "SELECT datcollate FROM pg_database WHERE datname = current_database()",
      );
    default:
      // SQLite has no per-database collation; BINARY is what it compares with.
      return "BINARY";
  }
}

/**
 * How the database classifies characters. Rails' `ctype`.
 *
 * The sibling of `collation`, and a different thing: collation decides what
 * sorts before what, ctype decides what counts as a letter and what the
 * uppercase of it is. They are usually set together and can be set apart, and
 * a database with the wrong ctype is one where `LOWER` and `UPPER` leave every
 * non-ASCII character alone.
 *
 * That is the same shape of bug as MySQL's three-byte `utf8` above: the tests
 * pass because the fixtures are in English, and the first case-insensitive
 * search for a name with an accent in it silently matches nothing.
 *
 * PostgreSQL is the only one of the three that has this as a separate setting;
 * MySQL folds it into the collation and SQLite has neither.
 */
export async function ctype(connection: Connection): Promise<string | undefined> {
  if (connection.adapter !== "postgres") return undefined;

  return await scalar(
    connection,
    "SELECT datctype FROM pg_database WHERE datname = current_database()",
  );
}

/**
 * One MySQL server variable. Rails' `show_variable`.
 *
 * Undefined rather than an error for one that does not exist, because that is
 * the normal answer: the variables worth reading are the ones that came and
 * went between versions, and the caller is asking precisely because it does
 * not know whether this server has it.
 *
 * The name is checked rather than interpolated blind. `@@` takes no
 * placeholder, so this is string-built by necessity, and a variable name is
 * exactly the kind of thing that arrives from configuration.
 */
export async function showVariable(
  connection: Connection,
  name: string,
): Promise<string | undefined> {
  if (connection.adapter !== "mysql") return undefined;
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
    throw new Error(
      `${JSON.stringify(name)} is not a server variable name. Only letters, digits and ` +
        `underscores — this is interpolated into the statement, because \`@@\` takes no ` +
        `placeholder.`,
    );
  }

  return await scalar(connection, `SELECT @@${name}`);
}

/**
 * Whether the charset can hold every character. Rails has no single method for
 * this; the check is worth having under a name that says what it is for.
 *
 * False only for MySQL's three-byte `utf8`, which is the one case where a
 * string can be silently cut in half rather than stored or refused.
 *
 * Asked of MySQL alone, and that is the point rather than an oversight:
 * PostgreSQL reports its encoding as `UTF8` and means the real four-byte
 * thing. A check that matched on the name without asking which server said it
 * would condemn every PostgreSQL database in the world.
 */
export async function charsetHoldsEveryCharacter(connection: Connection): Promise<boolean> {
  if (connection.adapter !== "mysql") return true;

  const charset = (await charsetCurrent(connection))?.toLowerCase();

  if (charset === undefined) return true;

  // `utf8mb3` is the honest name for the same three-byte set, and newer MySQL
  // reports it that way — so checking for `utf8` alone misses half the servers
  // that have the problem.
  return charset !== "utf8" && charset !== "utf8mb3";
}

/** Whether a database with this name exists. Rails' `database_exists?`. */
export async function databaseExists(connection: Connection, name: string): Promise<boolean> {
  switch (connection.adapter) {
    case "postgres":
      return (
        (await scalar(
          connection,
          `SELECT 1 FROM pg_database WHERE datname = ${quoted(connection, name)}`,
        )) !== undefined
      );
    case "mysql":
      return (
        (await scalar(
          connection,
          `SELECT 1 FROM information_schema.schemata WHERE schema_name = ${quoted(connection, name)}`,
        )) !== undefined
      );
    default:
      // For SQLite the question is whether the file is attached, and `main`
      // always is — so the only meaningful answer is about the name given.
      return (
        (await scalar(
          connection,
          `SELECT 1 FROM pragma_database_list WHERE name = ${quoted(connection, name)}`,
        )) !== undefined
      );
  }
}

/**
 * Whether the server has advisory locks. Rails' `supports_advisory_locks?`.
 *
 * What a migration takes so two deploys do not run the same migration at once.
 * SQLite has none, which is why a SQLite deployment must not run migrations
 * from two processes and why saying so here is more useful than a lock that
 * quietly does nothing.
 */
export function advisoryLocksEnabled(connection: Connection): boolean {
  return connection.adapter === "postgres" || connection.adapter === "mysql";
}

/**
 * Everything at once, for a boot check or a diagnostics page.
 *
 * One call because these are asked together and each is a round trip; a
 * startup banner making six of them serially is six times the latency for
 * something nobody times.
 */
export async function databaseInfo(connection: Connection): Promise<{
  adapter: string;
  version: string | undefined;
  database: string | undefined;
  schema: string | undefined;
  charset: string | undefined;
  collation: string | undefined;
  ctype: string | undefined;
  advisoryLocks: boolean;
  charsetHoldsEveryCharacter: boolean;
}> {
  const [version, database, schema, charset, collation, characterType] = await Promise.all([
    databaseVersion(connection),
    currentDatabase(connection),
    currentSchema(connection),
    charsetCurrent(connection),
    collationCurrent(connection),
    ctype(connection),
  ]);

  return {
    adapter: connection.adapter,
    version,
    database,
    schema,
    charset,
    collation,
    ctype: characterType,
    advisoryLocks: advisoryLocksEnabled(connection),
    charsetHoldsEveryCharacter: await charsetHoldsEveryCharacter(connection),
  };
}

/**
 * A literal for a name that came from configuration.
 *
 * Escaped rather than bound because these run against catalogue views where
 * some adapters will not take a placeholder, and a database name is not user
 * input — but it is still interpolated, so the quote doubling is what stops a
 * name with an apostrophe becoming a syntax error nobody can read.
 */
function quoted(connection: Connection, value: string): string {
  void connection;

  return `'${value.replaceAll("'", "''")}'`;
}
