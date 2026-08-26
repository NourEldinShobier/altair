/**
 * Putting an application's mailer previews on a URL.
 *
 * `servePreviews` was written and tested and needed a `PreviewSet` that an
 * application had to assemble and mount itself — which is to say the previews
 * existed and nobody could look at one. Rails mounts them at `/rails/mailers`
 * without being asked.
 *
 *     await mountPreviews(app)
 *
 * Previews come from `test/mailers/previews`, where Rails keeps them, so a
 * mailer generated tomorrow is on the index without anything being wired up.
 */

import { Glob } from "bun";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { servePreviews, type PreviewOptions, type PreviewSet } from "./preview.js";

/** The part of an application this needs, so mailer need not depend on core. */
export interface MiddlewareHost {
  middleware: {
    use(
      name: string,
      middleware: (
        request: Request,
        next: (request: Request) => Promise<Response>,
      ) => Promise<Response>,
    ): unknown;
  };
}

export interface MountPreviewOptions extends PreviewOptions {
  /** Where to look. Defaults to the working directory. */
  root?: string;
}

/**
 * Collects every preview under `test/mailers/previews`.
 *
 * A module's default export is a `PreviewSet`, as `definePreviews` returns.
 * The file name prefixes the names, so two mailers can both have a "welcome"
 * without one hiding the other.
 */
export async function loadPreviews(root: string): Promise<PreviewSet> {
  const directory = join(root, "test", "mailers", "previews");
  const previews: PreviewSet = {};

  // No previews written yet is the ordinary state of a new application, and
  // `Glob.scan` reports a missing directory as an error rather than as none.
  if (!existsSync(directory)) return previews;

  for await (const file of new Glob("**/*.{ts,tsx}").scan({ cwd: directory, onlyFiles: true })) {
    const module = (await import(Bun.pathToFileURL(join(directory, file)).href)) as {
      default?: PreviewSet;
    };

    if (!module.default) continue;

    const prefix = file.replace(/\.[jt]sx?$/, "").replaceAll(/[\\|/]/g, " ");

    for (const [name, preview] of Object.entries(module.default)) {
      previews[`${prefix} ${name}`] = preview;
    }
  }

  return previews;
}

/** Mounts the previews, and answers their names. */
export async function mountPreviews(
  app: MiddlewareHost,
  options: MountPreviewOptions = {},
): Promise<string[]> {
  const previews = await loadPreviews(options.root ?? process.cwd());

  app.middleware.use("mailerPreviews", servePreviews(previews, options));

  return Object.keys(previews).sort();
}
