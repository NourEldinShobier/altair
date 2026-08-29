/**
 * Work deferred until a transaction commits.
 *
 * Mirrors activerecord/test/cases/transaction_callbacks_test.rb. The tests
 * that matter are the rollback ones: the whole reason `after_commit` exists is
 * that `after_create` fires for work that is then undone, and a suite that
 * only ever commits would not notice the difference.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { errors } from "@altair/support";
import { Model, SchemaStatements, setConnection } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { testConnection } from "./support/database.js";

interface OrderRow {
  id: number;
  reference: string;
  total: number;
}

let events: string[] = [];

class Order extends Model<OrderRow>("orders") {
  static {
    this.afterCommit(function (this: Order) {
      events.push(`committed:${String(this.reference)}`);
    });

    this.afterCommit(
      function (this: Order) {
        events.push(`created:${String(this.reference)}`);
      },
      { on: "create" },
    );

    this.afterCommit(
      function (this: Order) {
        events.push(`updated:${String(this.reference)}`);
      },
      { on: "update" },
    );

    this.afterCommit(
      function (this: Order) {
        events.push(`destroyed:${String(this.reference)}`);
      },
      { on: "destroy" },
    );

    this.afterRollback(function (this: Order) {
      events.push(`rolled back:${String(this.reference)}`);
    });

    // The mistake this file exists to make visible: a callback that fires
    // whether or not the work survives.
    this.setCallback("create", "after", function (this: Order) {
      events.push(`eagerly enqueued:${String(this.reference)}`);
    });
  }
}

let connection: Connection;

beforeEach(async () => {
  events = [];
  connection = await testConnection();
  setConnection(connection);
  Order.columnCache = undefined;
  Order.columnTypeCache = undefined;

  const schema = new SchemaStatements(connection);
  await schema.dropTable("orders", { ifExists: true });
  await schema.createTable("orders", (t) => {
    t.string("reference");
    t.integer("total", { default: 0 });
  });
});

describe("with no transaction", () => {
  // A model cannot know whether its caller opened one, so the same code has to
  // be right either way.
  it("runs the callback straight away", async () => {
    await Order.create({ reference: "A" });

    expect(events).toContain("committed:A");
    expect(events).toContain("created:A");
  });

  it("tells an update from a create", async () => {
    const order = await Order.create({ reference: "A" });
    events = [];

    await order.update({ total: 5 });

    expect(events).toContain("updated:A");
    expect(events).not.toContain("created:A");
  });

  it("runs the destroy callback", async () => {
    const order = await Order.create({ reference: "A" });
    events = [];

    await order.destroy();

    expect(events).toContain("committed:A");
    expect(events).toContain("destroyed:A");
  });

  it("never runs the rollback callback", async () => {
    await Order.create({ reference: "A" });

    expect(events.some((event) => event.startsWith("rolled back"))).toBe(false);
  });
});

describe("inside a transaction that commits", () => {
  it("waits until the transaction is over", async () => {
    await connection.transaction(async () => {
      await Order.create({ reference: "A" });

      // The row is written, but nothing outside may hear about it yet.
      expect(events).toEqual(["eagerly enqueued:A"]);
    });

    expect(events).toContain("created:A");
  });

  it("runs them in the order they were registered", async () => {
    await connection.transaction(async () => {
      await Order.create({ reference: "A" });
      await Order.create({ reference: "B" });
    });

    expect(events.filter((event) => event.startsWith("created"))).toEqual([
      "created:A",
      "created:B",
    ]);
  });
});

// The bug the whole feature is for. A job enqueued inside the transaction is
// enqueued whether or not it commits, so a rollback leaves a worker holding
// the id of a row that never existed.
describe("inside a transaction that rolls back", () => {
  const failing = async () => {
    await connection
      .transaction(async () => {
        await Order.create({ reference: "A" });
        throw new Error("something went wrong later in the request");
      })
      .catch(() => undefined);
  };

  it("does not run the commit callback", async () => {
    await failing();

    expect(events).not.toContain("created:A");
    expect(events).not.toContain("committed:A");
  });

  it("runs the rollback callback instead", async () => {
    await failing();

    expect(events).toContain("rolled back:A");
  });

  it("wrote nothing, which is the point", async () => {
    await failing();

    expect(await Order.count()).toBe(0);
  });

  // The contrast, spelled out: an ordinary after_create fires either way, and
  // that is exactly the production bug.
  it("shows what an ordinary callback would have done", async () => {
    await failing();

    expect(events).toContain("eagerly enqueued:A");
  });

  it("lets the original error through", async () => {
    await expect(
      connection.transaction(async () => {
        await Order.create({ reference: "A" });
        throw new Error("the real problem");
      }),
    ).rejects.toThrow("the real problem");
  });
});

// A savepoint releasing has committed nothing, so its callbacks belong to the
// outermost transaction. Running them at the inner release would bring back
// the very bug this is here to prevent.
describe("nested transactions", () => {
  it("waits for the outermost transaction", async () => {
    await connection.transaction(async (outer) => {
      await outer.transaction(async () => {
        await Order.create({ reference: "inner" });
      });

      expect(events).not.toContain("created:inner");
    });

    expect(events).toContain("created:inner");
  });

  it("still runs them when only an inner block failed", async () => {
    await connection.transaction(async (outer) => {
      await Order.create({ reference: "outer" });

      await outer
        .transaction(async () => {
          throw new Error("inner failed");
        })
        .catch(() => undefined);
    });

    expect(events).toContain("created:outer");
    expect(await Order.count()).toBe(1);
  });
});

describe("a callback that throws", () => {
  // The transaction has already committed. Throwing would tell the caller the
  // write failed when it did not, and there is nothing left to undo — and it
  // has to behave the same inside a transaction and outside one, or the bug
  // depends on who called you.
  it("does not undo the save, and reports itself", async () => {
    class Fragile extends Model<OrderRow>("orders") {
      static {
        this.afterCommit(() => {
          throw new Error("the mailer is down");
        });
      }
    }

    Fragile.columnCache = undefined;
    Fragile.columnTypeCache = undefined;

    const reported: unknown[] = [];
    const subscription = errors.subscribe((error) => reported.push(error));

    try {
      await expect(Fragile.create({ reference: "A" })).resolves.toBeDefined();
      expect(await Order.count()).toBe(1);
      expect(reported).toHaveLength(1);
    } finally {
      subscription.unsubscribe();
    }
  });

  it("behaves the same inside a transaction", async () => {
    class AlsoFragile extends Model<OrderRow>("orders") {
      static {
        this.afterCommit(() => {
          throw new Error("the mailer is still down");
        });
      }
    }

    AlsoFragile.columnCache = undefined;
    AlsoFragile.columnTypeCache = undefined;

    await expect(
      connection.transaction(async () => {
        await AlsoFragile.create({ reference: "B" });
      }),
    ).resolves.toBeUndefined();

    expect(await Order.count()).toBe(1);
  });
});
