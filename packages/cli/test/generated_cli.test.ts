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

import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generate, newApplication } from "../src/commands.js";

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

const write = async (path: string, contents: string) => {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  await Bun.write(full, contents);
};

/** Runs the binstub the way `package.json` does. */
const altair = async (...args: string[]) => {
  // The bun binary rather than the name: on Windows the name resolves to a
  // shim, and Node refuses to hand a shim any argument with a shell character
  // in it — which is every argument `runner -e` exists to take.
  const process_ = Bun.spawn([process.execPath, "run", join(root, "bin", "altair.ts"), ...args], {
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

/**
 * `altair server`, and whether stopping it stops the server.
 *
 * It spawned "bun" by name, which on Windows is a shim: the CLI held the shim
 * and the real bun ran underneath it. Killing the CLI reaped the shim and left
 * the server running with the port still open — so the next `altair server`
 * met "address already in use" for a process nothing appeared to own.
 */
describe("altair server", () => {
  it("serves, and stops when it is stopped", async () => {
    await altair("db:migrate");

    const child = Bun.spawn([process.execPath, "run", join(root, "bin", "altair.ts"), "server"], {
      cwd: root,
      env: { ...process.env, PORT: "0", NODE_ENV: "development", ALTAIR_ENV: "development" },
      stdout: "pipe",
      stderr: "pipe",
    });

    let port = 0;

    try {
      port = await portFrom(child.stdout);
      expect(port).toBeGreaterThan(0);
      // robots.txt rather than `/`: this file's routes are only `widgets`, and
      // what is being checked is that something is answering at all.
      expect((await fetch(`http://localhost:${port}/robots.txt`)).status).toBe(200);
    } finally {
      child.kill();
      await child.exited;
    }

    // The real check: nothing is answering on that port any more. A survivor
    // would still be serving here, which is exactly what used to happen.
    await Bun.sleep(250);

    const after = await fetch(`http://localhost:${port}/robots.txt`).catch(() => null);
    expect(after).toBeNull();
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

/**
 * The point of `runner` is cron and backfills: work that has to reach the
 * application's models with nobody sitting at a prompt. So every case here
 * goes through the binstub, against the model the generator wrote, and
 * queries the database it migrated — testing the connection is open is
 * testing the only thing that makes this different from `bun run`.
 */
describe("altair runner", () => {
  it("runs a script against the application", async () => {
    await altair("db:migrate");
    await write(
      "script/count.ts",
      `import { Widget } from "../app/models/widget.js";

await Widget.create({ title: "one" });
console.log("widgets:", await Widget.count());
`,
    );

    const { code, output } = await altair("runner", "script/count.ts");

    expect(code).toBe(0);
    expect(output).toContain("widgets: 1");
  });

  // Rails takes bare code because Ruby autoloads. TypeScript imports, so the
  // snippet is written to the project root and the relative path in it has to
  // resolve from there.
  it("runs a snippet, with its imports resolving from the project", async () => {
    await altair("db:migrate");

    const { code, output } = await altair(
      "runner",
      "-e",
      'import { Widget } from "./app/models/widget.js"; console.log("count:", await Widget.count())',
    );

    expect(code).toBe(0);
    expect(output).toContain("count: 0");
  });

  it("does not leave the snippet behind", async () => {
    await altair("db:migrate");
    await altair("runner", "-e", 'console.log("hello")');

    const left = new Bun.Glob(".altair-runner-*.ts").scanSync({ cwd: root });
    expect([...left]).toEqual([]);
  });

  it("does not leave it behind when it throws either", async () => {
    await altair("db:migrate");
    const { code } = await altair("runner", "-e", 'throw new Error("nope")');

    expect(code).not.toBe(0);
    expect([...new Bun.Glob(".altair-runner-*.ts").scanSync({ cwd: root })]).toEqual([]);
  });

  it("says how to use it when given nothing", async () => {
    const { code, output } = await altair("runner");

    expect(code).toBe(1);
    expect(output).toContain("Usage: altair runner");
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

/** Reads the port off the server's own output rather than sleeping for it. */
async function portFrom(stdout: ReadableStream<Uint8Array>): Promise<number> {
  const decoder = new TextDecoder();
  const reader = stdout.getReader();
  const deadline = Date.now() + 30_000;
  let text = "";

  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;

    text += decoder.decode(value);
    const port = Number(/localhost:(\d+)/.exec(text)?.[1] ?? 0);
    if (port > 0) return port;
  }

  return 0;
}
