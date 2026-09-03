/**
 * Write prevention and shard prohibition, held to the work that asked for
 * them, ported from the isolation `connected_to` already has in
 * `activerecord/lib/active_record/connection_handling.rb` — Rails keeps all
 * three in `ActiveSupport::IsolatedExecutionState`, per fiber.
 *
 * `connection_switching.ts` opens by explaining why: "a module-level variable
 * would let one request's `connected_to` block move a *concurrent* request
 * onto a replica, which is the failure this whole area exists to avoid." Two
 * functions below that, both of the states this file adds were module-level
 * counters.
 *
 * So a request running `whilePreventingWrites` on the writer — the thing an
 * application does in production to find out what would break under a
 * read-only failover — made every concurrent request fail its writes with
 * `PreventedWrite`. The failover rehearsal caused the outage it was
 * rehearsing for.
 */

import { describe, expect, it } from "bun:test";
import {
  checkShardSwap,
  checkWriteAllowed,
  currentPreventingWrites,
  PreventedWrite,
  prohibitShardSwapping,
  shardSwappingProhibited,
  whilePreventingWrites,
} from "../src/connection_switching.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("preventing writes", () => {
  it("holds inside the block", async () => {
    await whilePreventingWrites(true, async () => {
      await tick();

      expect(currentPreventingWrites()).toBe(true);
      expect(() => checkWriteAllowed("insert")).toThrow(PreventedWrite);
    });
  });

  it("is over when the block is", async () => {
    await whilePreventingWrites(true, async () => tick());

    expect(currentPreventingWrites()).toBe(false);
  });

  /** The regression: this concurrent write used to throw. */
  it("does not reach work running beside it", async () => {
    let seen: boolean | undefined;

    await Promise.all([
      whilePreventingWrites(true, async () => {
        await tick();
        await tick();
      }),
      (async () => {
        await tick();
        seen = currentPreventingWrites();
        checkWriteAllowed("insert");
      })(),
    ]);

    expect(seen).toBe(false);
  });

  it("still reaches work running inside it", async () => {
    let seen: boolean | undefined;

    await whilePreventingWrites(true, async () => {
      await Promise.all([
        (async () => {
          await tick();
          seen = currentPreventingWrites();
        })(),
        tick(),
      ]);
    });

    expect(seen).toBe(true);
  });

  it("nests, and an inner block does not lift an outer one", async () => {
    await whilePreventingWrites(true, async () => {
      await whilePreventingWrites(true, async () => tick());

      expect(currentPreventingWrites()).toBe(true);
    });

    expect(currentPreventingWrites()).toBe(false);
  });

  /**
   * No `finally` to get right: leaving the scope restores what surrounded it,
   * so a throwing body cannot leave the process refusing writes.
   */
  it("is over even when the block throws", async () => {
    await expect(
      whilePreventingWrites(true, () => {
        throw new Error("from the body");
      }),
    ).rejects.toThrow("from the body");

    expect(currentPreventingWrites()).toBe(false);
  });

  it("does nothing when it was not asked to", async () => {
    await whilePreventingWrites(false, async () => {
      await tick();

      expect(currentPreventingWrites()).toBe(false);
    });
  });
});

describe("prohibiting shard swaps", () => {
  it("holds inside the block", async () => {
    await prohibitShardSwapping(true, async () => {
      await tick();

      expect(shardSwappingProhibited()).toBe(true);
      expect(() => checkShardSwap("other")).toThrow(/shard swapping is prohibited/);
    });
  });

  /**
   * The same leak, and worse where it lands: a shard is usually a tenant, so
   * a spurious refusal is a request that cannot reach its own data.
   */
  it("does not reach work running beside it", async () => {
    let seen: boolean | undefined;

    await Promise.all([
      prohibitShardSwapping(true, async () => {
        await tick();
        await tick();
      }),
      (async () => {
        await tick();
        seen = shardSwappingProhibited();
        checkShardSwap("other");
      })(),
    ]);

    expect(seen).toBe(false);
  });

  it("is over even when the block throws", async () => {
    await expect(
      prohibitShardSwapping(true, () => {
        throw new Error("from the body");
      }),
    ).rejects.toThrow("from the body");

    expect(shardSwappingProhibited()).toBe(false);
  });

  it("nests", async () => {
    await prohibitShardSwapping(true, async () => {
      await prohibitShardSwapping(true, async () => tick());

      expect(shardSwappingProhibited()).toBe(true);
    });

    expect(shardSwappingProhibited()).toBe(false);
  });
});

describe("the two together", () => {
  /** Separate scopes: prohibiting a swap is not preventing a write. */
  it("do not stand in for each other", async () => {
    await prohibitShardSwapping(true, async () => {
      await tick();

      expect(shardSwappingProhibited()).toBe(true);
      expect(currentPreventingWrites()).toBe(false);
    });

    await whilePreventingWrites(true, async () => {
      await tick();

      expect(currentPreventingWrites()).toBe(true);
      expect(shardSwappingProhibited()).toBe(false);
    });
  });
});
