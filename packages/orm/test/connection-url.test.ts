/**
 * A database URL, resolved, ported from
 * `activerecord/test/cases/connection_adapters/connection_handler_test.rb`'s
 * URL cases and `activerecord/test/cases/database_configurations/url_config_test.rb`.
 *
 * Everything here is about a value that arrives as text and is used as
 * something else. None of these fail at boot; they fail later, somewhere else.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  PROTOCOL_ADAPTERS,
  SSL_MODES,
  adapterNameFrom,
  coerceUrlValue,
  dbConfig,
  parseSslMode,
  registerDbConfigHandler,
  resetDbConfigHandlers,
  resolveConnectionUrl,
  resolvePath,
} from "../src/connection-url.js";

afterEach(() => {
  resetDbConfigHandlers();
});

describe("which adapter a url names", () => {
  it("is the scheme", () => {
    expect(adapterNameFrom("postgresql://localhost/blog")).toBe("postgresql");
    expect(adapterNameFrom("mysql2://localhost/blog")).toBe("mysql2");
  });

  /**
   * `postgres://` is what every hosting provider hands out, so refusing it
   * would make this the only tool that cannot read the connection string on
   * the dashboard.
   */
  it("takes the spelling everything else uses", () => {
    expect(adapterNameFrom("postgres://localhost/blog")).toBe("postgresql");
    expect(adapterNameFrom("mysql://localhost/blog")).toBe("mysql2");
    expect(adapterNameFrom("sqlite:///blog.sqlite3")).toBe("sqlite3");
    expect(PROTOCOL_ADAPTERS["postgres"]).toBe("postgresql");
  });

  /** A URL scheme cannot contain an underscore and an adapter name often does. */
  it("reads a hyphen as an underscore", () => {
    expect(adapterNameFrom("my-adapter://localhost/blog")).toBe("my_adapter");
  });

  /**
   * Guessing would connect to the wrong kind of server and fail with a protocol
   * error, which reads as a network problem.
   */
  it("is nothing when there is no scheme", () => {
    expect(adapterNameFrom("localhost/blog")).toBeUndefined();
    // Read from the start, so a colon further along — in a path, a filename —
    // is not mistaken for one.
    expect(adapterNameFrom("storage/blog:1.sqlite3")).toBeUndefined();
  });
});

describe("a value from a query string", () => {
  /**
   * `"false"` is truthy in JavaScript, so a `?replica=false` left as text marks
   * the entry a replica and every write to it is refused.
   */
  it("reads the booleans", () => {
    expect(coerceUrlValue("true")).toBe(true);
    expect(coerceUrlValue("false")).toBe(false);
  });

  /** Left as text, a pool size compares as text, where "10" < "5". */
  it("reads the numbers", () => {
    expect(coerceUrlValue("5")).toBe(5);
    expect(coerceUrlValue("-1")).toBe(-1);
  });

  /** An identifier of "0000" must survive as it was written, not become 0. */
  it("leaves anything else alone", () => {
    expect(coerceUrlValue("0000")).toBe("0000");
    expect(coerceUrlValue("0")).toBe(0);
    expect(coerceUrlValue("00.5")).toBe("00.5");
    expect(coerceUrlValue("TRUE")).toBe("TRUE");
    expect(coerceUrlValue("")).toBe("");
  });
});

describe("expanding a url", () => {
  it("takes the parts apart", () => {
    expect(resolveConnectionUrl("postgresql://user:secret@db.example:6432/blog")).toEqual({
      adapter: "postgresql",
      host: "db.example",
      port: 6432,
      username: "user",
      password: "secret",
      database: "blog",
    });
  });

  /** `postgres://host/blog` names the database `blog`, not `/blog`. */
  it("drops the leading slash from the database name", () => {
    expect(resolveConnectionUrl("postgres://localhost/blog")["database"]).toBe("blog");
  });

  /** For SQLite the path *is* the file, so the slash is part of it. */
  it("keeps the path for sqlite", () => {
    expect(resolveConnectionUrl("sqlite3:///tmp/blog.sqlite3")["database"]).toBe(
      "/tmp/blog.sqlite3",
    );
  });

  it("decodes what was escaped", () => {
    expect(resolveConnectionUrl("postgres://user:p%40ss@localhost/blog")["password"]).toBe("p@ss");
  });

  /**
   * Left out rather than kept as empty strings: a configuration file merged
   * over the URL has to be able to supply them, and `username: ""` overrides a
   * username while a missing one does not.
   */
  it("leaves out what the url did not say", () => {
    const config = resolveConnectionUrl("postgres://localhost/blog");

    expect(config).toEqual({ adapter: "postgresql", host: "localhost", database: "blog" });
    // The keys, not just the values: a key present and undefined still
    // overrides what a configuration file supplies for it.
    expect(Object.keys(config).sort()).toEqual(["adapter", "database", "host"]);
  });

  it("takes the query string as options", () => {
    expect(resolveConnectionUrl("postgres://localhost/blog?pool=25&timeout=3000")).toMatchObject({
      pool: 25,
      timeout: 3000,
    });
  });

  it("reads a boolean option from the query string", () => {
    expect(resolveConnectionUrl("postgres://localhost/blog?replica=false")["replica"]).toBe(false);
    expect(resolveConnectionUrl("postgres://localhost/blog?replica=true")["replica"]).toBe(true);
  });
});

describe("where a sqlite file is", () => {
  /**
   * Relative to the application, not the working directory: a task run from a
   * subdirectory would otherwise create a second database beside itself and
   * appear to work, with none of the data.
   */
  it("is relative to the application root", () => {
    expect(resolvePath("storage/blog.sqlite3", "/app")).toBe("/app/storage/blog.sqlite3");
    expect(resolvePath("storage/blog.sqlite3", "/app/")).toBe("/app/storage/blog.sqlite3");
  });

  it("leaves an absolute path alone", () => {
    expect(resolvePath("/tmp/blog.sqlite3", "/app")).toBe("/tmp/blog.sqlite3");
    expect(resolvePath("C:/db/blog.sqlite3", "/app")).toBe("C:/db/blog.sqlite3");
  });

  it("is the path as written when there is no root", () => {
    expect(resolvePath("storage/blog.sqlite3")).toBe("storage/blog.sqlite3");
  });

  it("reads a file url", () => {
    expect(resolvePath("file:/tmp/blog.sqlite3")).toBe("/tmp/blog.sqlite3");
  });
});

describe("an ssl mode named in a url", () => {
  /**
   * Named in a URL and numeric in the driver. Passed through as text the driver
   * takes it as unknown and falls back to its default, which for MySQL is a
   * connection with no TLS at all.
   */
  it("is the driver's number", () => {
    expect(parseSslMode("required")).toBe(2);
    expect(SSL_MODES["required"]).toBe(2);
    expect(parseSslMode("verify_identity")).toBe(4);
  });

  it("takes the driver's own spelling", () => {
    expect(parseSslMode("SSL_MODE_REQUIRED")).toBe(2);
  });

  it("leaves a number alone", () => {
    expect(parseSslMode(2)).toBe(2);
  });

  /** Silently defaulting here is an unencrypted connection nobody asked for. */
  it("refuses one it does not know", () => {
    expect(() => parseSslMode("maybe")).toThrow("Unknown ssl_mode");
    expect(() => parseSslMode("maybe")).toThrow("no TLS");
  });
});

describe("turning an entry into a configuration", () => {
  /**
   * The entry's own keys are merged over the URL, which is what makes
   * `DATABASE_URL` a base rather than an override: one URL shared by a primary
   * and a replica that differ in one setting.
   */
  it("merges the entry over the url", () => {
    expect(
      dbConfig("production", "primary", "postgres://localhost/blog?pool=5", { pool: 25 }),
    ).toEqual({
      adapter: "postgresql",
      host: "localhost",
      database: "blog",
      pool: 25,
    });
  });

  it("is the entry alone when there is no url", () => {
    expect(dbConfig("test", "primary", undefined, { adapter: "sqlite3" })).toEqual({
      adapter: "sqlite3",
    });
  });

  it("is the url alone when the entry says nothing", () => {
    expect(dbConfig("test", "primary", "postgres://localhost/blog")).toEqual({
      adapter: "postgresql",
      host: "localhost",
      database: "blog",
    });
  });

  /**
   * A hook because an entry can carry keys the framework knows nothing about —
   * a shard router's topology, a proxy's credentials — and what those become
   * has to be the application's.
   */
  it("lets an application build its own", () => {
    registerDbConfigHandler((env, name, url, config) =>
      config["vitess"] ? { adapter: "vitess", envName: env, name, url } : undefined,
    );

    expect(dbConfig("production", "primary", "x://y/z", { vitess: true })).toMatchObject({
      adapter: "vitess",
      name: "primary",
    });
  });

  it("falls through a handler that does not want the entry", () => {
    registerDbConfigHandler(() => undefined);

    expect(dbConfig("test", "primary", "postgres://localhost/blog")["adapter"]).toBe("postgresql");
  });

  /**
   * A configuration file entry is not coerced on the way in, and these decide
   * whether an entry is written to at all: a string here reads as configured
   * and means the opposite of what it says.
   */
  it("forces the options that decide where writes go", () => {
    expect(dbConfig("test", "primary", undefined, { replica: "false" })["replica"]).toBe(false);
    expect(dbConfig("test", "primary", undefined, { replica: "true" })["replica"]).toBe(true);
    expect(
      dbConfig("test", "primary", undefined, { database_tasks: "false" })["database_tasks"],
    ).toBe(false);
    // Anything already a boolean is left as it is.
    expect(dbConfig("test", "primary", undefined, { replica: true })["replica"]).toBe(true);
  });

  it("forgets the handlers it was given", () => {
    registerDbConfigHandler(() => ({ adapter: "handled" }));
    resetDbConfigHandlers();

    expect(dbConfig("test", "primary", "postgres://localhost/blog")["adapter"]).toBe("postgresql");
  });

  /** Newest first, so a registration overrides rather than being buried. */
  it("tries the newest handler first", () => {
    registerDbConfigHandler(() => ({ adapter: "first" }));
    registerDbConfigHandler(() => ({ adapter: "second" }));

    expect(dbConfig("test", "primary", undefined)["adapter"]).toBe("second");
  });
});
