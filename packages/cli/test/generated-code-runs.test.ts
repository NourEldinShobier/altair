/**
 * Everything the generators write, run where they write it.
 *
 * The third of these. `generated_application` boots what `altair new` writes
 * and `generated_scaffold` drives the scaffold's CRUD; this one covers the
 * rest — model, controller, mailer, job, channel — by generating them into an
 * application and running the suite that lands beside them.
 *
 * The mailer and job generators write tests of their own, and until now
 * nothing ran those either: a generated test that does not parse is shipped to
 * every application that asks for a mailer.
 */

import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generate, newApplication } from "../src/commands.js";
import { assertActionName } from "../src/generators.js";

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
];

let root: string;

const write = async (path: string, contents: string) => {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  await Bun.write(full, contents);
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "altair-generators-"));

  for (const file of newApplication("shop")) await write(file.path, file.contents);

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

describe("what the generators write", () => {
  it("parses, imports and runs", async () => {
    for (const [kind, name, args] of [
      ["model", "Widget", ["title:string", "price:integer"]],
      ["controller", "Pages", ["index", "about"]],
      ["mailer", "User", ["welcome", "reset"]],
      ["job", "Cleanup", []],
      ["channel", "Room", []],
    ] as [string, string, string[]][]) {
      for (const file of generate(kind, name, args)) await write(file.path, file.contents);
    }

    // Runs the generated tests, which is what the mailer and job generators
    // write and what nothing has ever executed.
    const result = await Bun.spawn([process.execPath, "test"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [out, err] = await Promise.all([
      new Response(result.stdout).text(),
      new Response(result.stderr).text(),
    ]);

    await result.exited;

    expect(`${out}${err}`).not.toContain("error:");
    expect(result.exitCode).toBe(0);
  }, 60_000);
});

/**
 * `altair generate mailer User title:string` is a plausible slip — it is
 * exactly the shape the model generator wants — and the name went straight
 * into the generated source, which then did not parse:
 *
 *     const message = await UserMailer.title:string("someone@example.com")
 *
 * Found by running the generated tests rather than by reading the template.
 */
describe("a name a method cannot have", () => {
  it("is refused rather than written into a file", () => {
    expect(() => generate("mailer", "User", ["title:string"])).toThrow();
    expect(() => generate("controller", "Pages", ["a-b"])).toThrow();
  });

  it("says what the argument was meant to be", () => {
    expect(() => assertActionName("title:string", "mailer")).toThrow(/method names, not columns/);
    expect(() => assertActionName("title:string", "mailer")).toThrow(/did you mean/);
  });

  it("still takes the names people mean", () => {
    for (const name of ["welcome", "reset_password", "$special", "_private", "index2"]) {
      expect(() => assertActionName(name, "mailer")).not.toThrow();
    }
  });

  it("leaves a generator with no arguments alone", () => {
    expect(() => generate("mailer", "User", [])).not.toThrow();
    expect(() => generate("controller", "Pages", [])).not.toThrow();
  });
});
