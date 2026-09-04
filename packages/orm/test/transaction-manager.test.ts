/**
 * When a BEGIN is actually sent, ported from
 * `activerecord/test/cases/transactions_test.rb` and the lazy-transaction
 * cases in `activerecord/test/cases/adapters/.../transaction_test.rb`.
 *
 * The interesting assertions here are about what was *not* sent. A block that
 * only reads should open and close without the database hearing about it,
 * because an open transaction pins an MVCC snapshot, holds its connection, and
 * is what `idle_in_transaction_session_timeout` eventually kills.
 *
 * The driver is a recorder rather than a database, since "did not send a
 * BEGIN" cannot be asserted against one.
 */

import { describe, expect, it } from "bun:test";
import {
  TRANSACTION_ISOLATION_LEVELS,
  TransactionManager,
  TransactionState,
  UnknownIsolationLevel,
  checkIsolationLevel,
  transactionIsolationLevels,
} from "../src/transaction-manager.js";
import type { IsolationLevel, TransactionDriver } from "../src/transaction-manager.js";

/** Records what would have been sent. */
function recorder(
  overrides: Partial<TransactionDriver> = {},
): TransactionDriver & { sent: string[] } {
  const sent: string[] = [];

  return {
    sent,
    beginDbTransaction: async () => void sent.push("BEGIN"),
    beginIsolatedDbTransaction: async (level: IsolationLevel) =>
      void sent.push(`BEGIN ISOLATION ${level}`),
    commitDbTransaction: async () => void sent.push("COMMIT"),
    execRollbackDbTransaction: async () => void sent.push("ROLLBACK"),
    createSavepoint: async (name: string) => void sent.push(`SAVEPOINT ${name}`),
    execRollbackToSavepoint: async (name: string) => void sent.push(`ROLLBACK TO ${name}`),
    releaseSavepoint: async (name: string) => void sent.push(`RELEASE ${name}`),
    ...overrides,
  };
}

describe("a block that only reads", () => {
  /** The whole point: the database never hears about it. */
  it("sends no BEGIN at all", async () => {
    const driver = recorder();
    const manager = new TransactionManager(driver);

    await manager.withinNewTransaction(async () => "read something");

    expect(driver.sent).toEqual([]);
  });

  it("still returns what the block returned", async () => {
    const manager = new TransactionManager(recorder());

    expect(await manager.withinNewTransaction(async () => 42)).toBe(42);
  });

  it("sends no COMMIT either, since nothing began", async () => {
    const driver = recorder();
    const manager = new TransactionManager(driver);

    await manager.withinNewTransaction(async () => undefined);

    expect(driver.sent).not.toContain("COMMIT");
  });

  it("counts as committed anyway", async () => {
    const manager = new TransactionManager(recorder());
    let state: TransactionState | undefined;

    await manager.withinNewTransaction(async (transaction) => {
      state = transaction;
    });

    expect(state?.fullyCommitted()).toBe(true);
  });

  it("sends no ROLLBACK when one that never began throws", async () => {
    const driver = recorder();
    const manager = new TransactionManager(driver);

    await expect(
      manager.withinNewTransaction(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(driver.sent).toEqual([]);
  });

  it("leaves the stack empty afterwards", async () => {
    const manager = new TransactionManager(recorder());

    await manager.withinNewTransaction(async () => undefined);

    expect(manager.open).toBe(false);
    expect(manager.depth).toBe(0);
  });
});

describe("a block that writes", () => {
  it("sends the BEGIN when something is about to write", async () => {
    const driver = recorder();
    const manager = new TransactionManager(driver);

    await manager.withinNewTransaction(async () => {
      manager.dirtyCurrentTransaction();
      await manager.materializeTransactions();
    });

    expect(driver.sent).toEqual(["BEGIN", "COMMIT"]);
  });

  it("sends the BEGIN only once however often it is asked", async () => {
    const driver = recorder();
    const manager = new TransactionManager(driver);

    await manager.withinNewTransaction(async () => {
      await manager.materializeTransactions();
      await manager.materializeTransactions();
      await manager.materializeTransactions();
    });

    expect(driver.sent.filter((each) => each === "BEGIN")).toHaveLength(1);
  });

  it("rolls back what it began", async () => {
    const driver = recorder();
    const manager = new TransactionManager(driver);

    await expect(
      manager.withinNewTransaction(async () => {
        await manager.materializeTransactions();
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(driver.sent).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("marks the transaction dirty", async () => {
    const manager = new TransactionManager(recorder());
    let state: TransactionState | undefined;

    await manager.withinNewTransaction(async (transaction) => {
      state = transaction;
      manager.dirtyCurrentTransaction();
    });

    expect(state?.dirty).toBe(true);
  });
});

describe("when lazy is off", () => {
  /**
   * For a `SELECT ... FOR UPDATE` taken before any write: outside a
   * transaction it locks nothing and returns immediately.
   */
  it("sends the BEGIN up front", async () => {
    const driver = recorder();
    const manager = new TransactionManager(driver);
    manager.disableLazyTransactions();

    await manager.withinNewTransaction(async () => "only read");

    expect(driver.sent).toEqual(["BEGIN", "COMMIT"]);
  });

  it("says which mode it is in", () => {
    const manager = new TransactionManager(recorder());

    expect(manager.lazyTransactionsEnabled()).toBe(true);

    manager.disableLazyTransactions();

    expect(manager.lazyTransactionsEnabled()).toBe(false);

    manager.enableLazyTransactions();

    expect(manager.lazyTransactionsEnabled()).toBe(true);
  });
});

describe("nesting", () => {
  it("makes the inner one a savepoint", async () => {
    const driver = recorder();
    const manager = new TransactionManager(driver);

    await manager.withinNewTransaction(async () => {
      await manager.withinNewTransaction(async () => {
        await manager.materializeTransactions();
      });
    });

    expect(driver.sent[0]).toBe("BEGIN");
    expect(driver.sent[1]).toStartWith("SAVEPOINT");
  });

  /** A savepoint is meaningless inside a transaction that has not begun. */
  it("begins the outer one before the savepoint", async () => {
    const driver = recorder();
    const manager = new TransactionManager(driver);

    await manager.withinNewTransaction(async () => {
      await manager.withinNewTransaction(async () => {
        await manager.materializeTransactions();
      });
    });

    expect(driver.sent.indexOf("BEGIN")).toBeLessThan(
      driver.sent.findIndex((each) => each.startsWith("SAVEPOINT")),
    );
  });

  it("releases the savepoint when the inner block finishes", async () => {
    const driver = recorder();
    const manager = new TransactionManager(driver);

    await manager.withinNewTransaction(async () => {
      await manager.withinNewTransaction(async () => {
        await manager.materializeTransactions();
      });
    });

    expect(driver.sent.some((each) => each.startsWith("RELEASE"))).toBe(true);
  });

  /** An inner block that throws undoes only its own work. */
  it("rolls back to the savepoint, not the whole transaction", async () => {
    const driver = recorder();
    const manager = new TransactionManager(driver);

    await manager.withinNewTransaction(async () => {
      await manager.materializeTransactions();

      await expect(
        manager.withinNewTransaction(async () => {
          await manager.materializeTransactions();
          throw new Error("inner");
        }),
      ).rejects.toThrow("inner");
    });

    expect(driver.sent.some((each) => each.startsWith("ROLLBACK TO"))).toBe(true);
    expect(driver.sent).not.toContain("ROLLBACK");
    expect(driver.sent).toContain("COMMIT");
  });

  it("gives each savepoint its own name", async () => {
    const driver = recorder();
    const manager = new TransactionManager(driver);

    await manager.withinNewTransaction(async () => {
      await manager.withinNewTransaction(async () => manager.materializeTransactions());
      await manager.withinNewTransaction(async () => manager.materializeTransactions());
    });

    const names = driver.sent.filter((each) => each.startsWith("SAVEPOINT"));

    expect(new Set(names).size).toBe(names.length);
  });

  it("reports the depth", async () => {
    const manager = new TransactionManager(recorder());

    await manager.withinNewTransaction(async () => {
      expect(manager.depth).toBe(1);

      await manager.withinNewTransaction(async () => {
        expect(manager.depth).toBe(2);
      });
    });

    expect(manager.depth).toBe(0);
  });

  it("says only the outermost unwinds everything", async () => {
    const manager = new TransactionManager(recorder());

    await manager.withinNewTransaction(async () => {
      expect(manager.fullRollback()).toBe(true);

      await manager.withinNewTransaction(async () => {
        expect(manager.fullRollback()).toBe(false);
      });
    });
  });
});

describe("isolation levels", () => {
  it("lists them", () => {
    expect(transactionIsolationLevels()).toEqual(TRANSACTION_ISOLATION_LEVELS);
    expect(transactionIsolationLevels()).toContain("serializable");
  });

  it("accepts one it knows", () => {
    expect(checkIsolationLevel("serializable")).toBe("serializable");
  });

  it("refuses one it does not", () => {
    expect(() => checkIsolationLevel("very isolated")).toThrow(UnknownIsolationLevel);
  });

  it("lists what it would accept", () => {
    expect(() => checkIsolationLevel("nope")).toThrow("repeatable read");
  });

  /** The level is part of the BEGIN, so a caller asking for one gets it eagerly. */
  it("begins immediately when a level is asked for", async () => {
    const driver = recorder();
    const manager = new TransactionManager(driver);

    await manager.withinNewTransaction(async () => "only read", { isolation: "serializable" });

    expect(driver.sent).toEqual(["BEGIN ISOLATION serializable", "COMMIT"]);
  });

  /**
   * A savepoint cannot change what the transaction around it sees, so asking
   * is always a mistake about what the code will do.
   */
  it("refuses one on a nested transaction", async () => {
    const manager = new TransactionManager(recorder());

    await manager.withinNewTransaction(async () => {
      await expect(
        manager.withinNewTransaction(async () => undefined, { isolation: "serializable" }),
      ).rejects.toThrow("outermost");
    });
  });

  it("refuses a level that is not one before opening anything", async () => {
    const driver = recorder();
    const manager = new TransactionManager(driver);

    await expect(
      manager.withinNewTransaction(async () => undefined, {
        isolation: "nonsense" as IsolationLevel,
      }),
    ).rejects.toThrow(UnknownIsolationLevel);

    expect(driver.sent).toEqual([]);
    expect(manager.depth).toBe(0);
  });
});

describe("savepoints that poison the transaction", () => {
  /**
   * MySQL is the reason: some errors leave the outer transaction unusable even
   * though the savepoint rolled back cleanly, so carrying on commits nothing
   * and reports success.
   */
  it("marks the outer transactions dirty when the adapter says so", async () => {
    const manager = new TransactionManager(
      recorder({ savepointErrorsInvalidateTransactions: true }),
    );

    await manager.withinNewTransaction(async (outer) => {
      await expect(
        manager.withinNewTransaction(async () => {
          throw new Error("inner");
        }),
      ).rejects.toThrow("inner");

      expect(outer.dirty).toBe(true);
    });
  });

  it("leaves them alone on an adapter where a savepoint is clean", async () => {
    const manager = new TransactionManager(recorder());

    await manager.withinNewTransaction(async (outer) => {
      await expect(
        manager.withinNewTransaction(async () => {
          throw new Error("inner");
        }),
      ).rejects.toThrow("inner");

      expect(outer.dirty).toBe(false);
    });
  });
});

describe("restoring after a lost connection", () => {
  it("can be restored while nothing has written", async () => {
    const manager = new TransactionManager(recorder());

    await manager.withinNewTransaction(async () => {
      expect(manager.isRestorable()).toBe(true);
      expect(await manager.restoreTransactions()).toBe(true);
    });
  });

  /**
   * Restoring a transaction that wrote would mean pretending those writes are
   * still pending when the database has been told to forget them.
   */
  it("cannot be once something has", async () => {
    const manager = new TransactionManager(recorder());

    await manager.withinNewTransaction(async () => {
      manager.dirtyCurrentTransaction();

      expect(manager.isRestorable()).toBe(false);
      expect(await manager.restoreTransactions()).toBe(false);
    });
  });

  it("sends the BEGIN again when it restores", async () => {
    const driver = recorder();
    const manager = new TransactionManager(driver);
    manager.disableLazyTransactions();

    await manager.withinNewTransaction(async () => {
      await manager.restoreTransactions();
    });

    expect(driver.sent.filter((each) => each === "BEGIN")).toHaveLength(2);
  });

  it("throws the stack away without touching the database", async () => {
    const driver = recorder();
    const manager = new TransactionManager(driver);
    manager.disableLazyTransactions();

    await manager.withinNewTransaction(async () => {
      manager.resetTransaction();
    });

    expect(manager.depth).toBe(0);
    expect(driver.sent).not.toContain("ROLLBACK");
  });
});

describe("restarting", () => {
  /** One round trip where rollback-then-begin is two, between every pair of tests. */
  it("uses the adapter's own restart where there is one", async () => {
    const sent: string[] = [];
    const manager = new TransactionManager(
      recorder({
        supportsRestartDbTransaction: true,
        execRestartDbTransaction: async () => void sent.push("RESTART"),
      }),
    );

    await manager.restartDbTransaction();

    expect(sent).toEqual(["RESTART"]);
  });

  it("falls back to rolling back and beginning again", async () => {
    const driver = recorder();
    const manager = new TransactionManager(driver);

    await manager.restartDbTransaction();

    expect(driver.sent).toEqual(["ROLLBACK", "BEGIN"]);
  });
});

describe("who opened it", () => {
  it("reports a transaction a caller asked for", async () => {
    const manager = new TransactionManager(recorder());

    await manager.withinNewTransaction(async () => {
      expect(manager.usesTransaction()).toBe(true);
      expect(manager.userTransaction()).toBe(manager.currentTransaction());
    });
  });

  it("does not count one opened implicitly", async () => {
    const manager = new TransactionManager(recorder());

    await manager.withinNewTransaction(async () => undefined, { joinable: false });

    expect(manager.usesTransaction()).toBe(false);
  });

  it("reports none when nothing is open", () => {
    const manager = new TransactionManager(recorder());

    expect(manager.currentTransaction()).toBeUndefined();
    expect(manager.usesTransaction()).toBe(false);
    expect(manager.fullRollback()).toBe(false);
  });
});

describe("callbacks and records", () => {
  it("runs before-commit callbacks before the COMMIT", async () => {
    const driver = recorder();
    const manager = new TransactionManager(driver);

    await manager.withinNewTransaction(async (transaction) => {
      await manager.materializeTransactions();
      transaction.beforeCommitCallbacks.push(() => void driver.sent.push("BEFORE"));
    });

    // Both assertions matter. `indexOf` gives -1 for a callback that never
    // ran, and -1 is less than every real index — so "came before COMMIT"
    // passes on its own even when nothing ran at all.
    expect(driver.sent).toContain("BEFORE");
    expect(driver.sent.indexOf("BEFORE")).toBeLessThan(driver.sent.indexOf("COMMIT"));
  });

  it("runs after-commit callbacks after it", async () => {
    const driver = recorder();
    const manager = new TransactionManager(driver);

    await manager.withinNewTransaction(async (transaction) => {
      await manager.materializeTransactions();
      transaction.afterCommitCallbacks.push(() => void driver.sent.push("AFTER"));
    });

    expect(driver.sent).toContain("AFTER");
    expect(driver.sent.indexOf("AFTER")).toBeGreaterThan(driver.sent.indexOf("COMMIT"));
  });

  it("runs rollback callbacks when it unwinds", async () => {
    const ran: string[] = [];
    const manager = new TransactionManager(recorder());

    await expect(
      manager.withinNewTransaction(async (transaction) => {
        transaction.afterRollbackCallbacks.push(() => void ran.push("rolled back"));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(ran).toEqual(["rolled back"]);
  });

  it("collects the records it touched", async () => {
    const manager = new TransactionManager(recorder());
    let state: TransactionState | undefined;

    await manager.withinNewTransaction(async (transaction) => {
      state = transaction;
      transaction.addRecord({ id: 1 });
      transaction.addRecord({ id: 2 });
    });

    expect(state?.records).toHaveLength(2);
  });

  it("reports the two callback lists by their Rails names", async () => {
    const manager = new TransactionManager(recorder());

    await manager.withinNewTransaction(async (transaction) => {
      transaction.beforeCommitCallbacks.push(() => undefined);
      transaction.afterRollbackCallbacks.push(() => undefined);

      expect(transaction.beforeCommitRecords()).toHaveLength(1);
      expect(transaction.rollbackRecords()).toHaveLength(1);
    });
  });
});
