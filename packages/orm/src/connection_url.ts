/**
 * A database URL, resolved, ported from
 * `ActiveRecord::DatabaseConfigurations::ConnectionUrlResolver`, `UrlConfig`
 * and the adapter-specific pieces around them.
 *
 * `databases.ts` takes a URL and hands it to a driver. That is enough to
 * connect and not enough for anything else: half the framework needs to know
 * what is *in* the URL without opening a connection.
 *
 * - `db:create` and `db:drop` need the database's name, and a URL is usually
 *   the only place it is written down.
 * - The adapter has to be chosen before a driver exists to ask.
 * - A URL saying `?pool=25` is configuration, and left as an opaque string it
 *   is configuration that silently does nothing.
 *
 * The last of those is the reason for the coercions here. A query string
 * carries only text, so `?replica=false` arrives as the string `"false"` —
 * which is truthy. Read as a boolean without care, that entry becomes a replica
 * and every write to it is refused; read `?pool=5` as a string and the pool
 * size compares as text, where `"10" < "5"`. Neither fails at boot. Both fail
 * later, somewhere else.
 */

/** What a URL expands to: the same shape a configuration file entry has. */
export interface UrlConfiguration {
  adapter?: string;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
  [option: string]: unknown;
}

/**
 * URL schemes that name an adapter by another name. Rails'
 * `protocol_adapters`.
 *
 * `postgres://` is what every hosting provider hands out and every other tool
 * accepts, so refusing it would make the framework the only thing that cannot
 * read the connection string on the dashboard.
 */
export const PROTOCOL_ADAPTERS: Readonly<Record<string, string>> = Object.freeze({
  postgres: "postgresql",
  postgis: "postgresql",
  mysql: "mysql2",
  sqlite: "sqlite3",
});

/**
 * Rails' `resolved_adapter` — the adapter a scheme names.
 *
 * A hyphen becomes an underscore because a URL scheme cannot contain one and an
 * adapter name often does. Undefined for a URL with no scheme at all, rather
 * than a default: guessing an adapter connects to the wrong kind of server and
 * fails with a protocol error, which reads as a network problem.
 */
export function adapterNameFrom(url: string): string | undefined {
  const scheme = /^([A-Za-z][\w+.-]*):/.exec(url)?.[1];

  if (scheme === undefined) return undefined;

  const normalized = scheme.replaceAll("-", "_").toLowerCase();

  return PROTOCOL_ADAPTERS[normalized] ?? normalized;
}

/**
 * Reads a value that arrived as text from a query string.
 *
 * `"false"` is the case that matters: it is truthy everywhere in JavaScript, so
 * a `?replica=false` left as a string marks the entry a replica and every write
 * to it is refused. Only the exact spellings are converted — a value that
 * happens to be numeric text but is not a number to us, like a password of
 * `"0000"`, must survive as it was written.
 */
export function coerceUrlValue(value: string): string | number | boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  // A leading zero is not a number here: `0000` is somebody's identifier or
  // secret written into a query string, and reading it as 0 loses the value
  // rather than converting it.
  if (/^-?(?:0|[1-9]\d*)$/.test(value)) return Number(value);

  return value;
}

const BOOLEAN_OPTIONS = ["replica", "database_tasks", "seeds", "use_metadata_table"] as const;

/**
 * Rails' `ConnectionUrlResolver#to_hash` — the URL as a configuration.
 *
 * The path's leading slash is dropped for every adapter but SQLite, where the
 * path *is* the file: `postgres://host/blog` names the database `blog`, and
 * `sqlite3:///tmp/blog.sqlite3` names a file at an absolute path.
 *
 * Empty values are left out rather than kept as empty strings, because a
 * configuration file merged over the URL has to be able to supply them — and
 * `username: ""` overrides a username while `username: undefined` does not.
 */
export function resolveConnectionUrl(url: string): UrlConfiguration {
  const adapter = adapterNameFrom(url);
  const parsed = new URL(url);
  const config: UrlConfiguration = {};

  const put = (key: string, value: string | number | boolean | undefined): void => {
    if (value === undefined || value === "") return;

    config[key] = value;
  };

  put("adapter", adapter);
  put("host", decodeURIComponent(parsed.hostname));
  put("port", parsed.port === "" ? undefined : Number(parsed.port));
  put("username", decodeURIComponent(parsed.username));
  put("password", decodeURIComponent(parsed.password));
  put("database", adapter === "sqlite3" ? parsed.pathname : parsed.pathname.replace(/^\//, ""));

  for (const [key, value] of parsed.searchParams) put(key, coerceUrlValue(value));

  return config;
}

/**
 * Rails' `SQLite3Adapter.resolve_path` — where the database file actually is.
 *
 * A relative path in a configuration file is relative to the application, not
 * to the working directory, because a task run from a subdirectory would
 * otherwise create a second database beside itself and appear to work — with
 * none of the data.
 */
export function resolvePath(database: string, root?: string): string {
  const path = database.startsWith("file:") ? new URL(database).pathname : database;

  if (root === undefined || path.startsWith("/") || /^[A-Za-z]:/.test(path)) return path;

  return `${root.replace(/\/$/, "")}/${path}`;
}

/**
 * Rails' `parse_ssl_mode` — the driver's constant for a mode named in a URL.
 *
 * Named rather than numeric in a URL, and numeric in the driver. Passed through
 * as text the driver takes it as an unknown value and falls back to its own
 * default, which for MySQL is a connection with no TLS at all — a URL that
 * asked for `?ssl_mode=required` and got an unencrypted connection, with
 * nothing reported.
 */
export const SSL_MODES: Readonly<Record<string, number>> = Object.freeze({
  disabled: 0,
  preferred: 1,
  required: 2,
  verify_ca: 3,
  verify_identity: 4,
});

export function parseSslMode(mode: string | number): number {
  if (typeof mode === "number") return mode;

  const name = mode.toLowerCase().replace(/^ssl_mode_/, "");
  const known = SSL_MODES[name];

  if (known === undefined) {
    throw new TypeError(
      `Unknown ssl_mode ${JSON.stringify(mode)}. One of: ${Object.keys(SSL_MODES).join(", ")}. ` +
        `Passed through, a driver takes an unknown mode as its default, which is usually no TLS.`,
    );
  }

  return known;
}

// --- how an entry becomes a configuration ----------------------------------

/**
 * Turns one entry of a configuration file into a configuration. Rails'
 * `db_config_handler`.
 */
export type DbConfigHandler = (
  envName: string,
  name: string,
  url: string | undefined,
  config: Record<string, unknown>,
) => UrlConfiguration | undefined;

const handlers: DbConfigHandler[] = [];

/**
 * Rails' `register_db_config_handler`.
 *
 * A hook because an application's entries can carry keys the framework knows
 * nothing about — a shard router's topology, a proxy's credentials — and the
 * object those become has to be the application's. Handlers are tried newest
 * first, so a registration overrides the default rather than being buried
 * under it.
 */
export function registerDbConfigHandler(handler: DbConfigHandler): void {
  handlers.unshift(handler);
}

export function resetDbConfigHandlers(): void {
  handlers.length = 0;
}

/**
 * Rails' default handler, applied last: a URL is expanded, and the entry's own
 * keys are merged *over* it.
 *
 * That order is what makes `DATABASE_URL` a base rather than an override: an
 * entry naming `pool: 25` alongside a URL keeps its pool, which is how one URL
 * is shared by a primary and a replica that differ in one setting.
 */
export function dbConfig(
  envName: string,
  name: string,
  url: string | undefined,
  config: Record<string, unknown> = {},
): UrlConfiguration {
  for (const handler of handlers) {
    const built = handler(envName, name, url, config);

    if (built !== undefined) return built;
  }

  const merged: UrlConfiguration = {
    ...(url === undefined ? {} : resolveConnectionUrl(url)),
    ...config,
  };

  // Forced after the merge, where a value can still be a string: a query string
  // was coerced on the way in, but a configuration file entry saying
  // `replica: "false"` was not — and these decide whether an entry is written
  // to at all, so a string here is worse than a missing value. It reads as
  // configured and means the opposite of what it says.
  for (const key of BOOLEAN_OPTIONS) {
    if (typeof merged[key] === "string") merged[key] = merged[key] !== "false";
  }

  return merged;
}
