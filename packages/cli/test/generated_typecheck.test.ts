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

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { newApplication } from "../src/commands.js";

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
  Bun.spawnSync(["bun", "run", join(root, "bin", "altair.ts"), ...args], { cwd: root, env: env() });

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
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Left for the OS to sweep.
  }
});

/**
 * Errors in the application's own files.
 *
 * `tsc` follows imports into the framework's source, and the framework does
 * not currently typecheck cleanly under the tsconfig this generator writes —
 * a real disagreement about which lib types are in scope, and a separate thing
 * to fix. This test is about the templates, so it reads only what `tsc` said
 * about the files the generator wrote.
 */
const applicationErrors = (output: string): string[] =>
  output
    .split("\n")
    .filter((line) => /^(app|config|db|bin)[\\/]/.test(line))
    .filter((line) => line.includes("error"));

describe("the generated application", () => {
  it("typechecks once it has been migrated", async () => {
    expect(
      altair("generate", "scaffold", "Post", "title:string", "published:boolean").exitCode,
    ).toBe(0);
    expect(altair("db:migrate").exitCode).toBe(0);

    const result = Bun.spawnSync(["bunx", "tsc", "--noEmit"], { cwd: root });
    const output = result.stdout.toString() + result.stderr.toString();

    expect(applicationErrors(output)).toEqual([]);
  }, 120_000);

  // The cost of taking types from the real schema rather than from the
  // migration: there is a window where the model names a type nothing has
  // written yet. Recorded rather than treated as a defect, because the
  // alternative is types that describe a schema the database may not have.
  it("names db/types until a migration writes it", async () => {
    altair("generate", "model", "Widget", "title:string");

    const result = Bun.spawnSync(["bunx", "tsc", "--noEmit"], { cwd: root });
    const output = result.stdout.toString() + result.stderr.toString();

    expect(output).toContain("#db/types");
  }, 120_000);
});
