/**
 * Work that runs just before a transaction commits, ported from the
 * `before_commit` cases in
 * `activerecord/test/cases/transaction_callbacks_test.rb`.
 *
 * The whole difference from `afterCommit` is that this one still has something
 * to undo. A consistency check that discovered a problem after the commit
 * would be a check that could only report it.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Model, SchemaStatements, setConnection } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import {
  addTransactionRecord,
  afterCommit,
  beforeCommit,
  commitRecords,
  hasTransactionRecord,
} from "../src/after-commit.js";
import { isSqlite, testConnection } from "./support/database.js";

interface AccountRow {
  id: number;
  name: string;
  balance: number;
}

class Account extends Model<AccountRow>("accounts") {}

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  Account.resetColumnInformation();

  await new SchemaStatements(connection).createTable("accounts", (t) => {
    t.string("name");
    t.integer("balance");
  });
});

afterEach(async () => {
  if (isSqlite) await connection.close();
});

describe("beforeCommit", () => {
  it("runs before the transaction commits", async () => {
    const order: string[] = [];

    await connection.transaction(async () => {
      await beforeCommit(() => void order.push("before"));
      await afterCommit(() => void order.push("after"));

      order.push("body");
    });

    expect(order).toEqual(["body", "before", "after"]);
  });

  /**
   * The point. Throwing from afterCommit cannot undo anything; throwing from
   * here rolls the whole transaction back.
   */
  it("rolls the transaction back when it throws", async () => {
    await connection
      .transaction(async () => {
        await Account.create({ name: "a", balance: 10 });

        await beforeCommit(() => {
          throw new Error("balance must not be negative");
        });
      })
      .catch(() => undefined);

    expect(await Account.all().count()).toBe(0);
  });

  it("lets the error reach the caller", async () => {
    expect(
      connection.transaction(async () => {
        await beforeCommit(() => {
          throw new Error("refused");
        });
      }),
    ).rejects.toThrow("refused");
  });

  /** A failed before-commit is a failed transaction, so nothing committed. */
  it("does not run the after-commit callbacks when it throws", async () => {
    let ran = false;

    await connection
      .transaction(async () => {
        await afterCommit(() => void (ran = true));
        await beforeCommit(() => {
          throw new Error("refused");
        });
      })
      .catch(() => undefined);

    expect(ran).toBe(false);
  });

  it("runs the rollback callbacks when it throws", async () => {
    let rolled = false;

    await connection
      .transaction(async () => {
        const { afterRollback } = await import("../src/after-commit.js");

        afterRollback(() => void (rolled = true));

        await beforeCommit(() => {
          throw new Error("refused");
        });
      })
      .catch(() => undefined);

    expect(rolled).toBe(true);
  });

  it("runs several in the order they were added", async () => {
    const order: string[] = [];

    await connection.transaction(async () => {
      await beforeCommit(() => void order.push("one"));
      await beforeCommit(() => void order.push("two"));
    });

    expect(order).toEqual(["one", "two"]);
  });

  it("can still see the transaction's own writes", async () => {
    let seen = 0;

    await connection.transaction(async () => {
      await Account.create({ name: "a", balance: 10 });

      await beforeCommit(async () => {
        seen = await Account.all().count();
      });
    });

    expect(seen).toBe(1);
  });

  /** Nothing to wait for, and nothing to roll back. */
  it("runs immediately with no transaction in progress", async () => {
    let ran = false;

    await beforeCommit(() => void (ran = true));

    expect(ran).toBe(true);
  });

  it("lets a throw through immediately with no transaction", async () => {
    expect(
      beforeCommit(() => {
        throw new Error("refused");
      }),
    ).rejects.toThrow("refused");
  });
});

describe("the records a transaction is carrying", () => {
  it("starts empty", async () => {
    await connection.transaction(async () => {
      expect(commitRecords()).toEqual([]);
    });
  });

  it("remembers one that was added", async () => {
    await connection.transaction(async () => {
      const account = await Account.create({ name: "a", balance: 1 });

      addTransactionRecord(account);

      expect(commitRecords()).toHaveLength(1);
      expect(hasTransactionRecord(account)).toBe(true);
    });
  });

  /** A record saved three times in one transaction is considered once. */
  it("counts a record once however often it is added", async () => {
    await connection.transaction(async () => {
      const account = await Account.create({ name: "a", balance: 1 });

      addTransactionRecord(account);
      addTransactionRecord(account);
      addTransactionRecord(account);

      expect(commitRecords()).toHaveLength(1);
    });
  });

  it("keeps two different records apart", async () => {
    await connection.transaction(async () => {
      addTransactionRecord(await Account.create({ name: "a", balance: 1 }));
      addTransactionRecord(await Account.create({ name: "b", balance: 1 }));

      expect(commitRecords()).toHaveLength(2);
    });
  });

  it("says no for a record nobody added", async () => {
    await connection.transaction(async () => {
      const account = await Account.create({ name: "a", balance: 1 });

      expect(hasTransactionRecord(account)).toBe(false);
    });
  });

  it("is empty again outside the transaction", async () => {
    await connection.transaction(async () => {
      addTransactionRecord(await Account.create({ name: "a", balance: 1 }));
    });

    expect(commitRecords()).toEqual([]);
  });

  it("is quiet when there is no transaction at all", () => {
    expect(() => {
      addTransactionRecord({});
    }).not.toThrow();

    expect(commitRecords()).toEqual([]);
    expect(hasTransactionRecord({})).toBe(false);
  });
});
