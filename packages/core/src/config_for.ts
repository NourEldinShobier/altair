/**
 * Per-environment settings from a YAML file, ported from Rails'
 * `Rails.application.config_for`.
 *
 *     # config/redis.yml
 *     shared:
 *       timeout: 5000
 *     development:
 *       url: redis://localhost:6379
 *     production:
 *       url: ${REDIS_URL}
 *       timeout: 1000
 *
 *     const redis = await configFor("redis")
 *     redis.url      // the current environment's
 *     redis.timeout  // 5000 in development, 1000 in production
 *
 * The `shared` section is the base and the environment's section is laid over
 * it, key by key rather than section by section — otherwise naming one setting
 * in `production` would silently drop every shared one beside it.
 */

import { currentEnvironment } from "@altair/support";
import type { Environment } from "./config.js";

/** Raised when the file is missing, unreadable, or not a mapping. */
export class ConfigFileError extends Error {
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`Could not read ${path}: ${reason}.`);
    this.name = "ConfigFileError";
  }
}

const SHARED = "shared";

export interface ConfigForOptions {
  /** Which section wins. Defaults to the application's environment. */
  env?: Environment | string;
  /** Where `config/` lives. Defaults to the application root. */
  root?: string;
  /** Values for `${...}`. Defaults to the process environment. */
  variables?: Record<string, string | undefined>;
}

/**
 * Substitutes `${VAR}` and `${VAR:-fallback}`.
 *
 * Rails runs these files through ERB, which is how `<%= ENV["REDIS_URL"] %>`
 * gets in. There is no ERB here and a template language is a lot to take on
 * for one job, so this does the part people actually use: a URL or a password
 * that must not be committed comes from the environment.
 *
 * A missing variable with no fallback is an error rather than an empty string.
 * A blank `url:` fails further away, on the first connection, and reads like
 * the service is down.
 */
export function interpolate(
  source: string,
  variables: Record<string, string | undefined> = process.env,
): string {
  return source.replaceAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name, fallback) => {
    const value = variables[name as string];

    if (value !== undefined) return value;
    if (fallback !== undefined) return fallback as string;

    throw new ConfigFileError(
      "the configuration",
      `it refers to \${${name}}, which is not set. Set it, or give it a default with \${${name}:-something}`,
    );
  });
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Lays one mapping over another, nested keys included.
 *
 * Its own rather than the merge in `i18n`, which mutates what it is given —
 * fine for building a catalog once, wrong for a function whose whole job is to
 * hand back a fresh answer each call.
 *
 * An array replaces rather than concatenates: `hosts: [a, b]` in an
 * environment means those hosts, not those plus the shared ones.
 */
function merged(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(over)) {
    const existing = out[key];

    out[key] = isMapping(existing) && isMapping(value) ? merged(existing, value) : value;
  }

  return out;
}

/**
 * Reads one config file for one environment.
 *
 * Returns the merged mapping. A file with no section for this environment is
 * not an error — it means the shared settings are all of them.
 */
export async function configFor(
  name: string,
  options: ConfigForOptions = {},
): Promise<Record<string, unknown>> {
  const root = options.root ?? process.cwd();
  const env = options.env ?? currentEnvironment();
  const path = `${root}/config/${name}.yml`;

  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new ConfigFileError(path, "the file does not exist");
  }

  const source = interpolate(await file.text(), options.variables);

  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(source);
  } catch (error) {
    throw new ConfigFileError(path, (error as Error).message);
  }

  // A file with `---` between sections parses as several documents. The first
  // is the configuration; anything after it is somebody's notes.
  const document = Array.isArray(parsed) ? parsed[0] : parsed;

  // An empty file parses to null, and no settings is a legitimate state.
  if (document === null || document === undefined) return {};

  if (!isMapping(document)) {
    throw new ConfigFileError(path, "it is not a mapping of environments to settings");
  }

  const shared = isMapping(document[SHARED]) ? document[SHARED] : {};
  const section = isMapping(document[env]) ? document[env] : {};

  // Deep, so naming one setting under an environment does not drop the shared
  // ones beside it.
  return merged(shared, section);
}
