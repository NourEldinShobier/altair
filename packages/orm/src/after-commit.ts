/**
 * Work deferred until a transaction actually commits, ported from
 * ActiveRecord's `after_commit` and `after_rollback`.
 *
 *     class Order extends Model<OrderRow>("orders") {
 *       static {
 *         this.afterCommit(async function () { await ChargeCard.later(this) }, { on: "create" })
 *       }
 *     }
 *
 * The reason this exists rather than `after_create` doing the job is one of
 * the oldest production bugs there is. A job enqueued inside the transaction
 * is enqueued whether or not the transaction commits, so a rollback leaves a
 * worker holding the id of a row that never existed. Worse, it can be *picked
 * up* before the commit lands, and then the row genuinely is not there yet —
 * a race that reproduces about one time in fifty and never on a laptop.
 *
 * Deferring the work until after COMMIT removes both. Outside a transaction
 * there is nothing to wait for and the callback runs at once, so the same code
 * is correct either way — which is the point, since a model does not know
 * whether its caller opened one.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { errors } from "@altair/support";

export type CommitAction = "create" | "update" | "destroy";
export type CommitCallback = () => void | Promise<void>;

interface Pending {
  onBeforeCommit: CommitCallback[];
  onCommit: CommitCallback[];
  onRollback: CommitCallback[];
  /** Records whose callbacks this transaction is carrying. */
  records: Set<unknown>;
}

const pending = new AsyncLocalStorage<Pending>();

/** Whether a transaction is collecting deferred work right now. */
export function isDeferring(): boolean {
  return pending.getStore() !== undefined;
}

/**
 * Runs a block with a collector in scope, then settles it.
 *
 * The callbacks belong to the *outermost* transaction: a savepoint that
 * releases has not committed anything, and running its callbacks there would
 * bring back exactly the bug this file is about. Nesting therefore reuses the
 * collector it finds rather than making its own.
 */
export async function collectingCommitCallbacks<T>(body: () => Promise<T>): Promise<T> {
  if (isDeferring()) return await body();

  const collected: Pending = {
    onBeforeCommit: [],
    onCommit: [],
    onRollback: [],
    records: new Set(),
  };

  let result: T;
  try {
    result = await pending.run(collected, body);
  } catch (error) {
    // The transaction is being rolled back. Rails runs after_rollback here,
    // and swallows nothing — but the original error is what the caller needs,
    // so a failing rollback callback must not replace it.
    await runAll(collected.onRollback, "after_rollback");
    throw error;
  }

  await runAll(collected.onCommit, "after_commit");
  return result;
}

/**
 * Runs deferred callbacks, reporting anything they throw rather than raising.
 *
 * The transaction has already committed by the time these run. Throwing would
 * tell the caller their write failed when it did not, and there is nothing
 * left to undo — so the honest outcome is a saved record and a loud error.
 *
 * Loud, not silent: it goes to the error reporter, which is where an
 * application has hung Sentry or its equivalent. Swallowing a failed welcome
 * email is how nobody finds out the mailer has been down for a week.
 */
async function runAll(callbacks: CommitCallback[], phase: string): Promise<void> {
  for (const callback of callbacks) {
    await errors.handle(async () => await callback(), {
      source: "altair.orm",
      severity: "error",
      context: { phase },
    });
  }
}

/**
 * Defers work until the current transaction commits.
 *
 * Runs immediately when there is no transaction, because then the write is
 * already durable and there is nothing to wait for.
 */
export async function afterCommit(callback: CommitCallback): Promise<void> {
  const collected = pending.getStore();

  if (!collected) {
    // Reported the same way as the deferred path, and for the same reason: the
    // write is already durable either way, so a failing callback must not
    // become a failing save. Behaving differently inside a transaction and
    // outside one would make the bug depend on the caller.
    await runAll([callback], "after_commit");
    return;
  }

  collected.onCommit.push(callback);
}

/**
 * Runs work just before the current transaction commits. Rails'
 * `before_commit`.
 *
 * Inside the transaction, unlike `afterCommit`, and that is the whole point:
 * throwing here rolls everything back. It is where a last consistency check
 * belongs — an order's total matching the sum of its lines, a balance not
 * going negative — because discovering that after the commit leaves nothing to
 * do but report it.
 *
 * With no transaction in progress it runs immediately, like `afterCommit`, and
 * a throw reaches the caller directly since there is nothing to roll back.
 */
export async function beforeCommit(callback: CommitCallback): Promise<void> {
  const collected = pending.getStore();

  if (!collected) {
    await callback();

    return;
  }

  collected.onBeforeCommit.push(callback);
}

/**
 * Notes that a record has work riding on this transaction. Rails'
 * `add_transaction_record`.
 *
 * What lets a caller ask whether a record's callbacks are still pending — and
 * a set rather than a list, because a record saved three times in one
 * transaction should have its callbacks considered once.
 */
export function addTransactionRecord(record: unknown): void {
  pending.getStore()?.records.add(record);
}

/** The records this transaction is carrying. Rails' `commit_records`. */
export function commitRecords(): unknown[] {
  return [...(pending.getStore()?.records ?? [])];
}

/** Whether a record has work riding on the transaction in progress. */
export function hasTransactionRecord(record: unknown): boolean {
  return pending.getStore()?.records.has(record) ?? false;
}

/** Defers work until the current transaction rolls back. Never runs otherwise. */
export function afterRollback(callback: CommitCallback): void {
  pending.getStore()?.onRollback.push(callback);
}

/**
 * Runs the before-commit callbacks. Called from inside the SQL transaction.
 *
 * Deliberately not through `runAll`: a before-commit callback that throws must
 * take the transaction down with it, and `runAll` reports rather than raises
 * because by the time it is used the commit has already landed. That inversion
 * is the entire difference between the two phases.
 *
 * It has to be called from inside the driver's block, before that block
 * returns and the COMMIT goes out. Running it where the after-commit callbacks
 * run would put it after the commit, which would make the name a lie — the
 * first version of this did exactly that, and the test that rolls a
 * transaction back from a before-commit callback is what caught it.
 */
export async function runBeforeCommitCallbacks(): Promise<void> {
  const collected = pending.getStore();

  if (!collected) return;

  // Taken and cleared, so a callback that starts another transaction does not
  // see them again and run them twice.
  const callbacks = collected.onBeforeCommit.splice(0, collected.onBeforeCommit.length);

  for (const callback of callbacks) await callback();
}

/** @internal Empties the collector. For the test helper's manual transactions. */
export function pendingCallbacks(): Pending | undefined {
  return pending.getStore();
}
