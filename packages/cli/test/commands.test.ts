/**
 * Command suite.
 *
 * Mirrors railties/test/commands/ and the db:migrate task tests. Commands
 * return strings, so these assert the output a person actually sees.
 */

import { sqlitePragmas } from "@altair/orm";
import { beforeEach, describe, expect, it } from "bun:test";
import { Connection, type Migration } from "@altair/orm";
import { Router } from "@altair/router";
import {
  generate,
  generateSecret,
  helpText,
  migrate,
  migrationStatus,
  newApplication,
  rollback,
  routesTable,
} from "../src/commands.js";
import { generateRichTextInstall, generateStorageInstall } from "../src/generators.js";

const NOW = new Date(Date.UTC(2026, 7, 22, 14, 30, 5));

const createPosts: Migration = {
  version: "20260101000001",
  name: "CreatePosts",
  up: async (schema) => schema.createTable("posts", (t) => t.string("title")),
  down: async (schema) => schema.dropTable("posts"),
};

const addSlug: Migration = {
  version: "20260101000002",
  name: "AddSlugToPosts",
  up: async (schema) => schema.addColumn("posts", "slug", "string"),
  down: async (schema) => schema.removeColumn("posts", "slug"),
};

let connection: Connection;

beforeEach(() => {
  connection = new Connection("sqlite://:memory:");
});

describe("routes", () => {
  it("lists routes in a readable table", () => {
    const router = new Router().draw((r) => r.resources("posts", { only: ["index", "show"] }));
    const output = routesTable(router);

    expect(output).toContain("Prefix");
    expect(output).toContain("Controller#Action");
    expect(output).toContain("posts GET");
    expect(output).toContain("/posts/:id");
    expect(output).toContain("posts#show");
  });

  it("aligns the columns", () => {
    const router = new Router().draw((r) => r.resources("posts"));
    const lines = routesTable(router).split("\n");

    // Every row's verb starts at the same column.
    const verbColumn = lines[1]!.indexOf("GET");
    for (const line of lines.slice(1)) {
      expect(line.slice(verbColumn)).toMatch(/^(GET|POST|PATCH|PUT|DELETE)/);
    }
  });

  it("says so when there are no routes", () => {
    expect(routesTable(new Router())).toBe("No routes defined.");
  });
});

describe("db:migrate", () => {
  it("runs pending migrations and names them", async () => {
    const result = await migrate(connection, [createPosts, addSlug]);

    expect(result.applied).toEqual([createPosts.version, addSlug.version]);
    expect(result.output).toContain("Migrating 2 migrations:");
    expect(result.output).toContain("20260101000001 CreatePosts");
  });

  it("reports when there is nothing to do", async () => {
    await migrate(connection, [createPosts]);
    const second = await migrate(connection, [createPosts]);

    expect(second.applied).toEqual([]);
    expect(second.output).toBe("Already up to date.");
  });

  it("uses the singular for one migration", async () => {
    const result = await migrate(connection, [createPosts]);
    expect(result.output).toContain("Migrating 1 migration:");
  });
});

describe("db:rollback", () => {
  it("reverts the last migration", async () => {
    await migrate(connection, [createPosts, addSlug]);
    const result = await rollback(connection, [createPosts, addSlug]);

    expect(result.applied).toEqual([addSlug.version]);
    expect(result.output).toContain("reverted  20260101000002");
  });

  it("reverts several steps", async () => {
    await migrate(connection, [createPosts, addSlug]);
    const result = await rollback(connection, [createPosts, addSlug], 2);

    expect(result.applied).toHaveLength(2);
  });

  it("reports when there is nothing to roll back", async () => {
    expect((await rollback(connection, [createPosts])).output).toBe("Nothing to roll back.");
  });
});

describe("db:status", () => {
  it("marks each migration up or down", async () => {
    await migrate(connection, [createPosts]);
    const output = await migrationStatus(connection, [createPosts, addSlug]);

    const [, applied, pending] = output.split("\n");
    expect(applied).toContain("up");
    expect(applied).toContain("20260101000001");
    expect(applied).toContain("CreatePosts");
    expect(pending).toContain("down");
    expect(pending).toContain("AddSlugToPosts");
  });

  it("says so when there are none", async () => {
    expect(await migrationStatus(connection, [])).toBe("No migrations found.");
  });
});

describe("generate", () => {
  it("produces a migration and a model for a model", () => {
    const files = generate("model", "Post", ["title:string"], { now: NOW });

    expect(files.map((file) => file.path)).toEqual([
      "db/migrate/20260822143005_create-posts.ts",
      "app/models/post.ts",
    ]);
  });

  it("produces a controller", () => {
    const files = generate("controller", "Posts", ["index", "show"]);

    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe("app/controllers/posts-controller.ts");
  });

  it("produces three files for a scaffold", () => {
    expect(generate("scaffold", "Post", ["title:string"], { now: NOW })).toHaveLength(3);
  });

  it("rejects an unknown generator", () => {
    expect(() => generate("widget", "Post")).toThrow('Unknown generator "widget"');
  });
});

describe("secret", () => {
  it("is long enough to use and different every time", () => {
    const secret = generateSecret();

    expect(secret.length).toBeGreaterThanOrEqual(64);
    expect(secret).not.toBe(generateSecret());
  });
});

describe("new", () => {
  const files = newApplication("Blog App");
  const at = (path: string) => files.find((file) => file.path === path);

  it("writes a runnable skeleton", () => {
    expect(files.map((file) => file.path).sort()).toEqual([
      ".env.example",
      ".gitignore",
      "app/assets/images/.gitkeep",
      "app/assets/stylesheets/.gitkeep",
      "app/channels/application-cable/channel.ts",
      "app/controllers/application-controller.ts",
      "app/controllers/concerns/.gitkeep",
      "app/controllers/home-controller.ts",
      "app/helpers/.gitkeep",
      "app/jobs/application-job.ts",
      "app/mailers/application-mailer.tsx",
      "app/models/application-record.ts",
      "app/models/concerns/.gitkeep",
      "app/views/layouts/application.tsx",
      "bin/altair.ts",
      "bin/server.ts",
      "config/console.ts",
      "config/environments/development.ts",
      "config/environments/production.ts",
      "config/environments/test.ts",
      "config/initializers/.gitkeep",
      "config/locales/en.json",
      "config/routes.ts",
      "db/.gitkeep",
      "db/migrate/.gitkeep",
      "db/seeds.ts",
      "lib/tasks/.gitkeep",
      "log/.gitkeep",
      "package.json",
      "public/404.html",
      "public/500.html",
      "public/robots.txt",
      "storage/.gitkeep",
      "test/.gitkeep",
      "tmp/.gitkeep",
      "tsconfig.json",
    ]);
  });

  // The previews the mailer generator writes, and the line that serves them.
  it("mounts the mailer previews", () => {
    expect(at("bin/server.ts")!.contents).toContain("await mountPreviews(app)");
  });

  it("normalizes the application name", () => {
    expect(at("package.json")!.contents).toContain('"name": "blog-app"');
  });

  it("wires the root route to a real controller", () => {
    expect(at("config/routes.ts")!.contents).toContain('r.root("home#index")');
    expect(at("app/controllers/home-controller.ts")!.contents).toContain("class HomeController");
    expect(at("bin/server.ts")!.contents).toContain("controllers: { home: HomeController }");
  });

  it("points tsconfig at the JSX runtime", () => {
    const tsconfig = JSON.parse(at("tsconfig.json")!.contents) as {
      compilerOptions: Record<string, unknown>;
    };

    expect(tsconfig.compilerOptions.jsxImportSource).toBe("@altair/view");
    expect(tsconfig.compilerOptions.strict).toBe(true);
  });

  // The secret must never be committed, and the example must not contain one.
  it("ships an env example with no secret in it", () => {
    expect(at(".env.example")!.contents).toContain("SECRET_KEY_BASE=\n");
    expect(at(".gitignore")!.contents).toContain(".env");
    expect(at(".gitignore")!.contents).toContain("!.env.example");
  });

  /**
   * A WAL database is three files, not one. `db/*.sqlite3` ignored the first
   * and left `-shm` and `-wal` to be staged by whoever ran `git add -A` — two
   * binary files, in the first commit of a new application.
   *
   * Tied to the pragma rather than to a list: if SQLite stops running in WAL
   * mode here, this stops demanding the two lines.
   */
  it("ignores the files a WAL database actually leaves on disk", () => {
    const journal = new Map(sqlitePragmas("sqlite://db/development.sqlite3")).get("journal_mode");
    const ignored = at(".gitignore")!.contents.split("\n");

    expect(ignored).toContain("db/*.sqlite3");

    if (journal === "WAL") {
      expect(ignored).toContain("db/*.sqlite3-shm");
      expect(ignored).toContain("db/*.sqlite3-wal");
    }
  });

  it("declares subpath imports so app code avoids relative paths", () => {
    expect(at("package.json")!.contents).toContain('"#models/*"');
    expect(at("package.json")!.contents).toContain('"#controllers/*"');
  });
});

describe("help", () => {
  it("lists every command", () => {
    const help = helpText();

    for (const command of ["new", "generate", "db:migrate", "db:rollback", "routes", "secret"]) {
      expect(help).toContain(command);
    }
  });
});

/**
 * The migrations Rails writes with `active_storage:install` and
 * `action_text:install`.
 *
 * Both sets of tables had a creator function in the framework and no way to
 * reach it from an application: an audit of a generated application found
 * `no such table: active_storage_blobs` the first time it attached a file.
 */
describe("install migrations", () => {
  const now = new Date("2026-01-02T03:04:05Z");

  it("write a migration rather than creating tables behind the application", () => {
    const file = generateStorageInstall(now);

    expect(file.path).toBe("db/migrate/20260102030405_create-active-storage-tables.ts");
    expect(file.contents).toContain('version: "20260102030405"');
  });

  // The shape of the tables stays defined in one place.
  it("call the framework's own installer", () => {
    expect(generateStorageInstall(now).contents).toContain(
      'import { createStorageTables } from "@altair/storage"',
    );
    expect(generateRichTextInstall(now).contents).toContain(
      'import { createRichTextTable } from "@altair/orm"',
    );
  });

  it("roll back", () => {
    const contents = generateStorageInstall(now).contents;

    expect(contents).toContain('dropTable("active_storage_blobs")');
    expect(contents).toContain('dropTable("active_storage_attachments")');
  });
});

/**
 * The features the framework ships are worth little if a new application does
 * not get them. Rails generates `allow_browser` in every ApplicationController
 * and query log tags in every development config, for the same reason.
 */
describe("what a new application starts with", () => {
  const files = newApplication("Blog App");
  const at = (path: string) => files.find((file) => file.path === path)?.contents ?? "";

  it("has an ApplicationController for everything else to inherit", () => {
    expect(at("app/controllers/application-controller.ts")).toContain(
      "export class ApplicationController extends Controller",
    );
  });

  it("turns away browsers too old to run it", () => {
    expect(at("app/controllers/application-controller.ts")).toContain(
      'this.allowBrowser({ versions: "modern" })',
    );
  });

  it("says how to relax that, since not every application wants it", () => {
    expect(at("app/controllers/application-controller.ts")).toContain("Remove this if you support");
  });

  /**
   * A controller that extends `Controller` directly gets none of the
   * application's own filters, which is how a rule meant to hold everywhere
   * quietly holds nowhere.
   */
  it("has its own controllers inherit from it", () => {
    expect(at("app/controllers/home-controller.ts")).toContain("extends ApplicationController");
    expect(at("app/controllers/home-controller.ts")).not.toContain("extends Controller");
  });

  it("tags SQL with the controller and action in development", () => {
    expect(at("config/environments/development.ts")).toContain("configureQueryLogs");
    expect(at("config/environments/development.ts")).toContain('"controller", "action"');
  });

  it("names the application in the tag", () => {
    expect(at("config/environments/development.ts")).toContain('application: "blog-app"');
  });

  it("leaves them off in production", () => {
    expect(at("config/environments/production.ts")).not.toContain("configureQueryLogs");
  });
});
