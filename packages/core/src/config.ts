/**
 * Application configuration, ported from `Rails::Application::Configuration`.
 *
 * Rails reads `config/environments/<env>.rb` and layers it over defaults. The
 * same shape here: one config object, three environments, and defaults chosen
 * so development is convenient and production is safe.
 */

import type { Level } from "@altair/support";
import { secretKeyBaseFromCredentials } from "./credentials.js";

export type Environment = "development" | "test" | "production";

export interface DatabaseConfig {
  url: string;
  /** Logs every statement. On in development, off elsewhere. */
  logQueries?: boolean;
}

export interface ServerConfig {
  port: number;
  hostname?: string;
}

export interface LogConfig {
  level: Level;
  /**
   * Text for a person watching a terminal, JSON for anything else.
   *
   * A log line is read by a machine far more often than by a person, and the
   * machine reading it with `grep` is why an incident takes an hour instead of
   * a minute.
   */
  format: "text" | "json";
  /** Logs every statement. Useful in development, deafening in production. */
  queries: boolean;
}

export interface ApplicationConfig {
  env: Environment;
  /** Signs and encrypts cookies and sessions. */
  secretKeyBase: string;
  database: DatabaseConfig;
  server: ServerConfig;
  /** Serves stack traces in the response body. Never on in production. */
  showDetailedErrors: boolean;
  /** Forces https and marks cookies Secure. */
  forceSsl: boolean;
  /**
   * Requires a valid CSRF token on every unsafe request.
   *
   * Off in test, as Rails' generated test environment is: a controller test
   * asserting on a redirect should not have to carry a token to get there.
   * On everywhere else, including development, so the first time anybody sees
   * it fail is on their own machine and not in production.
   */
  forgeryProtection: boolean;
  /** Directory the app was loaded from, used to resolve app files. */
  root: string;
  log: LogConfig;
}

/** Reads the environment, defaulting to development as Rails does. */
export function currentEnvironment(
  env: Record<string, string | undefined> = process.env,
): Environment {
  const value = env.ALTAIR_ENV ?? env.NODE_ENV;
  if (value === "production" || value === "test") return value;
  return "development";
}

/**
 * The defaults for an environment.
 *
 * Production defaults are the strict ones. A framework whose safe settings are
 * opt-in ships insecure applications, because nobody reads the config file
 * until something breaks.
 */
export function defaultsFor(
  env: Environment,
  root: string,
): Omit<ApplicationConfig, "secretKeyBase"> {
  const production = env === "production";

  return {
    env,
    root,
    database: {
      url:
        process.env.DATABASE_URL ??
        (env === "test" ? "sqlite://:memory:" : `sqlite://${root}/db/${env}.sqlite3`),
      logQueries: env === "development",
    },
    server: {
      port: Number(process.env.PORT ?? 3000),
      hostname: process.env.HOST,
    },
    showDetailedErrors: !production,
    forceSsl: production,
    forgeryProtection: env !== "test",
    log: {
      // Quiet in tests: a suite that prints a line per request buries the one
      // assertion failure anybody cares about.
      level: env === "test" ? "fatal" : production ? "info" : "debug",
      format: env === "development" ? "text" : "json",
      queries: env === "development",
    },
  };
}

/**
 * Builds a config, filling in what was not given.
 *
 * `secretKeyBase` has no safe default. Generating one at boot would mean every
 * restart invalidates every session, and hard-coding one would put the same key
 * in every application, so this refuses to start without it outside
 * development.
 */
export function buildConfig(overrides: Partial<ApplicationConfig> = {}): ApplicationConfig {
  const env = overrides.env ?? currentEnvironment();
  const root = overrides.root ?? process.cwd();
  const defaults = defaultsFor(env, root);

  const secretKeyBase =
    overrides.secretKeyBase ??
    process.env.SECRET_KEY_BASE ??
    secretKeyBaseFromCredentials(env, root) ??
    (env === "production" ? undefined : "development".repeat(8));

  if (!secretKeyBase) {
    throw new Error(
      "SECRET_KEY_BASE is required in production. Set it in the environment, or put it in the " +
        "encrypted credentials with `altair credentials:edit`. Generate one with `altair secret`.",
    );
  }

  return {
    ...defaults,
    ...overrides,
    env,
    root,
    secretKeyBase,
    database: { ...defaults.database, ...overrides.database },
    server: { ...defaults.server, ...overrides.server },
    log: { ...defaults.log, ...overrides.log },
  };
}
