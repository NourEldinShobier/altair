/**
 * Per-environment configuration and initializers, ported from Rails'
 * `config/environments/<env>.rb` and `config/initializers/*.rb`.
 *
 *     config/environments/production.ts   what changes in production
 *     config/initializers/storage.ts      run once, after boot
 *     db/seeds.ts                         `altair db:seed`
 *
 * Rails' arrangement, and it is a good one for a reason worth stating: the
 * difference between development and production is the part of a configuration
 * most likely to be wrong, and putting it in one file per environment makes
 * the difference readable instead of scattered through conditionals.
 *
 * Imported rather than autoloaded. Rails resolves these at runtime through
 * `const_missing`; a directory read and an `import` do the same job with
 * nothing to explain.
 */

import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildConfig,
  currentEnvironment,
  type ApplicationConfig,
  type Environment,
} from "./config.js";
import { Application, type ApplicationOptions } from "./application.js";

/**
 * What an environment file exports.
 *
 * A function when the settings depend on what the defaults worked out — the
 * root, say, or a port from the environment — and a plain object when they do
 * not, which is most of the time.
 */
export type EnvironmentModule =
  | Partial<ApplicationConfig>
  | ((
      defaults: ApplicationConfig,
    ) => Partial<ApplicationConfig> | Promise<Partial<ApplicationConfig>>);

/** What an initializer exports. */
export type Initializer = (app: Application) => void | Promise<void>;

const MODULE = /\.(ts|tsx|js|mjs)$/;

async function importDefault<T>(path: string): Promise<T | undefined> {
  const loaded = (await import(pathToFileURL(resolve(path)).href)) as { default?: T };
  return loaded.default;
}

/**
 * Reads `config/environments/<env>.ts`, if there is one.
 *
 * Absent is not an error. An application whose defaults suit it should not
 * have to write three files saying so.
 */
export async function loadEnvironmentConfig(
  root: string,
  env: Environment,
  defaults: ApplicationConfig,
): Promise<Partial<ApplicationConfig>> {
  for (const extension of ["ts", "tsx", "js", "mjs"]) {
    const path = join(root, "config", "environments", `${env}.${extension}`);
    if (!existsSync(path)) continue;

    const exported = await importDefault<EnvironmentModule>(path);
    if (exported === undefined) {
      throw new Error(
        `${path} has no default export. Export the settings for ${env}, or a function returning them.`,
      );
    }

    return typeof exported === "function" ? await exported(defaults) : exported;
  }

  return {};
}

/**
 * Reads `config/initializers`, in filename order.
 *
 * Order matters and is alphabetical, as it is in Rails: an initializer that
 * needs another to have run first is a real situation, and a number prefix is
 * the way people already solve it.
 */
export async function loadInitializers(root: string): Promise<Initializer[]> {
  const directory = join(root, "config", "initializers");
  if (!existsSync(directory)) return [];

  const files = readdirSync(directory)
    .filter((file) => MODULE.test(file))
    .sort();

  const initializers: Initializer[] = [];

  for (const file of files) {
    const exported = await importDefault<Initializer>(join(directory, file));

    if (typeof exported !== "function") {
      throw new Error(
        `config/initializers/${file} does not export a function. Export a default that takes the application.`,
      );
    }

    initializers.push(exported);
  }

  return initializers;
}

/**
 * Builds an application, layering the environment file over the defaults.
 *
 * The precedence is defaults, then the environment file, then what the caller
 * passed — nearest the call site wins, so a test that says
 * `{ database: { url: ":memory:" } }` gets it whatever `config/environments`
 * happens to say.
 */
export async function loadApplication(options: ApplicationOptions = {}): Promise<Application> {
  const env = options.env ?? currentEnvironment();
  const root = options.root ?? process.cwd();

  const { routes, controllers, providers, middleware, ...overrides } = options;
  const defaults = buildConfig({ ...overrides, env, root });
  const fromFile = await loadEnvironmentConfig(root, env, defaults);

  const application = new Application({
    ...fromFile,
    ...overrides,
    env,
    root,
    // Merged a level down as well, or naming one server setting in an
    // environment file would silently drop the others.
    database: { ...fromFile.database, ...overrides.database } as ApplicationConfig["database"],
    server: { ...fromFile.server, ...overrides.server } as ApplicationConfig["server"],
    log: { ...fromFile.log, ...overrides.log } as ApplicationConfig["log"],
    routes,
    controllers,
    providers,
    middleware,
  });

  application.initializers = await loadInitializers(root);

  return application;
}
