/**
 * Connection switching above what `databases.ts` owns, ported from
 * `activerecord/test/cases/connection_adapters/connection_handlers_multi_role_test.rb`,
 * `activerecord/test/cases/connection_adapters/connection_handlers_sharding_test.rb`
 * and the `while_preventing_writes` cases in
 * `activerecord/test/cases/connection_adapters/legacy_connection_handling_test.rb`.
 *
 * Nesting is what most of these check: an inner block finishing must not lift
 * an outer block's restriction, and a body that throws must not leave the
 * process in the state the block set.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  PreventedWrite,
  READING_ROLE,
  ShardSwappingProhibited,
  WRITING_ROLE,
  checkShardSwap,
  checkWriteAllowed,
  connectedToMany,
  connectionDescriptor,
  currentPreventingWrites,
  currentRole,
  currentShard,
  prohibitShardSwapping,
  resetSwitchingState,
  shardSwappingProhibited,
  switchShard,
  withABiasFor,
  whilePreventingWrites,
} from "../src/connection_switching.js";

afterEach(() => {
  resetSwitchingState();
});

describe("what is in force with no block open", () => {
  it("is the writer, on the default shard", () => {
    expect(currentRole()).toBe(WRITING_ROLE);
    expect(currentShard()).toBe("default");
  });

  it("allows writes", () => {
    expect(currentPreventingWrites()).toBe(false);
    expect(() => checkWriteAllowed("insert")).not.toThrow();
  });
});

describe("the key a pool is found by", () => {
  /**
   * All three parts. One missing the role sends a write to a replica; one
   * missing the shard sends a query for one tenant to another's database.
   */
  it("names the database, role and shard", () => {
    expect(connectionDescriptor({ database: "primary", role: "reading", shard: "one" })).toBe(
      "primary/reading/one",
    );
  });

  it("separates two roles", () => {
    expect(connectionDescriptor({ role: "reading" })).not.toBe(
      connectionDescriptor({ role: "writing" }),
    );
  });

  it("separates two shards", () => {
    expect(connectionDescriptor({ shard: "one" })).not.toBe(connectionDescriptor({ shard: "two" }));
  });

  it("falls back to what is currently in force", () => {
    expect(connectionDescriptor()).toBe("primary/writing/default");
  });
});

describe("preventing writes", () => {
  /**
   * The point is running this against the *writer*, in production, to find
   * which paths break under a read-only failover — before the failover rather
   * than during it.
   */
  it("refuses a write inside the block", async () => {
    await whilePreventingWrites(true, () => {
      expect(currentPreventingWrites()).toBe(true);
      expect(() => checkWriteAllowed("insert")).toThrow(PreventedWrite);
    });
  });

  it("allows writes again afterwards", async () => {
    await whilePreventingWrites(true, () => undefined);

    expect(currentPreventingWrites()).toBe(false);
  });

  /** Counted, not set: an inner block finishing must not lift the outer one. */
  it("keeps the outer block's prevention when an inner one ends", async () => {
    await whilePreventingWrites(true, async () => {
      await whilePreventingWrites(true, () => undefined);

      expect(currentPreventingWrites()).toBe(true);
    });
  });

  /**
   * A body that throws must not leave the process refusing writes for the rest
   * of its life.
   */
  it("lifts the prevention when the body throws", async () => {
    await expect(
      whilePreventingWrites(true, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(currentPreventingWrites()).toBe(false);
  });

  it("does nothing when asked not to prevent", async () => {
    await whilePreventingWrites(false, () => {
      expect(currentPreventingWrites()).toBe(false);
    });
  });

  it("hands back what the body returned", async () => {
    expect(await whilePreventingWrites(true, () => 7)).toBe(7);
    expect(await whilePreventingWrites(false, () => 7)).toBe(7);
  });

  it("says why it refused", () => {
    expect(() => {
      throw new PreventedWrite("insert");
    }).toThrow("replication event");
  });
});

describe("prohibiting shard swaps", () => {
  it("allows a swap by default", () => {
    expect(shardSwappingProhibited()).toBe(false);
    expect(() => checkShardSwap("two")).not.toThrow();
  });

  /**
   * A shard is usually a tenant, so code that swaps mid-request is code that
   * can hand one tenant another's rows.
   */
  it("refuses one inside the block", async () => {
    await prohibitShardSwapping(true, () => {
      expect(() => checkShardSwap("two")).toThrow(ShardSwappingProhibited);
    });
  });

  it("allows staying on the same shard", async () => {
    await prohibitShardSwapping(true, () => {
      expect(() => checkShardSwap("default")).not.toThrow();
    });
  });

  it("allows swaps again afterwards", async () => {
    await prohibitShardSwapping(true, () => undefined);

    expect(shardSwappingProhibited()).toBe(false);
  });

  it("keeps the outer prohibition when an inner one ends", async () => {
    await prohibitShardSwapping(true, async () => {
      await prohibitShardSwapping(true, () => undefined);

      expect(shardSwappingProhibited()).toBe(true);
    });
  });

  it("lifts it when the body throws", async () => {
    await expect(
      prohibitShardSwapping(true, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(shardSwappingProhibited()).toBe(false);
  });

  it("does nothing when asked not to prohibit", async () => {
    await prohibitShardSwapping(false, () => {
      expect(shardSwappingProhibited()).toBe(false);
    });
  });

  it("names both shards when it refuses", async () => {
    await prohibitShardSwapping(true, () => {
      expect(() => checkShardSwap("two")).toThrow("two");
      expect(() => checkShardSwap("two")).toThrow("default");
    });
  });

  it("refuses through the switch wrapper too", async () => {
    await prohibitShardSwapping(true, async () => {
      await expect(switchShard("two", async () => undefined)).rejects.toThrow(
        ShardSwappingProhibited,
      );
    });
  });
});

describe("connecting to several databases", () => {
  it("runs the body once per database", async () => {
    const seen: string[] = [];

    await connectedToMany(["primary", "animals"], {}, async (database) => {
      seen.push(database);

      return database;
    });

    expect(seen).toEqual(["primary", "animals"]);
  });

  it("hands back a result per database", async () => {
    expect(
      await connectedToMany(["primary", "animals"], {}, async (database) => database.length),
    ).toEqual([7, 7]);
  });

  /**
   * Sequential, not concurrent: the bodies usually write, and a backfill
   * against every database at once multiplies its load on what may be one
   * server behind several logical databases.
   */
  it("runs them one at a time", async () => {
    const order: string[] = [];

    await connectedToMany(["a", "b"], {}, async (database) => {
      order.push(`start:${database}`);
      await Promise.resolve();
      order.push(`end:${database}`);
    });

    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"]);
  });

  it("refuses an empty list", async () => {
    await expect(connectedToMany([], {}, async () => undefined)).rejects.toThrow(
      "at least one database",
    );
  });
});

describe("preferring a shard without requiring it", () => {
  /**
   * A preference rather than a requirement: a bias picks a replica without
   * failing when that one is out of rotation.
   */
  it("takes the preferred one when it is there", () => {
    expect(withABiasFor("two", ["one", "two"])).toBe("two");
  });

  it("falls back when it is not", () => {
    expect(withABiasFor("three", ["one", "two"])).toBe("one");
  });

  it("falls back to the default with nothing available", () => {
    expect(withABiasFor("three", [])).toBe("default");
  });
});

describe("the roles", () => {
  it("names them", () => {
    expect(READING_ROLE).toBe("reading");
    expect(WRITING_ROLE).toBe("writing");
  });
});
