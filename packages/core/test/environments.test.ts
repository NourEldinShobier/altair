/**
 * Per-environment configuration and initializers.
 *
 * Mirrors railties/test/application/configuration_test.rb and
 * initializers_test.rb. Real files in a temporary directory and real dynamic
 * imports: this is a feature about loading files, and a stub would test the
 * stub.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadApplication,
  loadEnvironmentConfig,
  loadInitializers,
  buildConfig,
  type Application,
} from "../src/index.js";

const SECRET = "x".repeat(64);

let root: string;
let running: Application | undefined;

const quiet = { level: "fatal", format: "json", queries: false } as const;

const write = (path: string, contents: string) => {
  const full = join(root, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents);
};

beforeEach(() => {
  // A fresh directory per test, so the module cache cannot serve one test's
  // file to another — every path is new, so every import is new.
  root = mkdtempSync(join(tmpdir(), "altair-env-"));
});

afterEach(async () => {
  await running?.stop();
  running = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe("the environment file", () => {
  it("is optional", async () => {
    expect(await loadEnvironmentConfig(root, "production", buildConfig({ root }))).toEqual({});
  });

  it("is read for the environment in play", async () => {
    write("config/environments/production.ts", `export default { forceSsl: true };`);
    write("config/environments/development.ts", `export default { forceSsl: false };`);

    const production = await loadEnvironmentConfig(root, "production", buildConfig({ root }));
    expect(production).toEqual({ forceSsl: true });

    const development = await loadEnvironmentConfig(root, "development", buildConfig({ root }));
    expect(development).toEqual({ forceSsl: false });
  });

  // A function for the settings that depend on what the defaults worked out —
  // the root, a port from the environment — and an object for the rest.
  it("may be a function of the defaults", async () => {
    write(
      "config/environments/test.ts",
      `export default (defaults) => ({ database: { url: \`sqlite://\${defaults.root}/x.db\` } });`,
    );

    const config = await loadEnvironmentConfig(root, "test", buildConfig({ root, env: "test" }));
    expect(config.database?.url).toBe(`sqlite://${root}/x.db`);
  });

  it("says so when the file exports nothing", async () => {
    write("config/environments/test.ts", `export const settings = {};`);

    await expect(
      loadEnvironmentConfig(root, "test", buildConfig({ root, env: "test" })),
    ).rejects.toThrow(/no default export/);
  });
});

describe("building an application from it", () => {
  it("layers the file over the defaults", async () => {
    write(
      "config/environments/test.ts",
      `export default { forceSsl: true, log: ${JSON.stringify(quiet)} };`,
    );

    running = await loadApplication({ env: "test", root, secretKeyBase: SECRET });

    expect(running.config.forceSsl).toBe(true);
    expect(running.config.env).toBe("test");
  });

  // Nearest the call site wins, so a test that asks for an in-memory database
  // gets one whatever config/environments happens to say.
  it("lets what the caller passed win", async () => {
    write(
      "config/environments/test.ts",
      `export default { forceSsl: true, database: { url: "sqlite://from-file.db" }, log: ${JSON.stringify(quiet)} };`,
    );

    running = await loadApplication({
      env: "test",
      root,
      secretKeyBase: SECRET,
      database: { url: "sqlite://:memory:" },
    });

    expect(running.config.database.url).toBe("sqlite://:memory:");
    expect(running.config.forceSsl).toBe(true);
  });

  // Naming one setting in a nested group must not drop the others.
  it("merges a nested group rather than replacing it", async () => {
    write("config/environments/test.ts", `export default { log: { level: "warn" } };`);

    running = await loadApplication({ env: "test", root, secretKeyBase: SECRET });

    expect(running.config.log.level).toBe("warn");
    expect(running.config.log.format).toBeDefined();
    expect(running.config.log.queries).toBeDefined();
  });

  it("works with no file at all", async () => {
    running = await loadApplication({
      env: "test",
      root,
      secretKeyBase: SECRET,
      log: { ...quiet },
    });

    expect(running.config.env).toBe("test");
  });
});

describe("initializers", () => {
  const seen: string[] = [];

  beforeEach(() => {
    seen.length = 0;
    (globalThis as Record<string, unknown>).__altairSeen = seen;
  });

  const initializer = (name: string) =>
    `export default () => { globalThis.__altairSeen.push(${JSON.stringify(name)}); };`;

  it("finds none when there is no directory", async () => {
    expect(await loadInitializers(root)).toEqual([]);
  });

  it("runs them at boot", async () => {
    write("config/initializers/storage.ts", initializer("storage"));

    running = await loadApplication({
      env: "test",
      root,
      secretKeyBase: SECRET,
      database: { url: "sqlite://:memory:" },
      log: { ...quiet },
    });

    expect(seen).toEqual([]);
    await running.boot();
    expect(seen).toEqual(["storage"]);
  });

  // Alphabetical, as in Rails: an initializer that needs another to have run
  // first is a real situation, and a number prefix is how people solve it.
  it("runs them in filename order", async () => {
    write("config/initializers/20_second.ts", initializer("second"));
    write("config/initializers/10_first.ts", initializer("first"));

    running = await loadApplication({
      env: "test",
      root,
      secretKeyBase: SECRET,
      database: { url: "sqlite://:memory:" },
      log: { ...quiet },
    });

    await running.boot();
    expect(seen).toEqual(["first", "second"]);
  });

  it("hands each one the application", async () => {
    write(
      "config/initializers/env.ts",
      `export default (app) => { globalThis.__altairSeen.push(app.config.env); };`,
    );

    running = await loadApplication({
      env: "test",
      root,
      secretKeyBase: SECRET,
      database: { url: "sqlite://:memory:" },
      log: { ...quiet },
    });

    await running.boot();
    expect(seen).toEqual(["test"]);
  });

  it("waits for an async one", async () => {
    write(
      "config/initializers/slow.ts",
      `export default async () => {
         await new Promise((resolve) => setTimeout(resolve, 5));
         globalThis.__altairSeen.push("slow");
       };`,
    );

    running = await loadApplication({
      env: "test",
      root,
      secretKeyBase: SECRET,
      database: { url: "sqlite://:memory:" },
      log: { ...quiet },
    });

    await running.boot();
    expect(seen).toEqual(["slow"]);
  });

  it("runs them only once, however often boot is called", async () => {
    write("config/initializers/once.ts", initializer("once"));

    running = await loadApplication({
      env: "test",
      root,
      secretKeyBase: SECRET,
      database: { url: "sqlite://:memory:" },
      log: { ...quiet },
    });

    await running.boot();
    await running.boot();

    expect(seen).toEqual(["once"]);
  });

  it("says which file is wrong when one exports the wrong thing", async () => {
    write("config/initializers/broken.ts", `export default { not: "a function" };`);

    await expect(loadInitializers(root)).rejects.toThrow(/broken\.ts/);
  });

  it("ignores anything that is not a module", async () => {
    write("config/initializers/README.md", "notes");
    write("config/initializers/ok.ts", initializer("ok"));

    expect(await loadInitializers(root)).toHaveLength(1);
  });
});
