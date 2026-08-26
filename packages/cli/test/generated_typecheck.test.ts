/**
 * The generated application, typechecked where it was generated.
 *
 * The fifth of these. `tsc` in this repository sees the templates as strings;
 * nothing has ever compiled the files they become, under the tsconfig the
 * generator writes, with the imports resolved the way the application resolves
 * them.
 *
 * The order matters and is the point: a model's attributes come from
 * `db/types.ts`, which `db:migrate` writes from the real schema. So the
 * application typechecks *after* a migration and not before, which is what
 * "types from reality" costs and is worth having written down.
 */

import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { newApplication } from "../src/commands.js";

/**
 * These spawn `bun` — a generator, a migration, a server — so they are bounded
 * by process startup rather than by anything this file does. Bun's default is
 * five seconds, which is comfortable on an idle machine and not comfortable
 * when the rest of the suite is running beside it: the failure moved between
 * tests from run to run, which is what a shared timeout looks like rather than
 * a broken test.
 */
setDefaultTimeout(60_000);

const PACKAGES = [
  "core",
  "controller",
  "orm",
  "router",
  "support",
  "view",
  "jobs",
  "mailer",
  "cable",
  "storage",
  "testing",
  "cli",
];

let root: string;

const env = () => ({ ...process.env, NODE_ENV: "development", ALTAIR_ENV: "development" });

const altair = (...args: string[]) =>
  Bun.spawnSync([process.execPath, "run", join(root, "bin", "altair.ts"), ...args], {
    cwd: root,
    env: env(),
  });

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "altair-typecheck-"));

  for (const file of newApplication("shop")) {
    const path = join(root, file.path);
    mkdirSync(dirname(path), { recursive: true });
    await Bun.write(path, file.contents);
  }

  mkdirSync(join(root, "node_modules", "@altair"), { recursive: true });
  const workspace = join(import.meta.dir, "..", "..");

  for (const name of PACKAGES) {
    symlinkSync(join(workspace, name), join(root, "node_modules", "@altair", name), "junction");
  }

  // What `bun install` would fetch for the types the tsconfig names. Missing
  // here, the compiler stops at "Cannot find type definition file for 'bun'"
  // and never reaches the application's own files — which is how this test
  // passed on one machine and reported the wrong thing on another.
  const root_ = join(import.meta.dir, "..", "..", "..");
  mkdirSync(join(root, "node_modules", "@types"), { recursive: true });
  symlinkSync(
    join(root_, "node_modules", "@types", "bun"),
    join(root, "node_modules", "@types", "bun"),
    "junction",
  );
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Left for the OS to sweep.
  }
});

/**
 * Runs the compiler this repository already depends on.
 *
 * `bunx tsc` resolved on one machine and not on CI, where it produced no
 * output at all — and no output reads as no errors, so the test asserting "no
 * errors in the application's files" passed while compiling nothing. The path
 * is taken from the workspace, so there is one compiler and it is present.
 */
function typecheck(): { output: string; code: number | null } {
  const compiler = join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "node_modules",
    "typescript",
    "bin",
    "tsc",
  );

  const result = Bun.spawnSync([process.execPath, "run", compiler, "--noEmit"], { cwd: root });
  const output = result.stdout.toString() + result.stderr.toString();

  // A compiler that never ran exits non-zero and says nothing — which is
  // indistinguishable from a clean run unless somebody checks. On CI `bunx
  // tsc` did exactly that, and the assertion below passed against no output
  // at all.
  if (result.exitCode !== 0 && output.trim() === "") {
    throw new Error(`The compiler produced no output and exited ${result.exitCode}.`);
  }

  return { output, code: result.exitCode };
}

describe("the generated application", () => {
  it("typechecks once it has been migrated", async () => {
    expect(
      altair("generate", "scaffold", "Post", "title:string", "published:boolean").exitCode,
    ).toBe(0);
    expect(altair("db:migrate").exitCode).toBe(0);

    const { output, code } = typecheck();

    // The exit code first: a compiler that never ran says nothing, and nothing
    // is exactly what "no errors" looks like. Zero means it compiled and was
    // happy; anything else has to be explained by the errors below.
    // Everything, not only the application's own files. `tsc` follows imports
    // into the framework, and the framework has to typecheck inside the
    // application that installed it — which it did not until the generated
    // tsconfig stopped pulling in the DOM library.
    expect(output.trim()).toBe("");
    expect(code).toBe(0);
  }, 120_000);

  // The cost of taking types from the real schema rather than from the
  // migration: there is a window where the model names a type nothing has
  // written yet. Recorded rather than treated as a defect, because the
  // alternative is types that describe a schema the database may not have.
  it("names db/types until a migration writes it", async () => {
    // Asserted, because a generate that quietly failed leaves nothing
    // importing `#db/types` — and then the assertion below fails for a reason
    // that has nothing to do with what it is testing. That is what it did on
    // CI while passing here.
    const generated = altair("generate", "model", "Widget", "title:string");

    expect({ code: generated.exitCode, output: generated.stderr.toString() }).toMatchObject({
      code: 0,
    });

    const { output, code } = typecheck();

    expect(code).not.toBe(0);
    expect(output).toContain("#db/types");
  }, 120_000);
});
