/**
 * Whether a generated application can reach the framework at all.
 *
 * Written after an audit that asked the question of a booted application
 * rather than of the source, and got two answers back that no unit test could
 * have given:
 *
 *     mailer.deliver  No delivery method configured.
 *     job.enqueue     No queue adapter configured.
 *
 * Both subsystems had generators, both had passing tests, and neither worked
 * in an application the generator had just written. That is the shape this
 * file exists to catch: not "does the mailer build a message", which was
 * always true, but "can the application this framework generates send one".
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

const run = async (...args: string[]) => {
  const child = Bun.spawn([process.execPath, "run", join(root, "bin", "altair.ts"), ...args], {
    cwd: root,
    env: { ...process.env, NODE_ENV: "development", ALTAIR_ENV: "development" },
    stdout: "pipe",
    stderr: "pipe",
  });

  await child.exited;
  return child.exitCode;
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "altair-subsystems-"));

  for (const file of newApplication("shop")) await write(file.path, file.contents);
  for (const file of generate("scaffold", "Widget", ["title:string"])) {
    await write(file.path, file.contents);
  }
  for (const file of generate("mailer", "Notifier", ["welcome"]))
    await write(file.path, file.contents);
  for (const file of generate("job", "Cleanup")) await write(file.path, file.contents);

  mkdirSync(join(root, "node_modules", "@altair"), { recursive: true });
  const workspace = join(import.meta.dir, "..", "..");

  for (const name of PACKAGES) {
    symlinkSync(join(workspace, name), join(root, "node_modules", "@altair", name), "junction");
  }

  await write(
    "config/routes.ts",
    `import type { Mapper } from "@altair/router";

export default function routes(r: Mapper): void {
  r.root("home#index");
}
`,
  );

  /**
   * A page that uses each subsystem and reports what threw.
   *
   * Reporting rather than failing, so one broken subsystem does not hide the
   * state of the others — the first run of this had two failures and would
   * only have shown one.
   */
  await write(
    "app/controllers/home_controller.ts",
    `import { Controller } from "@altair/controller";
import { NotifierMailer } from "#mailers/notifier_mailer";
import { CleanupJob } from "#jobs/cleanup_job";
import { Widget } from "#models/widget";

export class HomeController extends Controller {
  async index() {
    const report: Record<string, string> = {};

    const probe = async (name: string, body: () => unknown) => {
      try {
        await body();
        report[name] = "ok";
      } catch (error) {
        report[name] = String((error as Error).message).slice(0, 200);
      }
    };

    await probe("orm", async () => {
      await Widget.create({ title: "a widget" });
    });
    await probe("mailer.build", async () => {
      await NotifierMailer.welcome("someone@example.com");
    });
    await probe("mailer.deliver", async () => {
      await (await NotifierMailer.welcome("someone@example.com")).deliverNow();
    });
    await probe("job.enqueue", async () => {
      await CleanupJob.performLater(1);
    });
    await probe("session", () => this.session.set("k", "v"));
    await probe("flash", () => this.flash.set("notice", "hi"));
    await probe("csrf", () => void this.csrfToken);

    return this.render.json(report);
  }
}
`,
  );

  await run("db:migrate");
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Left for the OS to sweep.
  }
});

describe("the subsystems a generated application uses", () => {
  it("all work without being configured first", async () => {
    const server = Bun.spawn([process.execPath, "run", join(root, "bin", "server.ts")], {
      cwd: root,
      env: { ...process.env, PORT: "0", NODE_ENV: "development", ALTAIR_ENV: "development" },
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      const port = await portFrom(server.stdout);
      expect(port).toBeGreaterThan(0);

      const report = (await (await fetch(`http://localhost:${port}/`)).json()) as Record<
        string,
        string
      >;

      // Asserted as a whole, so a message says which subsystem broke and how.
      expect(report).toEqual({
        orm: "ok",
        "mailer.build": "ok",
        "mailer.deliver": "ok",
        "job.enqueue": "ok",
        session: "ok",
        flash: "ok",
        csrf: "ok",
      });
    } finally {
      server.kill();
      await server.exited;
    }
  }, 30_000);
});

/** Reads the port off the server's own output rather than sleeping for it. */
async function portFrom(stdout: ReadableStream<Uint8Array>): Promise<number> {
  const decoder = new TextDecoder();
  const reader = stdout.getReader();
  const deadline = Date.now() + 20_000;
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
