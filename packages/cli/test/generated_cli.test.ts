/**
 * The CLI, run from inside a generated application.
 *
 * The fourth of these. Every command has unit tests; none of them had ever
 * been run the way a user runs them — through the binstub the generator
 * writes, against the files the generator wrote, in the directory it wrote
 * them into.
 *
 * That gap hid a plain one: `package.json` had scripts calling
 * `bin/altair.ts`, and the generator never wrote that file, so `bun run
 * db:migrate` failed in every new application on a file that was never there.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generate, newApplication } from "../src/commands.js";

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

const write = async (path: string, contents: string) => {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  await Bun.write(full, contents);
};

/** Runs the binstub the way `package.json` does. */
const altair = async (...args: string[]) => {
  const process_ = Bun.spawn(["bun", "run", join(root, "bin", "altair.ts"), ...args], {
    cwd: root,
    // Named explicitly because `bun test` sets NODE_ENV to test, and the test
    // environment's database is `:memory:` — which between two processes is no
    // database at all, so every command would see an empty one.
    env: { ...process.env, NODE_ENV: "development", ALTAIR_ENV: "development" },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr] = await Promise.all([
    new Response(process_.stdout).text(),
    new Response(process_.stderr).text(),
  ]);

  await process_.exited;

  return { code: process_.exitCode, stdout, stderr, output: stdout + stderr };
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "altair-cli-"));

  for (const file of newApplication("shop")) await write(file.path, file.contents);
  for (const file of generate("model", "Widget", ["title:string"])) {
    await write(file.path, file.contents);
  }

  await write(
    "config/routes.ts",
    `import type { Mapper } from "@altair/router";

export default function routes(r: Mapper): void {
  r.resources("widgets");
}
`,
  );

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

describe("the binstub", () => {
  // The bug this file exists for: the scripts called it and nothing wrote it.
  it("is written", async () => {
    expect(await Bun.file(join(root, "bin", "altair.ts")).exists()).toBe(true);
  });

  it("is what the scripts in package.json call", async () => {
    const manifest = (await Bun.file(join(root, "package.json")).json()) as {
      scripts: Record<string, string>;
    };

    for (const script of Object.values(manifest.scripts)) {
      if (!script.includes("bin/")) continue;

      const file = /bin\/[\w.-]+/.exec(script)?.[0];
      expect(await Bun.file(join(root, file as string)).exists()).toBe(true);
    }
  });
});

describe("altair routes", () => {
  it("lists what the application draws", async () => {
    const { code, output } = await altair("routes");

    expect(code).toBe(0);
    expect(output).toContain("widgets#index");
    expect(output).toContain("/widgets/:id");
  });
});

describe("altair db:migrate", () => {
  it("runs the migration the generator wrote", async () => {
    const { code, output } = await altair("db:migrate");

    expect(code).toBe(0);
    expect(output).toContain("CreateWidgets");
  });

  // The schema and the types are written from the database rather than from
  // the migration, so this is also a check that the migration reached it.
  it("writes the schema and the types beside it", async () => {
    await altair("db:migrate");

    expect(await Bun.file(join(root, "db", "schema.ts")).exists()).toBe(true);
    expect(await Bun.file(join(root, "db", "types.ts")).exists()).toBe(true);
  });

  it("says there is nothing to do the second time", async () => {
    await altair("db:migrate");
    const { output } = await altair("db:migrate");

    expect(output).toContain("Already up to date");
  });
});

describe("altair db:status", () => {
  it("reports a migration as up once it has run", async () => {
    await altair("db:migrate");
    const { code, output } = await altair("db:status");

    expect(code).toBe(0);
    expect(output).toContain("CreateWidgets");
    expect(output).toContain("up");
  });
});
