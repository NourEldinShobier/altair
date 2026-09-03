/**
 * Multiple databases and roles.
 *
 * Mirrors activerecord/test/cases/connection_adapters/connection_handler_test.rb
 * and the `connected_to` cases. The load-bearing test is the one that refuses a
 * write while reading: routing reads to a replica is only worth doing if a
 * stray write cannot follow them there.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConnection } from "../src/connection.js";
import { SchemaStatements } from "../src/schema.js";
import { Model } from "../src/model.js";
import {
  configureDatabases,
  connectedTo,
  currentScope,
  database,
  databaseSelector,
  eachShard,
  shardNames,
  disconnectDatabases,
  isReadOnly,
  ReadOnlyError,
} from "../src/databases.js";

interface PostAttributes {
  id: number;
  title: string;
}

class Post extends Model<PostAttributes>("posts") {}

class Event extends Model<PostAttributes>("posts") {
  static {
    this.connectsTo({ database: "analytics" });
  }
}

async function createPosts(name?: string): Promise<void> {
  await new SchemaStatements(database(name)).createTable("posts", (t) => t.string("title"));
}

beforeEach(async () => {
  // Two separate in-memory databases: each URL gets its own, which is what
  // makes "did this write land in the right one" answerable at all.
  configureDatabases({
    primary: "sqlite://:memory:",
    analytics: "sqlite://:memory:",
  });

  Post.resetColumnInformation();
  Event.resetColumnInformation();

  await createPosts("primary");
  await createPosts("analytics");
});

afterEach(async () => {
  await disconnectDatabases();
  setConnection(undefined);
});

describe("configuring", () => {
  it("opens a connection per database", () => {
    expect(database("primary")).not.toBe(database("analytics"));
  });

  it("hands back the same pool each time", () => {
    expect(database("primary")).toBe(database("primary"));
  });

  it("names the databases it knows when asked for one it does not", () => {
    expect(() => database("nope")).toThrow("Configured: primary, analytics");
  });

  // An application with one database configures a string and never thinks
  // about roles again.
  it("reads from the writing connection when there is no replica", () => {
    expect(database("primary", "reading")).toBe(database("primary", "writing"));
  });

  it("sends the reading role to the replica when there is one", async () => {
    // Real paths, because opening a SQLite connection creates its file, and a
    // test has no business leaving one in the working directory.
    const directory = await mkdtemp(join(tmpdir(), "altair-databases-"));
    const writing = `sqlite://${join(directory, "primary.db")}`;
    const reading = `sqlite://${join(directory, "replica.db")}`;

    try {
      configureDatabases({ primary: { writing, reading } });

      expect(database("primary", "writing").url).toBe(writing);
      expect(database("primary", "reading").url).toBe(reading);
    } finally {
      await disconnectDatabases();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("the default connection", () => {
  it("is the primary", async () => {
    await Post.create({ title: "Hello" });
    expect(await Post.count()).toBe(1);
  });

  // The whole point of a second database: a write to one is not visible in the
  // other.
  it("keeps a model on its own database", async () => {
    await Event.create({ title: "Tracked" });

    expect(await Event.count()).toBe(1);
    expect(await Post.count()).toBe(0);
  });
});

describe("connectedTo", () => {
  it("selects a database for the block", async () => {
    await connectedTo({ database: "analytics" }, async () => {
      await Post.create({ title: "Analytical" });
    });

    expect(await Post.count()).toBe(0);
    expect(await Event.count()).toBe(1);
  });

  it("reports the scope in force", async () => {
    expect(currentScope()).toBeUndefined();

    await connectedTo({ role: "reading" }, async () => {
      expect(currentScope()).toEqual({ database: "primary", role: "reading", shard: "default" });
    });
  });

  it("restores the outer scope afterwards", async () => {
    await connectedTo({ database: "analytics" }, async () => {});
    expect(currentScope()).toBeUndefined();
    await Post.create({ title: "Back on primary" });
    expect(await Post.count()).toBe(1);
  });

  it("inherits what an inner block does not set", async () => {
    await connectedTo({ database: "analytics" }, async () => {
      await connectedTo({ role: "reading" }, async () => {
        expect(currentScope()).toEqual({
          database: "analytics",
          role: "reading",
          shard: "default",
        });
      });
    });
  });

  // The scope follows the async call chain, so one request reading from a
  // replica cannot pull a concurrent request onto it.
  it("does not leak into concurrent work", async () => {
    const inside: boolean[] = [];

    await Promise.all([
      connectedTo({ role: "reading" }, async () => {
        await Bun.sleep(5);
        inside.push(isReadOnly());
      }),
      (async () => {
        await Bun.sleep(1);
        inside.push(isReadOnly());
      })(),
    ]);

    expect(inside.sort()).toEqual([false, true]);
  });
});

describe("the reading role", () => {
  it("still reads", async () => {
    await Post.create({ title: "Hello" });

    await connectedTo({ role: "reading" }, async () => {
      expect(await Post.count()).toBe(1);
    });
  });

  // Routing reads to a replica is only worth doing if a stray write cannot
  // follow them there.
  it("refuses a save", async () => {
    await connectedTo({ role: "reading" }, async () => {
      await expect(Post.create({ title: "Nope" })).rejects.toThrow(ReadOnlyError);
    });
  });

  it("refuses a destroy", async () => {
    const post = await Post.create({ title: "Hello" });

    await connectedTo({ role: "reading" }, async () => {
      await expect(post.destroy()).rejects.toThrow(ReadOnlyError);
    });
  });

  it("refuses a bulk update", async () => {
    await connectedTo({ role: "reading" }, async () => {
      await expect(Post.all().updateAll({ title: "Nope" })).rejects.toThrow(ReadOnlyError);
    });
  });

  it("refuses a bulk delete", async () => {
    await connectedTo({ role: "reading" }, async () => {
      await expect(Post.all().deleteAll()).rejects.toThrow(ReadOnlyError);
    });
  });

  it("says what it refused", async () => {
    await connectedTo({ role: "reading" }, async () => {
      await expect(Post.create({ title: "Nope" })).rejects.toThrow(
        "Cannot save while connected to a reading role",
      );
    });
  });

  it("writes again once the block ends", async () => {
    await connectedTo({ role: "reading" }, async () => {});
    await Post.create({ title: "Fine" });

    expect(await Post.count()).toBe(1);
  });
});

describe("the database selector", () => {
  const ok = () => new Response("ok");

  it("reads on GET", async () => {
    let role: string | undefined;

    await databaseSelector()(new Request("https://example.com/posts"), async () => {
      role = currentScope()?.role;
      return ok();
    });

    expect(role).toBe("reading");
  });

  it("reads on HEAD", async () => {
    let role: string | undefined;

    await databaseSelector()(
      new Request("https://example.com/posts", { method: "HEAD" }),
      async () => {
        role = currentScope()?.role;
        return ok();
      },
    );

    expect(role).toBe("reading");
  });

  it("writes on anything else", async () => {
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      let role: string | undefined;

      await databaseSelector()(new Request("https://example.com/posts", { method }), async () => {
        role = currentScope()?.role;
        return ok();
      });

      expect(role).toBe("writing");
    }
  });

  // The replica lags, so an application that reads its own writes needs to
  // decide for itself. The hook is the upgrade path.
  it("takes a decision of its own", async () => {
    let role: string | undefined;

    await databaseSelector({ role: () => "writing" })(
      new Request("https://example.com/posts"),
      async () => {
        role = currentScope()?.role;
        return ok();
      },
    );

    expect(role).toBe("writing");
  });

  it("passes the response through", async () => {
    const response = await databaseSelector()(new Request("https://example.com/"), async () =>
      ok(),
    );

    expect(await response.text()).toBe("ok");
  });
});

// Rails' horizontal sharding: the same schema on more than one server, split
// by a key the framework cannot guess. Nothing picks a shard for you.
describe("shards", () => {
  const shardedConfig = {
    primary: {
      writing: "sqlite://:memory:",
      shards: {
        one: { writing: "sqlite://:memory:" },
        two: { writing: "sqlite://:memory:" },
      },
    },
  };

  beforeEach(async () => {
    configureDatabases(shardedConfig);
    Post.resetColumnInformation();

    for (const shard of shardNames("primary")) {
      await new SchemaStatements(database("primary", "writing", shard)).createTable("posts", (t) =>
        t.string("title"),
      );
    }
  });

  it("lists the shards a database has, the default included", () => {
    expect(shardNames("primary")).toEqual(["default", "one", "two"]);
  });

  it("has none for a database without them", () => {
    configureDatabases({ primary: "sqlite://:memory:" });
    expect(shardNames("primary")).toEqual(["default"]);
  });

  it("opens a connection per shard", () => {
    expect(database("primary", "writing", "one")).not.toBe(database("primary", "writing", "two"));
  });

  // An application without shards should never notice they exist.
  it("treats the default shard as the database itself", () => {
    expect(database("primary", "writing", "default")).toBe(database("primary"));
  });

  it("names the shards it knows when asked for one it does not", () => {
    expect(() => database("primary", "writing", "three")).toThrow("Shards: one, two");
  });

  it("writes to the shard the block selected", async () => {
    await connectedTo({ shard: "one" }, async () => {
      await Post.create({ title: "On shard one" });
    });

    await connectedTo({ shard: "one" }, async () => {
      expect(await Post.count()).toBe(1);
    });

    await connectedTo({ shard: "two" }, async () => {
      expect(await Post.count()).toBe(0);
    });
  });

  it("goes back to the default shard afterwards", async () => {
    await connectedTo({ shard: "one" }, async () => {
      await Post.create({ title: "On shard one" });
    });

    expect(await Post.count()).toBe(0);
  });

  it("reports the shard in force", async () => {
    await connectedTo({ shard: "two" }, async () => {
      expect(currentScope()?.shard).toBe("two");
    });
  });

  it("keeps a shard chosen by an outer block", async () => {
    await connectedTo({ shard: "one" }, async () => {
      await connectedTo({ role: "reading" }, async () => {
        expect(currentScope()).toEqual({ database: "primary", role: "reading", shard: "one" });
      });
    });
  });

  it("visits every shard in turn", async () => {
    await connectedTo({ shard: "one" }, async () => {
      await Post.create({ title: "One" });
    });
    await connectedTo({ shard: "two" }, async () => {
      await Post.create({ title: "Two" });
      await Post.create({ title: "Also two" });
    });

    const counts = await eachShard(async () => await Post.count());
    expect(counts).toEqual([0, 1, 2]);
  });

  it("tells the block which shard it is on", async () => {
    expect(await eachShard(async (shard) => shard)).toEqual(["default", "one", "two"]);
  });

  // The scope follows the async call chain, so two requests on different
  // shards cannot pull each other across.
  it("keeps concurrent work on its own shard", async () => {
    await Promise.all([
      connectedTo({ shard: "one" }, async () => {
        await Bun.sleep(5);
        await Post.create({ title: "One" });
      }),
      connectedTo({ shard: "two" }, async () => {
        await Post.create({ title: "Two" });
      }),
    ]);

    expect(await eachShard(async () => await Post.count())).toEqual([0, 1, 1]);
  });
});
