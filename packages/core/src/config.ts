/**
 * Application configuration, ported from `Rails::Application::Configuration`.
 *
 * Rails reads `config/environments/<env>.rb` and layers it over defaults. The
 * same shape here: one config object, three environments, and defaults chosen
 * so development is convenient and production is safe.
 */

import { currentEnvironment, type Environment, type Level } from "@altair/support";
import { secretKeyBaseFromCredentials } from "./credentials.js";

// Moved to @altair/support, where the packages that cannot depend on core can
// reach it. Re-exported here, where it has always been imported from.
export { currentEnvironment, type Environment };

export interface DatabaseConfig {
  url: string;
  /** Logs every statement. On in development, off elsewhere. */
  logQueries?: boolean;
}

export interface ServerConfig {
  port: number;
  hostname?: string;
  /**
   * How many processes serve requests. Rails' `WEB_CONCURRENCY`.
   *
   * One by default, which is what a single `Bun.serve` gives. Bun runs
   * JavaScript on one thread, so one process uses one core however many the
   * machine has — the same limit Ruby's GVL puts on a Rails process, and the
   * reason Rails ships `WEB_CONCURRENCY` too.
   *
   * `"auto"` is one worker per core. A number is that many. Above one, the
   * process that called `listen` becomes a supervisor that serves nothing and
   * restarts workers that die.
   *
   * What does not scale with this: anything that must happen once. A scheduler,
   * a cron, a migration on boot — four workers run four of them. Rails has the
   * same rule and the same answer, which is to run those somewhere other than
   * the web process.
   *
   * **Linux only, in practice.** `node:cluster` forks on every platform, but
   * only Linux distributes connections across the workers. Measured with one
   * file on both: four workers, thirty requests, separate connections — Linux
   * spread them over all four processes, Windows sent all thirty to one and
   * left the other three idle. Nothing errors on Windows; the workers simply
   * never serve, so a developer there gets one process however this is set.
   */
  workers?: number | "auto";
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
   * Serves what is in `public/`. Rails' `config.public_file_server.enabled`.
   *
   * On everywhere, including production. An application behind a CDN or nginx
   * never reaches it; one deployed as a container with nothing in front is the
   * common case now, and for that the alternative is that its own favicon
   * 404s.
   */
  publicFileServer: boolean;
  /**
   * Requires a valid CSRF token on every unsafe request.
   *
   * Off in test, as Rails' generated test environment is: a controller test
   * asserting on a redirect should not have to carry a token to get there.
   * On everywhere else, including development, so the first time anybody sees
   * it fail is on their own machine and not in production.
   */
  forgeryProtection: boolean;
  /**
   * Hosts this application answers to. Empty answers to any, as Rails does.
   *
   * Defaulted in development and test, where the attack this stops is aimed:
   * a development server is on the same machine as the browser, so a page that
   * re-resolves its own domain to 127.0.0.1 can reach it. A production server
   * is normally behind something that already rejects an unknown Host, and an
   * application that is not can name its hosts here.
   */
  hosts: (string | RegExp)[];
  /**
   * Extra exception-to-status mappings, layered over the built-in ones.
   *
   *     rescueResponses: { PaymentRequired: 402 }
   *
   * Keyed on the error's `name`, as Rails keys on the class name.
   */
  rescueResponses: Record<string, number>;
  /**
   * Answers `/up` with the state of the application. Rails generates the same
   * route. Off only for an application that wants to answer it itself.
   */
  healthCheck: boolean;
  /** Directory the app was loaded from, used to resolve app files. */
  root: string;
  log: LogConfig;
}

/**
 * `WEB_CONCURRENCY` as a worker count.
 *
 * Unset or unreadable means one, rather than a guess: a variable that has been
 * set to something meaningless is more likely a typo than a request to fan out,
 * and starting eight processes because of one is worse than starting one.
 */
export function workersFrom(value: string | undefined): number | "auto" {
  if (value === undefined || value.trim() === "") return 1;
  if (value.trim() === "auto") return "auto";

  const count = Number(value);

  return Number.isInteger(count) && count > 0 ? count : 1;
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
      // Named `WEB_CONCURRENCY` because that is what it is called on every
      // platform that already runs Rails, and a deployment moving across
      // should not have to learn a second name for the same dial.
      workers: workersFrom(process.env["WEB_CONCURRENCY"]),
    },
    showDetailedErrors: !production,
    forceSsl: production,
    rescueResponses: {},
    publicFileServer: true,
    healthCheck: true,
    forgeryProtection: env !== "test",
    // Development only, which is where Rails sets it and where the attack is
    // aimed. Test leaves it empty so a suite can call itself whatever it likes,
    // and production leaves it to the application — a server behind a load
    // balancer that already rejects unknown hosts does not need this, and one
    // that is not can say so.
    hosts: env === "development" ? ["localhost", "127.0.0.1", "[::1]", ".localhost", ".test"] : [],
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
