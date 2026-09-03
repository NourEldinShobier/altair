/**
 * `connectionDbConfig`, ported from `connection_db_config` in
 * `activerecord/lib/active_record/connection_handling.rb`.
 *
 * The first question asked during an incident, and until now the only way to
 * answer it was to read the code and hope. With a replica, shards, and a
 * `connectedTo` block somewhere up the call stack, "which database is this
 * model reading from *right now*" is not a property of the class — it is a
 * property of the request that is running — and nothing exposed it.
 *
 * Resolved through the same helper `connection` uses, so the answer and the
 * connection it describes cannot drift apart. The two copies of "reading falls
 * back to writing, and the default shard is the database itself" that would
 * otherwise exist are exactly the kind that disagree on the day it matters.
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { Model } from "../src/model.js";
import {
  configureDatabases,
  connectedTo,
  disconnectDatabases,
  redactUrl,
} from "../src/databases.js";
import { setConnection } from "../src/connection.js";
import { testConnection } from "./support/database.js";

class Post extends Model<{ id: number }>("posts") {}
class Metric extends Model<{ id: number }>("metrics") {}

beforeEach(async () => {
  await disconnectDatabases();

  configureDatabases({
    // In-memory, because opening `sqlite://primary.db` writes a real file into
    // the working tree — which is how one reached a commit.
    primary: { writing: "sqlite://:memory:", reading: "sqlite://:memory:" },
    analytics: {
      writing: "postgres://user:hunter2@warehouse/analytics",
      shards: {
        eu: { writing: "postgres://user:hunter2@eu/analytics" },
        us: {
          writing: "postgres://user:hunter2@us/analytics",
          reading: "postgres://user:hunter2@us-replica/analytics",
        },
      },
    },
  });

  Post.databaseName = undefined;
  Metric.databaseName = "analytics";
});

// Configured databases are process-global, so a file that sets them up has to
// put them back: left behind, `hasDatabases()` stays true and every later
// test's model resolves through a pool instead of the connection it was given.
afterAll(async () => {
  await disconnectDatabases();
  configureDatabases({});
  setConnection(await testConnection());
});

describe("a model pinned to a database", () => {
  it("names it", () => {
    expect(Metric.connectionDbConfig().name).toBe("analytics");
  });

  it("says which adapter it speaks", () => {
    expect(Metric.connectionDbConfig().adapter).toBe("postgres");
  });

  it("writes by default", () => {
    expect(Metric.connectionDbConfig().role).toBe("writing");
  });

  it("is on the default shard until told otherwise", () => {
    expect(Metric.connectionDbConfig().shard).toBe("default");
  });
});

describe("inside a connectedTo block", () => {
  /** The point: read now, not when the class was defined. */
  it("follows the role in force", async () => {
    await connectedTo({ database: "analytics", role: "reading" }, async () => {
      expect(Metric.connectionDbConfig().role).toBe("reading");
    });
  });

  it("follows the shard in force", async () => {
    await connectedTo({ database: "analytics", shard: "eu" }, async () => {
      const config = Metric.connectionDbConfig();

      expect(config.shard).toBe("eu");
      expect(config.url).toContain("eu/analytics");
    });
  });

  it("resolves a shard's own replica", async () => {
    await connectedTo({ database: "analytics", role: "reading", shard: "us" }, async () => {
      expect(Metric.connectionDbConfig().url).toContain("us-replica");
    });
  });

  /** Reading falls back to writing, which is what a database with no replica needs. */
  it("falls back to writing where a shard has no replica", async () => {
    await connectedTo({ database: "analytics", role: "reading", shard: "eu" }, async () => {
      expect(Metric.connectionDbConfig().url).toContain("eu/analytics");
    });
  });

  it("goes back to writing once the block ends", async () => {
    await connectedTo({ database: "analytics", role: "reading" }, async () => undefined);

    expect(Metric.connectionDbConfig().role).toBe("writing");
  });
});

describe("the url", () => {
  /**
   * This value belongs in a health endpoint, a log line and an error page, and
   * a password must not be in any of the three.
   */
  it("has the password taken out", () => {
    expect(Metric.connectionDbConfig().url).not.toContain("hunter2");
  });

  it("keeps enough to identify the server", () => {
    const { url } = Metric.connectionDbConfig();

    expect(url).toContain("warehouse");
    expect(url).toContain("user");
  });

  it("leaves a url with no password alone", () => {
    expect(redactUrl("sqlite://primary.db")).toBe("sqlite://primary.db");
  });

  it("does not mistake a path for credentials", () => {
    expect(redactUrl("postgres://host/db:5432")).toBe("postgres://host/db:5432");
  });
});

describe("a connection handed over directly", () => {
  /** A test, or an application that never called configureDatabases. */
  it("describes itself rather than failing", async () => {
    setConnection(await testConnection());

    const config = Post.connectionDbConfig();

    expect(config.name).toBe("primary");
    expect(config.adapter).toBe("sqlite");
  });
});

describe("the connection a pinned model opens", () => {
  /**
   * The bug the test below found. `connection` passed the name and the role
   * and dropped the shard, so it fell through to the default — a model pinned
   * to a database wrote to the unsharded server while every unpinned model in
   * the same block wrote to the shard. Nothing failed; the rows just landed in
   * the wrong database.
   */
  it("is on the shard in force", async () => {
    await connectedTo({ database: "analytics", shard: "eu" }, async () => {
      expect(Metric.connection.url).toContain("eu/analytics");
    });
  });

  it("is on the default shard outside a block", () => {
    expect(Metric.connection.url).toContain("warehouse");
  });

  it("follows the role as well", async () => {
    await connectedTo({ database: "analytics", shard: "us", role: "reading" }, async () => {
      expect(Metric.connection.url).toContain("us-replica");
    });
  });
});

describe("agreement with the connection it describes", () => {
  /**
   * The reason both go through one resolver. An answer produced by different
   * code from the connection that answers it is an answer that can be wrong.
   */
  it("names the url the connection actually opened", async () => {
    await connectedTo({ database: "analytics", shard: "us", role: "reading" }, async () => {
      const described = Metric.connectionDbConfig();

      expect(described.url).toBe(redactUrl(Metric.connection.url));
    });
  });
});
