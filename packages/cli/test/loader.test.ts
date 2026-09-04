/**
 * File loading suite.
 *
 * Mirrors the parts of railties that discover an application's own files.
 * These write real files to a temporary directory, because the behaviour under
 * test is reading a directory.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadControllers, loadMigrations, loadModules } from "../src/loader.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "altair-loader-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(path: string, contents: string): Promise<void> {
  const target = join(root, path);
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, contents);
}

const MIGRATION = (body = "") => `
const migration = {
  up: async (schema) => { ${body} },
  down: async (schema) => {},
};
export default migration;
`;

describe("loadMigrations", () => {
  it("returns nothing when there is no directory", async () => {
    expect(await loadMigrations(join(root, "missing"))).toEqual([]);
  });

  it("loads migrations in version order", async () => {
    await write("db/migrate/20260101000002_second.ts", MIGRATION());
    await write("db/migrate/20260101000001_first.ts", MIGRATION());

    const migrations = await loadMigrations(join(root, "db/migrate"));

    expect(migrations.map((m) => m.version)).toEqual(["20260101000001", "20260101000002"]);
  });

  // The filename is the authority: renaming a file must not let a migration
  // re-run under a new version.
  it("takes the version from the filename", async () => {
    await write(
      "db/migrate/20260101000001_first.ts",
      `export default { version: "999", up: async () => {} };`,
    );

    const [migration] = await loadMigrations(join(root, "db/migrate"));
    expect(migration!.version).toBe("20260101000001");
  });

  it("names a migration after its file when it does not name itself", async () => {
    await write("db/migrate/20260101000001_create_posts.ts", MIGRATION());

    const [migration] = await loadMigrations(join(root, "db/migrate"));
    expect(migration!.name).toBe("create_posts");
    expect(migration!.file).toBe("20260101000001_create_posts.ts");
  });

  it("keeps a name the migration declares", async () => {
    await write(
      "db/migrate/20260101000001_x.ts",
      `export default { name: "CreatePosts", up: async () => {} };`,
    );

    const [migration] = await loadMigrations(join(root, "db/migrate"));
    expect(migration!.name).toBe("CreatePosts");
  });

  // Editors and tools leave files behind; that should not break a migrate run.
  it("ignores files that do not match the convention", async () => {
    await write("db/migrate/20260101000001_first.ts", MIGRATION());
    await write("db/migrate/notes.md", "scratch");
    await write("db/migrate/.DS_Store", "");

    expect(await loadMigrations(join(root, "db/migrate"))).toHaveLength(1);
  });

  it("explains a file that exports no migration", async () => {
    await write("db/migrate/20260101000001_broken.ts", `export const something = 1;`);

    await expect(loadMigrations(join(root, "db/migrate"))).rejects.toThrow(
      "does not export a migration",
    );
  });

  it("runs a loaded migration", async () => {
    await write("db/migrate/20260101000001_create_posts.ts", MIGRATION("void schema;"));

    const [migration] = await loadMigrations(join(root, "db/migrate"));
    await expect(migration!.up({} as never)).resolves.toBeUndefined();
  });
});

describe("loadModules", () => {
  it("keys modules by file name", async () => {
    await write("app/models/post.ts", `export const Post = class {};`);
    await write("app/models/user.ts", `export const User = class {};`);

    const modules = await loadModules(join(root, "app/models"));
    expect(Object.keys(modules).sort()).toEqual(["post", "user"]);
  });

  it("returns nothing when there is no directory", async () => {
    expect(await loadModules(join(root, "missing"))).toEqual({});
  });
});

describe("loadControllers", () => {
  it("keys controllers by the name a route uses", async () => {
    await write("app/controllers/posts-controller.ts", `export class PostsController {}`);
    await write("app/controllers/home-controller.ts", `export class HomeController {}`);

    const registry = await loadControllers(join(root, "app/controllers"));

    expect(Object.keys(registry).sort()).toEqual(["home", "posts"]);
    expect(typeof registry.posts).toBe("function");
  });

  it("accepts a default export", async () => {
    await write("app/controllers/posts-controller.ts", `export default class PostsController {}`);

    const registry = await loadControllers(join(root, "app/controllers"));
    expect(registry.posts).toBeDefined();
  });

  it("prefers the conventionally named export over another", async () => {
    await write(
      "app/controllers/posts-controller.ts",
      `export class Helper {}\nexport class PostsController { static marker = "right" }`,
    );

    const registry = await loadControllers(join(root, "app/controllers"));
    expect((registry.posts as { marker: string }).marker).toBe("right");
  });

  it("ignores a file exporting no class", async () => {
    await write("app/controllers/notes-controller.ts", `export const value = 1;`);

    const registry = await loadControllers(join(root, "app/controllers"));
    expect(registry.notes).toBeUndefined();
  });
});
