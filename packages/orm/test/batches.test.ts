/**
 * Batched iteration.
 *
 * Mirrors activerecord/test/cases/batches_test.rb. The tests that matter here
 * are the ones about mutating while iterating: a batching helper exists so a
 * long job can walk a table it is also changing, and one built on OFFSET
 * cannot do that — which is what this file is here to keep true.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Model, SchemaStatements, setConnection } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { testConnection } from "./support/database.js";

interface ItemRow {
  id: number;
  name: string;
  processed: number;
}

class Item extends Model<ItemRow>("items") {}

let connection: Connection;

async function seed(count: number): Promise<void> {
  connection = await testConnection();
  setConnection(connection);
  Item.resetColumnInformation();

  await new SchemaStatements(connection).createTable("items", (t) => {
    t.string("name");
    t.integer("processed", { default: 0 });
  });

  for (let i = 1; i <= count; i += 1) await Item.create({ name: `item-${i}`, processed: 0 });
}

const names = async (): Promise<string[]> =>
  (await Item.order("id")).map((item) => item.name as string);

beforeEach(async () => {
  await seed(20);
});

describe("findEach", () => {
  it("yields every record", async () => {
    const seen: string[] = [];
    for await (const item of Item.all().findEach({ batchSize: 3 })) seen.push(item.name as string);

    expect(seen).toEqual(await names());
  });

  it("yields them in primary key order", async () => {
    const ids: number[] = [];
    for await (const item of Item.all().findEach({ batchSize: 7 })) ids.push(item.id as number);

    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it("honours the conditions it was chained onto", async () => {
    await Item.where({ name: "item-1" }).updateAll({ processed: 1 });

    const seen: string[] = [];
    for await (const item of Item.where({ processed: 1 }).findEach({ batchSize: 2 })) {
      seen.push(item.name as string);
    }

    expect(seen).toEqual(["item-1"]);
  });

  it("yields nothing for an empty table", async () => {
    await Item.all().deleteAll();

    const seen = [];
    for await (const item of Item.all().findEach()) seen.push(item);

    expect(seen).toEqual([]);
  });

  it("walks backwards when told to", async () => {
    const ids: number[] = [];
    for await (const item of Item.all().findEach({ batchSize: 4, order: "desc" })) {
      ids.push(item.id as number);
    }

    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(ids).toHaveLength(20);
  });

  // The whole reason this is a cursor and not an OFFSET. A queue drained with
  // `destroy` inside the loop missed half its rows before; the offsets shifted
  // underneath the walk, and nothing said so.
  it("misses nothing when the block deletes as it goes", async () => {
    const seen: string[] = [];

    for await (const item of Item.all().findEach({ batchSize: 5 })) {
      seen.push(item.name as string);
      await item.destroy();
    }

    expect(seen).toHaveLength(20);
    expect(await Item.count()).toBe(0);
  });

  it("misses nothing when the block narrows the set it is walking", async () => {
    const seen: string[] = [];

    for await (const item of Item.where({ processed: 0 }).findEach({ batchSize: 5 })) {
      seen.push(item.name as string);
      await item.update({ processed: 1 });
    }

    expect(seen).toHaveLength(20);
  });

  // A row inserted behind the cursor is not seen, and a row inserted ahead of
  // it is. That is what a cursor means, and it is worth being explicit that it
  // is the behaviour rather than an accident.
  it("sees rows added ahead of the cursor, not behind it", async () => {
    const seen: string[] = [];
    let added = false;

    for await (const item of Item.all().findEach({ batchSize: 5 })) {
      seen.push(item.name as string);

      if (!added) {
        added = true;
        await Item.create({ name: "added-later", processed: 0 });
      }
    }

    expect(seen).toContain("added-later");
    expect(seen).toHaveLength(21);
  });
});

describe("findInBatches", () => {
  it("yields arrays of the size asked for", async () => {
    const sizes: number[] = [];
    for await (const batch of Item.all().findInBatches({ batchSize: 6 })) sizes.push(batch.length);

    expect(sizes).toEqual([6, 6, 6, 2]);
  });

  it("does not yield an empty last batch", async () => {
    const sizes: number[] = [];
    for await (const batch of Item.all().findInBatches({ batchSize: 5 })) sizes.push(batch.length);

    expect(sizes).toEqual([5, 5, 5, 5]);
  });

  it("reads one query's worth at a time, not the table", async () => {
    const sizes: number[] = [];
    for await (const batch of Item.all().findInBatches({ batchSize: 3 })) {
      sizes.push(batch.length);
      if (sizes.length === 2) break;
    }

    expect(sizes).toEqual([3, 3]);
  });
});

describe("inBatches", () => {
  it("gives a relation over each batch", async () => {
    const counts: number[] = [];
    for await (const batch of Item.all().inBatches({ batchSize: 8 })) {
      counts.push(await batch.relation.count());
    }

    expect(counts).toEqual([8, 8, 4]);
  });

  // What the method is for: a long update, split so it does not hold one lock
  // across the whole table.
  it("lets each batch be updated in one statement", async () => {
    for await (const batch of Item.all().inBatches({ batchSize: 7 })) {
      await batch.relation.updateAll({ processed: 1 });
    }

    expect(await Item.where({ processed: 1 }).count()).toBe(20);
  });

  it("hands over the keys it read", async () => {
    const keys: unknown[] = [];
    for await (const batch of Item.all().inBatches({ batchSize: 9 })) keys.push(...batch.keys);

    expect(keys).toHaveLength(20);
  });

  // A relation is a thenable, and an async generator awaits what it yields.
  // Yielding one directly would hand back a loaded array and undo the point.
  it("yields something that is not itself a promise", async () => {
    for await (const batch of Item.all().inBatches({ batchSize: 20 })) {
      expect(Array.isArray(batch)).toBe(false);
      expect(batch.relation).toBeDefined();
    }
  });
});

describe("where a walk starts and stops", () => {
  it("starts at the key it was given", async () => {
    const ids: number[] = [];
    for await (const item of Item.all().findEach({ batchSize: 3, start: 15 })) {
      ids.push(item.id as number);
    }

    expect(ids[0]).toBe(15);
    expect(ids).toHaveLength(6);
  });

  it("stops at the key it was given", async () => {
    const ids: number[] = [];
    for await (const item of Item.all().findEach({ batchSize: 3, finish: 5 })) {
      ids.push(item.id as number);
    }

    expect(ids).toEqual([1, 2, 3, 4, 5]);
  });

  it("takes both", async () => {
    const ids: number[] = [];
    for await (const item of Item.all().findEach({ batchSize: 2, start: 8, finish: 11 })) {
      ids.push(item.id as number);
    }

    expect(ids).toEqual([8, 9, 10, 11]);
  });

  // A limit is a cap on the walk, not on each batch — the other reading would
  // make `limit(5)` mean "five per batch, forever".
  it("respects a limit as a total", async () => {
    const ids: number[] = [];
    for await (const item of Item.all().limit(7).findEach({ batchSize: 3 })) {
      ids.push(item.id as number);
    }

    expect(ids).toHaveLength(7);
  });
});

describe("what it refuses", () => {
  // Rails ignores the order and logs a warning. Coming back in a different
  // order than asked for is a bug found much later than this message.
  it("refuses an ordered relation, and says why", async () => {
    const walk = async () => {
      for await (const item of Item.order("name").findEach()) void item;
    };

    await expect(walk()).rejects.toThrow(/batching walks the id/);
  });

  it("refuses a select without the key the cursor reads", async () => {
    const walk = async () => {
      for await (const item of Item.all().select("name").findEach()) void item;
    };

    await expect(walk()).rejects.toThrow(/needs id in the select/);
  });

  it("refuses a batch size below one", async () => {
    const walk = async () => {
      for await (const item of Item.all().findEach({ batchSize: 0 })) void item;
    };

    await expect(walk()).rejects.toThrow(/at least 1/);
  });
});

describe("pluck", () => {
  it("takes one column as values", async () => {
    expect(await Item.where({ name: "item-3" }).pluck("name")).toEqual(["item-3"]);
  });

  it("takes several as rows", async () => {
    expect(await Item.where({ name: "item-3" }).pluck("id", "name")).toEqual([[3, "item-3"]]);
  });

  it("keeps the columns in the order asked for", async () => {
    expect(await Item.where({ name: "item-3" }).pluck("name", "id")).toEqual([["item-3", 3]]);
  });
});
