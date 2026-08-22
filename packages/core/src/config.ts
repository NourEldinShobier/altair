/**
 * Application configuration, ported from `Rails::Application::Configuration`.
 *
 * Rails reads `config/environments/<env>.rb` and layers it over defaults. The
 * same shape here: one config object, three environments, and defaults chosen
 * so development is convenient and production is safe.
 */

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
  /** Directory the app was loaded from, used to resolve app files. */
  root: string;
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
    (env === "production" ? undefined : "development".repeat(8));

  if (!secretKeyBase) {
    throw new Error(
      "SECRET_KEY_BASE is required in production. Generate one with `altair secret` and set it in the environment.",
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
  };
}
