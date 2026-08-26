/**
 * The application `altair new` generates, booted and asked for a page.
 *
 * Mirrors what railties' application tests do: generate, boot, request.
 *
 * Every other test in this repository builds an application by calling
 * `createApplication` directly. This one runs the file the generator wrote, in
 * a directory laid out the way the generator laid it out, resolving the
 * packages the way an installed application resolves them — so the template
 * itself is under test rather than the framework it calls.
 *
 * That distinction has mattered before: a template that names a controller the
 * generator does not write, or imports a path the tsconfig does not map, is
 * broken for every new application and for nobody else.
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
];

let root: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "altair-new-app-"));

  for (const file of newApplication("myapp")) {
    const path = join(root, file.path);
    mkdirSync(dirname(path), { recursive: true });
    await Bun.write(path, file.contents);
  }

  // What `bun install` would do. A junction on Windows and a symlink
  // elsewhere; Node ignores the type argument off Windows.
  mkdirSync(join(root, "node_modules", "@altair"), { recursive: true });

  const workspace = join(import.meta.dir, "..", "..");

  for (const name of PACKAGES) {
    symlinkSync(join(workspace, name), join(root, "node_modules", "@altair", name), "junction");
  }
});

afterEach(() => {
  // Tolerated rather than asserted. A server that has just been killed can
  // still hold its directory for a moment on Windows, and a temporary
  // directory left behind is the operating system's problem — failing the
  // suite over one would report a cleanup as a broken application.
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Left for the OS to sweep.
  }
});

describe("the generated application", () => {
  it("has the files a new application needs", async () => {
    for (const path of [
      "package.json",
      "tsconfig.json",
      "config/routes.ts",
      "bin/server.ts",
      "app/controllers/home_controller.ts",
    ]) {
      expect(await Bun.file(join(root, path)).exists()).toBe(true);
    }
  });

  // The part no unit test reaches: the template's own imports, resolved from
  // the directory it was written into.
  it("boots and answers a request", async () => {
    const server = Bun.spawn(["bun", "run", join(root, "bin", "server.ts")], {
      cwd: root,
      env: { ...process.env, PORT: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      const port = await portFrom(server.stdout, server.stderr);

      expect(port).toBeGreaterThan(0);

      const response = await fetch(`http://localhost:${port}/`);

      expect(response.status).toBe(200);
      expect(await response.text()).not.toBe("");

      // The static file server is in the default stack, and this is the only
      // way to find out whether it is reachable from a real request. It was
      // written, tested, documented, and never added to the stack — so a new
      // application could not serve its own favicon.
      const robots = await fetch(`http://localhost:${port}/robots.txt`);

      expect(robots.status).toBe(200);
      expect(await robots.text()).toContain("User-agent");

      // A path with nothing behind it is still the application's 404, not the
      // file server swallowing it.
      expect((await fetch(`http://localhost:${port}/nothing.txt`)).status).toBe(404);

      // Percent-encoded, because `fetch` collapses a plain `../` before the
      // request is ever sent — so the unencoded form would prove nothing about
      // the server. This one arrives at it intact.
      const escape = await fetch(`http://localhost:${port}/%2e%2e/%2e%2e/package.json`);

      expect(escape.status).toBe(404);
    } finally {
      server.kill();
      // Waited for, so the directory is not still held when cleanup runs.
      await server.exited;
    }
  }, 30_000);
});

/**
 * Reads the port off the server's own output.
 *
 * Waiting for the line it prints rather than sleeping: a fixed pause is either
 * longer than the boot takes or shorter than it takes on a loaded machine, and
 * this file has already been the slowest thing in the suite once.
 */
async function portFrom(
  stdout: ReadableStream<Uint8Array>,
  stderr: ReadableStream<Uint8Array>,
): Promise<number> {
  const decoder = new TextDecoder();
  let seen = "";

  for await (const chunk of stdout) {
    seen += decoder.decode(chunk);

    const match = /http:\/\/localhost:(\d+)/.exec(seen);
    if (match) return Number(match[1]);
  }

  // Whatever went wrong is on stderr, and a test that reports only "it never
  // started" leaves the reader to reproduce it by hand to find out why.
  const failure = await new Response(stderr).text();

  throw new Error(
    `The generated application did not start.

It said: ${seen || "(nothing)"}

And failed with:
${failure}`,
  );
}
