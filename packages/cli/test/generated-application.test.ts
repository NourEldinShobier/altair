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
];

let root: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "altair-new-app-"));

  // A channel too, so there is something for the cable to serve.
  for (const file of [...newApplication("myapp"), ...generate("channel", "Room")]) {
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
  removeApplication(root);
});

/**
 * Removes the temporary application, and says so when it cannot.
 *
 * This used to swallow the failure as "the operating system's problem". It was
 * not: the server was still running and holding the directory, because the
 * test spawned `bun` by name and killed the Windows shim instead of the bun
 * behind it. 205 servers and 404 directories had accumulated before anybody
 * counted them, and the machine got flakier the longer the suite ran.
 *
 * A short retry, because a just-killed process can hold a handle for a moment.
 * Then a failure, because a directory that will not go is a process that will
 * not stop.
 */
function removeApplication(path: string): void {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch {
      Bun.sleepSync(50);
    }
  }

  rmSync(path, { recursive: true, force: true });
}

describe("the generated application", () => {
  it("has the files a new application needs", async () => {
    for (const path of [
      "package.json",
      "tsconfig.json",
      "config/routes.ts",
      "bin/server.ts",
      "app/controllers/home-controller.ts",
    ]) {
      expect(await Bun.file(join(root, path)).exists()).toBe(true);
    }
  });

  // The part no unit test reaches: the template's own imports, resolved from
  // the directory it was written into.
  it("boots and answers a request", async () => {
    // The bun binary rather than the name. On Windows the name resolves to a
    // shim, so `Bun.spawn` starts the shim and the real bun is its child —
    // `kill()` then reaps the shim and leaves a server running, holding the
    // temporary directory the test is trying to remove. 206 of them had piled
    // up before anybody counted.
    const server = Bun.spawn([process.execPath, "run", join(root, "bin", "server.ts")], {
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
      const missing = await fetch(`http://localhost:${port}/nothing.txt`);
      expect(missing.status).toBe(404);

      // And it is the page the generator wrote, not a line of plain text —
      // which is the whole reason that file exists.
      // The page the generator wrote, not a line of plain text — and not the
      // bare `new Response("Not Found")` the dispatcher used to send, which
      // carries no content-type in Bun at all, so a browser offered to
      // download the words "Not Found" as a file.
      expect(missing.headers.get("content-type")).toContain("text/html");
      expect(await missing.text()).toContain("Page not found");

      // Rails generates `/up`, and this stack already assumed it existed —
      // `hostAuthorization` excludes that path so a load balancer checking by
      // IP is not turned away. Nothing answered it, so every application
      // reported itself unreachable to whatever was watching.
      const health = await fetch(`http://localhost:${port}/up`);

      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: "ok" });
      // A cached health check is a load balancer reading a reply from before
      // the thing it is checking broke.
      expect(health.headers.get("cache-control")).toContain("no-store");

      // A generated channel used to be a class nothing served: no cable was
      // mounted, so it could not receive a connection however correct it was.
      // The only way to find that out is to open one.
      const frames = await subscribeTo(`ws://localhost:${port}/cable`, "RoomChannel");

      expect(JSON.parse(frames[0] as string)).toEqual({ type: "welcome" });
      expect(JSON.parse(frames[1] as string).type).toBe("confirm_subscription");

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

/** Opens a cable, subscribes, and answers the first two frames it is sent. */
async function subscribeTo(url: string, channel: string): Promise<string[]> {
  // An Origin, as a browser sends: the cable refuses a handshake without one,
  // which is what stops another site opening a socket carrying this user's
  // cookies. A generated application is same-origin, so its own host is it.
  const socket = new WebSocket(url, {
    headers: { origin: new URL(url).origin.replace(/^ws/, "http") },
  });
  const frames: string[] = [];

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the cable never answered")), 15_000);

    socket.addEventListener("message", (event) => {
      frames.push(String(event.data));

      // The welcome comes first, unasked; the subscription is answered second.
      if (frames.length === 1) {
        socket.send(
          JSON.stringify({ command: "subscribe", identifier: JSON.stringify({ channel }) }),
        );
        return;
      }

      clearTimeout(timer);
      socket.close();
      resolve();
    });

    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("the cable refused the connection"));
    });
  });

  return frames;
}
