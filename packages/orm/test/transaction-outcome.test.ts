/**
 * How a transaction ended and what that means for its records, ported from
 * `activerecord/test/cases/transactions_test.rb` and the savepoint cases in
 * `activerecord/test/cases/transaction_isolation_test.rb`.
 *
 * The three endings are the whole point, and confusing any two of them
 * produces in-memory objects that are internally consistent and describe rows
 * that are not there — which nothing reports.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { UnknownIsolationLevel } from "../src/transaction-manager.js";
import {
  addAfterCommitJobsCallback,
  addDefaultCallbacks,
  beforeCommitted,
  disableDdlTransaction,
  forgetAfterCommitJobs,
  fullyRolledback,
  incomplete,
  invalidate,
  invalidated,
  isolationStatement,
  newOutcomeState,
  poolTransactionIsolationLevel,
  resetIsolationLevel,
  restartable,
  restorableFromOutcome,
  rollbackDbTransaction,
  rolledback,
  settle,
  runAfterCommitJobs,
  withPoolTransactionIsolationLevel,
} from "../src/transaction-outcome.js";

afterEach(() => {
  resetIsolationLevel();
});

describe("how a transaction ended", () => {
  it("is undecided while open", () => {
    const state = newOutcomeState();

    expect(incomplete(state)).toBe(true);
    expect(rolledback(state)).toBe(false);
    expect(invalidated(state)).toBe(false);
  });

  it("records a commit", () => {
    const state = newOutcomeState();
    settle(state, "committed");

    expect(incomplete(state)).toBe(false);
    expect(rolledback(state)).toBe(false);
  });

  /**
   * Being told twice means something above reported an outcome it did not own,
   * and taking the second answer misinforms every record attached — the
   * failure would then surface in whichever object was saved.
   */
  it("refuses a second outcome", () => {
    const state = newOutcomeState();
    settle(state, "committed");

    expect(() => settle(state, "rolledback")).toThrow("already committed");
  });
});

describe("rolled back versus fully rolled back", () => {
  /**
   * A record whose savepoint went back inside a transaction that committed has
   * had some of its work kept, and restoring would discard changes the
   * database still holds.
   */
  it("tells a savepoint rollback from a whole one", () => {
    const outer = newOutcomeState();
    const savepoint = newOutcomeState({ savepoint: true, parent: outer });

    settle(savepoint, "rolledback");
    settle(outer, "committed");

    expect(rolledback(savepoint)).toBe(true);
    expect(fullyRolledback(savepoint)).toBe(false);
    expect(restorableFromOutcome(savepoint)).toBe(false);
  });

  it("counts a savepoint as fully rolled back when its parent went too", () => {
    const outer = newOutcomeState();
    const savepoint = newOutcomeState({ savepoint: true, parent: outer });

    settle(savepoint, "rolledback");
    settle(outer, "rolledback");

    expect(fullyRolledback(savepoint)).toBe(true);
    expect(restorableFromOutcome(savepoint)).toBe(true);
  });

  it("counts an outermost rollback as fully rolled back, and as rolled back", () => {
    const state = newOutcomeState();
    settle(state, "fullyRolledback");

    expect(fullyRolledback(state)).toBe(true);
    // Both, because a caller asking the weaker question must not be told no.
    expect(rolledback(state)).toBe(true);
  });

  it("counts a committed transaction as neither", () => {
    const state = newOutcomeState();
    settle(state, "committed");

    expect(fullyRolledback(state)).toBe(false);
    expect(restorableFromOutcome(state)).toBe(false);
  });

  /**
   * A record attached to an inner savepoint can only learn that its outer
   * transaction went from here.
   */
  it("marks every open state when the outermost unwinds", () => {
    const outer = newOutcomeState();
    const savepoint = newOutcomeState({ savepoint: true, parent: outer });

    rollbackDbTransaction([outer, savepoint]);

    expect(fullyRolledback(savepoint)).toBe(true);
    expect(fullyRolledback(outer)).toBe(true);
  });

  it("leaves a state that already ended alone", () => {
    const state = newOutcomeState();
    settle(state, "committed");

    rollbackDbTransaction([state]);

    expect(fullyRolledback(state)).toBe(false);
  });
});

describe("a connection that went away", () => {
  /**
   * Nothing was rolled back: the work may be in the database, and telling
   * records otherwise is worse than telling them nothing.
   */
  it("is not a rollback", () => {
    const state = invalidate(newOutcomeState());

    expect(invalidated(state)).toBe(true);
    expect(rolledback(state)).toBe(false);
    expect(fullyRolledback(state)).toBe(false);
    expect(restorableFromOutcome(state)).toBe(false);
  });
});

describe("retrying in place", () => {
  /**
   * Only a savepoint. Restarting the outermost means ROLLBACK has already
   * gone, so "restarting" begins a transaction sharing nothing with the old
   * one — including anything it had written.
   */
  it("allows a savepoint that rolled back", () => {
    const outer = newOutcomeState();
    const savepoint = newOutcomeState({ savepoint: true, parent: outer });
    settle(savepoint, "rolledback");

    expect(restartable(savepoint)).toBe(true);
  });

  it("refuses the outermost", () => {
    const state = newOutcomeState();
    settle(state, "fullyRolledback");

    expect(restartable(state)).toBe(false);
  });

  it("refuses a savepoint whose parent also went", () => {
    const outer = newOutcomeState();
    const savepoint = newOutcomeState({ savepoint: true, parent: outer });
    settle(savepoint, "rolledback");
    settle(outer, "rolledback");

    expect(restartable(savepoint)).toBe(false);
  });

  it("refuses one that is still open", () => {
    expect(restartable(newOutcomeState({ savepoint: true }))).toBe(false);
  });
});

describe("isolation for a pooled connection", () => {
  it("is unset to begin with", () => {
    expect(poolTransactionIsolationLevel()).toBeUndefined();
  });

  it("holds for the length of a block", async () => {
    await withPoolTransactionIsolationLevel("serializable", () => {
      expect(poolTransactionIsolationLevel()).toBe("serializable");
    });

    expect(poolTransactionIsolationLevel()).toBeUndefined();
  });

  /**
   * A level left set applies to every later transaction on that connection,
   * and what it breaks is whichever unrelated code next takes the connection
   * out of the pool.
   */
  it("is restored when the block throws", async () => {
    await expect(
      withPoolTransactionIsolationLevel("serializable", () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(poolTransactionIsolationLevel()).toBeUndefined();
  });

  it("restores an outer level rather than clearing", async () => {
    await withPoolTransactionIsolationLevel("read committed", async () => {
      await withPoolTransactionIsolationLevel("serializable", () => undefined);

      expect(poolTransactionIsolationLevel()).toBe("read committed");
    });
  });

  /**
   * Validated through the one list rather than a second: a misspelt level is
   * ignored by some adapters, which leaves the transaction at the default
   * while the code says otherwise.
   */
  it("refuses a level that is not one", async () => {
    await expect(withPoolTransactionIsolationLevel("mostly", () => undefined)).rejects.toThrow(
      UnknownIsolationLevel,
    );
  });

  it("writes the statement", () => {
    expect(isolationStatement("repeatable read")).toBe(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ",
    );
  });
});

describe("migrations that cannot run in a transaction", () => {
  /**
   * Declared rather than detected: the failure is an error from the database
   * naming the statement, and by then half the migration has applied and
   * cannot be rolled back either.
   */
  it("is off unless declared", () => {
    expect(disableDdlTransaction({})).toBe(false);
    expect(disableDdlTransaction({ disableDdlTransaction: true })).toBe(true);
  });
});

describe("hooks around a commit", () => {
  /**
   * A hook that raises here rolls the whole thing back — the difference from
   * `after_commit` and the reason both exist.
   */
  it("lets a before-commit failure escape", async () => {
    await expect(
      beforeCommitted([
        () => {
          throw new Error("no");
        },
      ]),
    ).rejects.toThrow("no");
  });

  it("runs every before-commit hook in order", async () => {
    const order: string[] = [];

    expect(
      await beforeCommitted([
        () => {
          order.push("a");
        },
        () => {
          order.push("b");
        },
      ]),
    ).toBe(2);
    expect(order).toEqual(["a", "b"]);
  });

  /**
   * A job enqueued inside the transaction can be picked up before it commits,
   * and the worker then loads a record that is not there — a race, so it
   * happens under load and not in development.
   */
  it("enqueues after the commit", async () => {
    const transaction = {};
    const enqueued: string[] = [];
    addAfterCommitJobsCallback(transaction, () => {
      enqueued.push("job");
    });

    await runAfterCommitJobs(transaction);

    expect(enqueued).toEqual(["job"]);
    forgetAfterCommitJobs(transaction);
  });

  /**
   * The transaction has already committed, so a failure here cannot undo it.
   * Raising would leave the caller believing the save failed when the row is
   * there — and a retry would create a second one.
   */
  it("collects an enqueue failure rather than raising", async () => {
    const transaction = {};
    addAfterCommitJobsCallback(transaction, () => {
      throw new Error("queue down");
    });
    addAfterCommitJobsCallback(transaction, () => undefined);

    const failures = await runAfterCommitJobs(transaction);

    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toBe("queue down");
    forgetAfterCommitJobs(transaction);
  });

  it("keeps two transactions' hooks apart", async () => {
    const first = {};
    const second = {};
    addAfterCommitJobsCallback(first, () => undefined);

    expect(await runAfterCommitJobs(second)).toEqual([]);
    forgetAfterCommitJobs(first);
  });

  /**
   * Once per transaction rather than once per record: a hundred records saved
   * together should produce one commit hook, not a hundred, or the cost of a
   * bulk insert grows with the square of the batch.
   */
  it("registers the default hook once", () => {
    const transaction = {};

    expect(addDefaultCallbacks(transaction, () => undefined)).toBe(1);
    expect(addDefaultCallbacks(transaction, () => undefined)).toBe(1);
    forgetAfterCommitJobs(transaction);
  });
});
