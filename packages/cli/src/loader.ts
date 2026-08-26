/**
 * Loading an application's own files, ported from `Rails::Application` boot.
 *
 * Rails autoloads by convention. We import by convention instead, which is the
 * same idea without runtime const_missing: the CLI walks the conventional
 * directories and imports what it finds.
 */

import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Migration } from "@altair/orm";

/** Rails names migrations `<version>_<name>.rb`; we use `.ts`. */
const MIGRATION_FILE = /^(\d+)_([\w-]+)\.(ts|js)$/;

export interface LoadedMigration extends Migration {
  /** Where it came from, so an error can name the file. */
  file: string;
}

/**
 * Reads migrations from a directory, in version order.
 *
 * A file whose name does not match the convention is skipped rather than
 * failing the run, because editors and tools leave things in directories.
 */
export async function loadMigrations(directory: string): Promise<LoadedMigration[]> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    // No migrations directory is not an error; it means no migrations.
    return [];
  }

  const files = entries.filter((entry) => MIGRATION_FILE.test(entry)).sort();
  const migrations: LoadedMigration[] = [];

  for (const file of files) {
    const path = resolve(join(directory, file));
    const loaded = (await import(pathToFileURL(path).href)) as {
      default?: Migration;
      migration?: Migration;
    };

    const migration = loaded.default ?? loaded.migration;
    if (!migration || typeof migration.up !== "function") {
      throw new Error(
        `${file} does not export a migration. Export one as the default, with up() and optionally down().`,
      );
    }

    const [, version, name] = MIGRATION_FILE.exec(file)!;

    // The filename is the authority on version, so renaming a file cannot
    // silently re-run a migration that already applied under another version.
    migrations.push({
      ...migration,
      version: version!,
      name: migration.name ?? name,
      file,
    });
  }

  assertVersionsUnique(migrations);

  return migrations;
}

/**
 * Refuses two migrations that claim the same version.
 *
 * Without this the database is what notices, and what it says is
 * `UNIQUE constraint failed: schema_migrations.version` — which names neither
 * file, and arrives after the first migration has already run. Two files
 * generated in the same second is all it takes.
 */
function assertVersionsUnique(migrations: LoadedMigration[]): void {
  const seen = new Map<string, string>();

  for (const migration of migrations) {
    const first = seen.get(migration.version);

    if (first) {
      throw new Error(
        `Two migrations claim version ${migration.version}: ${first} and ${migration.file}. Rename one — the version is the part before the underscore.`,
      );
    }

    seen.set(migration.version, migration.file);
  }
}

/** Reads a directory of modules and returns their exports, keyed by file name. */
export async function loadModules(directory: string): Promise<Record<string, unknown>> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return {};
  }

  const modules: Record<string, unknown> = {};

  for (const file of entries.filter((entry) => /\.(ts|tsx|js)$/.test(entry))) {
    const path = resolve(join(directory, file));
    modules[file.replace(/\.\w+$/, "")] = await import(pathToFileURL(path).href);
  }

  return modules;
}

/**
 * Builds the controller registry a route table expects.
 *
 * A route carries `posts`, and the file is `posts_controller.ts` exporting
 * `PostsController` — the same convention Rails resolves at runtime, resolved
 * here by reading the directory.
 */
export async function loadControllers(directory: string): Promise<Record<string, unknown>> {
  const modules = await loadModules(directory);
  const registry: Record<string, unknown> = {};

  for (const [name, module] of Object.entries(modules)) {
    const routeName = name.replace(/_controller$/, "");
    const exported = module as Record<string, unknown>;

    // Prefer the conventional export name, then a default, then the only class.
    const candidates = Object.entries(exported).filter(
      ([key, value]) => typeof value === "function" && key !== "default",
    );

    const chosen =
      exported.default ??
      candidates.find(([key]) => key.toLowerCase().endsWith("controller"))?.[1] ??
      candidates[0]?.[1];

    if (chosen) registry[routeName] = chosen;
  }

  return registry;
}
