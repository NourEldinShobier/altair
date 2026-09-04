/**
 * A scaffolded resource, migrated, booted, and asked to do CRUD.
 *
 * The companion to generated-application.test.ts, and the same argument: the
 * scaffold writes a migration, a model and a controller that have to agree
 * with each other and with the framework, and nothing else in the suite runs
 * what it wrote.
 *
 * A column named in the migration and misspelled in the model, or a controller
 * calling a method that does not exist, is broken for every scaffolded
 * resource and for nobody else. This is the test that has to fail for that.
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

const write = async (path: string, contents: string) => {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  await Bun.write(full, contents);
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "altair-scaffold-"));

  for (const file of newApplication("shop")) await write(file.path, file.contents);

  // What `altair generate scaffold Post title:string published:boolean` writes.
  for (const file of generate("scaffold", "Post", ["title:string", "published:boolean"])) {
    await write(file.path, file.contents);
  }

  // The one step the generator leaves to the reader, so the test does what the
  // reader would.
  await write(
    "config/routes.ts",
    `import type { Mapper } from "@altair/router";

export default function routes(r: Mapper): void {
  r.resources("posts");
}
`,
  );

  await write(
    "bin/boot.ts",
    `import { createApplication } from "@altair/core";
import routes from "../config/routes.js";
import { PostsController } from "../app/controllers/posts_controller.js";
import { SchemaStatements } from "@altair/orm";


const app = createApplication({
  routes,
  controllers: { posts: PostsController },
  database: { url: "sqlite://:memory:" },
  log: { level: "fatal", format: "json", queries: false },
});

await app.boot();

// The scaffold's own migration, run through the schema it was written
// against. It exports a Migration as its default, which is the shape the
// migrator loads — so this is that shape and not an invention of the test.
const migration = (await import("../db/migrate/" + (await migrationName()) + ".js")).default;
await migration.up(new SchemaStatements(app.connection));

const server = await app.listen(0);
console.log("ready on " + server.port);

async function migrationName(): Promise<string> {
  const glob = new Bun.Glob("*.ts");
  for await (const file of glob.scan({ cwd: "db/migrate" })) return file.replace(/\\.ts$/, "");
  throw new Error("the scaffold wrote no migration");
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
    // A just-killed server can hold the directory for a moment on Windows.
  }
});

describe("a scaffolded resource", () => {
  it("migrates, boots, and answers every action", async () => {
    // The bun binary rather than the name. On Windows the name resolves to a
    // shim, so `Bun.spawn` starts the shim and the real bun is its child —
    // `kill()` then reaps the shim and leaves a server running, holding the
    // temporary directory the test is trying to remove. 206 of them had piled
    // up before anybody counted.
    const server = Bun.spawn([process.execPath, "run", join(root, "bin", "boot.ts")], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      const port = await portFrom(server.stdout, server.stderr);
      const url = (path = "") => `http://localhost:${port}/posts${path}`;

      // Nothing yet.
      expect(await (await fetch(url())).json()).toEqual([]);

      // Create.
      const created = await fetch(url(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ post: { title: "Hello", published: true } }),
      });

      expect(created.status).toBe(201);

      const post = (await created.json()) as { id: number; title: string };
      expect(post.title).toBe("Hello");

      // Read, one and many.
      expect(((await (await fetch(url(`/${post.id}`))).json()) as { title: string }).title).toBe(
        "Hello",
      );
      expect(await (await fetch(url())).json()).toHaveLength(1);

      // Update.
      const updated = await fetch(url(`/${post.id}`), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ post: { title: "Changed" } }),
      });

      expect(updated.status).toBe(200);
      expect(((await updated.json()) as { title: string }).title).toBe("Changed");

      // Destroy.
      expect((await fetch(url(`/${post.id}`), { method: "DELETE" })).status).toBe(204);
      expect(await (await fetch(url())).json()).toEqual([]);
    } finally {
      server.kill();
      await server.exited;
    }
  }, 45_000);
});

/** Reads the port off the server's own output, and says why if it never comes. */
async function portFrom(
  stdout: ReadableStream<Uint8Array>,
  stderr: ReadableStream<Uint8Array>,
): Promise<number> {
  const decoder = new TextDecoder();
  let seen = "";

  for await (const chunk of stdout) {
    seen += decoder.decode(chunk);

    const match = /ready on (\d+)/.exec(seen);
    if (match) return Number(match[1]);
  }

  const failure = await new Response(stderr).text();

  throw new Error(
    `The scaffolded application did not start.\n\nIt said: ${seen || "(nothing)"}\n\nAnd failed with:\n${failure}`,
  );
}
