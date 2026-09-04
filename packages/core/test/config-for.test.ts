/**
 * Per-environment settings from a YAML file.
 *
 * Mirrors railties/test/application/configuration_test.rb's `config_for`
 * cases. Written against real files in a temporary directory rather than a
 * stubbed reader: the whole function is about what happens to a file on disk,
 * and a stub would only test the shape I assumed it had.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigFileError, configFor, interpolate } from "../src/config-for.js";

let root: string;

const write = async (name: string, contents: string) => {
  await Bun.write(join(root, "config", `${name}.yml`), contents);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "altair-config-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("reading a section", () => {
  beforeEach(async () => {
    await write(
      "redis",
      [
        "shared:",
        "  timeout: 5000",
        "  pool:",
        "    size: 5",
        "    reaping: true",
        "development:",
        "  url: redis://localhost:6379",
        "production:",
        "  url: redis://prod:6379",
        "  timeout: 1000",
        "  pool:",
        "    size: 25",
      ].join("\n"),
    );
  });

  it("takes the environment's own settings", async () => {
    const config = await configFor("redis", { root, env: "development" });

    expect(config.url).toBe("redis://localhost:6379");
  });

  it("falls back to the shared ones", async () => {
    const config = await configFor("redis", { root, env: "development" });

    expect(config.timeout).toBe(5000);
  });

  it("lets the environment win where they disagree", async () => {
    const config = await configFor("redis", { root, env: "production" });

    expect(config.timeout).toBe(1000);
  });

  // The one that matters. Naming `size` under production must not take
  // `reaping` down with it, which is what a section-level merge would do.
  it("merges nested settings key by key", async () => {
    const config = await configFor("redis", { root, env: "production" });

    expect(config.pool).toEqual({ size: 25, reaping: true });
  });

  it("gives the shared settings alone when an environment has no section", async () => {
    const config = await configFor("redis", { root, env: "staging" });

    expect(config).toEqual({ timeout: 5000, pool: { size: 5, reaping: true } });
  });

  // Each call hands back its own answer; a merge that mutated the parsed
  // document would leak one environment's settings into the next read.
  it("does not carry one read into the next", async () => {
    const production = await configFor("redis", { root, env: "production" });
    (production.pool as { size: number }).size = 999;

    const again = await configFor("redis", { root, env: "development" });

    expect((again.pool as { size: number }).size).toBe(5);
  });
});

describe("a value from the environment", () => {
  it("is substituted", async () => {
    await write("redis", "production:\n  url: ${REDIS_URL}");

    const config = await configFor("redis", {
      root,
      env: "production",
      variables: { REDIS_URL: "redis://from-the-env" },
    });

    expect(config.url).toBe("redis://from-the-env");
  });

  it("falls back when one is given", async () => {
    await write("redis", "production:\n  url: ${REDIS_URL:-redis://localhost}");

    const config = await configFor("redis", { root, env: "production", variables: {} });

    expect(config.url).toBe("redis://localhost");
  });

  // An empty `url:` fails on the first connection instead, which reads like
  // the service is down rather than like the setting is missing.
  it("is an error when it is not set and has no fallback", () => {
    expect(
      (async () => {
        await write("redis", "production:\n  url: ${REDIS_URL}");
        return await configFor("redis", { root, env: "production", variables: {} });
      })(),
    ).rejects.toThrow(/REDIS_URL/);
  });

  it("leaves anything that is not a reference alone", async () => {
    await write("redis", "production:\n  note: costs $5 {maybe}");

    expect((await configFor("redis", { root, env: "production" })).note).toBe("costs $5 {maybe}");
  });

  it("substitutes on its own too", () => {
    expect(interpolate("a=${X}", { X: "1" })).toBe("a=1");
    expect(interpolate("a=${X:-2}", {})).toBe("a=2");
    expect(interpolate("a=${X:-}", {})).toBe("a=");
  });
});

describe("a file that is not what it should be", () => {
  it("says which one is missing", () => {
    expect(configFor("nope", { root })).rejects.toThrow(/nope\.yml/);
    expect(configFor("nope", { root })).rejects.toBeInstanceOf(ConfigFileError);
  });

  it("says when it will not parse", async () => {
    await write("broken", "a:\n  - b\n bad indent: [");

    expect(configFor("broken", { root })).rejects.toBeInstanceOf(ConfigFileError);
  });

  it("says when it is not a mapping", async () => {
    await write("list", "- one\n- two");

    expect(configFor("list", { root })).rejects.toThrow(/mapping/);
  });

  // No settings is a legitimate state, and an empty file parses to null.
  it("reads an empty file as no settings", async () => {
    await write("empty", "");

    expect(await configFor("empty", { root })).toEqual({});
  });
});

describe("YAML the file may use", () => {
  it("resolves an anchor and a merge key", async () => {
    await write(
      "database",
      [
        "base: &base",
        "  adapter: postgresql",
        "  encoding: unicode",
        "production:",
        "  <<: *base",
        "  database: app_production",
      ].join("\n"),
    );

    const config = await configFor("database", { root, env: "production" });

    expect(config).toEqual({
      adapter: "postgresql",
      encoding: "unicode",
      database: "app_production",
    });
  });

  // `---` makes a second document. The first is the configuration; whatever
  // follows it is somebody's notes.
  it("reads the first document when there are several", async () => {
    await write("multi", "production:\n  a: 1\n---\nproduction:\n  a: 2");

    expect((await configFor("multi", { root, env: "production" })).a).toBe(1);
  });
});
