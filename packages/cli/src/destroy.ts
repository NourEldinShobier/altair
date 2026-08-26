/**
 * `altair destroy`, the other half of `altair generate`.
 *
 * A generator writes half a dozen files across four directories. Getting the
 * name wrong — a plural where a singular belonged, a typo — left every one of
 * them behind, and finding them again meant remembering what the generator
 * had done. Rails has had `rails destroy` since the beginning for that reason.
 *
 *     altair destroy model Widget
 *
 * It asks the generator what it would write and removes exactly that, rather
 * than keeping its own list. A list would drift the first time a generator
 * gained a file — and it did gain one today, when the mailer started writing a
 * preview.
 */

import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { generate } from "./commands.js";
import { loadMigrations } from "./loader.js";

export interface Removal {
  path: string;
  /** Whether it was there to remove. */
  removed: boolean;
}

/**
 * A migration's version is the time it was generated, so asking the generator
 * again produces a different name than the one on disk. This finds the file by
 * what follows the version instead.
 */
async function migrationOnDisk(root: string, generatedPath: string): Promise<string | undefined> {
  const suffix = /^db\/migrate\/\d+_(.+)$/.exec(generatedPath)?.[1];
  if (!suffix) return undefined;

  const migrations = await loadMigrations(join(root, "db", "migrate")).catch(() => []);
  const found = migrations.find((migration) => migration.file.endsWith(`_${suffix}`));

  return found && `db/migrate/${found.file}`;
}

/**
 * Removes what `generate` would have written, and says what it did.
 *
 * Reports rather than removes silently: a file that was not there is worth
 * knowing about, because it usually means the name was different from the one
 * being typed now.
 */
export async function destroy(
  kind: string,
  name: string,
  fieldArgs: string[] = [],
  root: string = process.cwd(),
): Promise<Removal[]> {
  const removals: Removal[] = [];

  for (const file of generate(kind, name, fieldArgs)) {
    const path = (await migrationOnDisk(root, file.path)) ?? file.path;
    const target = join(root, path);
    const existed = await Bun.file(target).exists();

    if (existed) await rm(target, { force: true });

    removals.push({ path, removed: existed });

    // The directory the generator made, if this was the last thing in it.
    // Left behind, an empty app/mailers is a directory the next `ls` has to
    // explain.
    if (existed) await rm(dirname(target), { recursive: false }).catch(() => undefined);
  }

  return removals;
}
