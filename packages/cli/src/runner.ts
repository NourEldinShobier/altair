/**
 * `altair runner`, ported from Rails' `rails runner`.
 *
 * One-off work against a booted application: a backfill, a nightly cron entry,
 * a question about production data. The alternative is a console session
 * somebody has to sit through, which is not a thing cron can do.
 *
 *     altair runner script/backfill.ts
 *     altair runner -e 'import { Widget } from "./app/models/widget.js"
 *                       console.log(await Widget.count())'
 *
 * Rails can take bare code because Ruby autoloads the application's constants.
 * TypeScript has imports instead, so `-e` writes what it is given to a file at
 * the project root and imports that — which is what makes `./app/models/...`
 * in the snippet above resolve the way somebody standing in the project would
 * expect.
 */

import { unlink } from "node:fs/promises";
import { join } from "node:path";

export type RunnerTarget = { kind: "file"; path: string } | { kind: "code"; source: string };

/** What the arguments after `runner` are asking for. */
export function runnerTarget(args: readonly string[]): RunnerTarget {
  const [first, ...rest] = args;

  if (first === "-e" || first === "--eval") {
    const source = rest.join(" ");
    if (source.trim() === "") throw new Error("altair runner -e needs some code to run.");

    return { kind: "code", source };
  }

  if (first === undefined || first.startsWith("-")) {
    throw new Error("Usage: altair runner FILE, or altair runner -e 'code'");
  }

  return { kind: "file", path: first };
}

/**
 * Where a snippet is written so its relative imports resolve.
 *
 * The project root rather than `tmp/`, because somebody writing
 * `./app/models/widget.js` on the command line means it relative to where they
 * are standing.
 */
export function scratchPath(root: string, id: number | string): string {
  return join(root, `.altair-runner-${id}.ts`);
}

/**
 * Imports the target, and takes the scratch file away again afterwards.
 *
 * Deleted in a `finally`, so a snippet that throws does not leave a file at
 * the root of the project with somebody's code in it.
 */
export async function runTarget(
  target: RunnerTarget,
  root: string,
  importer: (path: string) => Promise<unknown> = (path) => import(path),
): Promise<void> {
  if (target.kind === "file") {
    await importer(Bun.pathToFileURL(join(root, target.path)).href);
    return;
  }

  const scratch = scratchPath(root, process.pid);
  await Bun.write(scratch, target.source);

  try {
    await importer(Bun.pathToFileURL(scratch).href);
  } finally {
    await unlink(scratch).catch(() => undefined);
  }
}
