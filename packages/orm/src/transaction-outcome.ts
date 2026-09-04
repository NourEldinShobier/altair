/**
 * How a transaction ended, and what that means for the records inside it —
 * ported from `ActiveRecord::ConnectionAdapters::Transaction`'s state machine.
 *
 * `transaction-manager.ts` owns the stack, the savepoints and the callback
 * lists. `after-commit.ts` owns the callbacks themselves. This is the smaller
 * question those two both depend on: *how* did it end, and which of three
 * different endings was it.
 *
 * The distinction has no obvious equivalent outside a database:
 *
 * - **Rolled back** — this transaction went back. A savepoint that rolled back
 *   inside a transaction that then committed is in this state.
 * - **Fully rolled back** — everything it was part of went back. Only here may
 *   a record restore its attributes: a record whose savepoint went back inside
 *   a transaction that committed has had *some* of its work kept, and
 *   restoring would discard changes the database still holds.
 * - **Invalidated** — the connection went away underneath. Nothing was rolled
 *   back; the server may or may not have applied the work and there is no way
 *   left to ask. Treating it as a rollback tells every record to restore
 *   attributes describing rows that may well exist.
 *
 * Getting these three confused produces in-memory objects that are internally
 * consistent and describe rows that are not there — which nothing reports,
 * because from the object's point of view everything is fine.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { type IsolationLevel, checkIsolationLevel } from "./transaction-manager.js";

export type TransactionOutcome =
  | "open"
  | "committed"
  | "rolledback"
  | "fullyRolledback"
  | "invalidated";

export interface OutcomeState {
  outcome: TransactionOutcome;
  savepoint: boolean;
  /** The transaction this one is nested in, if any. */
  parent?: OutcomeState;
}

export function newOutcomeState({
  savepoint = false,
  parent,
}: { savepoint?: boolean; parent?: OutcomeState } = {}): OutcomeState {
  return { outcome: "open", savepoint, ...(parent === undefined ? {} : { parent }) };
}

/** Rails' `state.completed?`, inverted — still deciding. */
export function incomplete(state: OutcomeState): boolean {
  return state.outcome === "open";
}

/** Rails' `rolledback?` — this one went back, whatever its parent did. */
export function rolledback(state: OutcomeState): boolean {
  return state.outcome === "rolledback" || state.outcome === "fullyRolledback";
}

/**
 * Rails' `fully_rolledback?` — everything this was part of went back.
 *
 * A savepoint rolling back only counts as "fully" if its parent went too, so
 * the answer is a walk up the chain rather than a flag. A flag would have to
 * be set on every nested state at the moment the outer one unwound, and
 * missing one leaves a record that never restores.
 */
export function fullyRolledback(state: OutcomeState): boolean {
  if (state.outcome === "fullyRolledback") return true;
  if (state.outcome !== "rolledback") return false;

  // An outermost transaction that rolled back *is* the whole thing — there is
  // nothing above it that could have kept any of the work. Only a savepoint
  // has to ask its parent.
  return state.parent === undefined || fullyRolledback(state.parent);
}

/**
 * Rails' `invalidated?`.
 *
 * Kept apart from a rollback because nothing was rolled back. The work may be
 * in the database, and telling records otherwise is worse than telling them
 * nothing.
 */
export function invalidated(state: OutcomeState): boolean {
  return state.outcome === "invalidated";
}

export function invalidate(state: OutcomeState): OutcomeState {
  state.outcome = "invalidated";

  return state;
}

/**
 * Records the outcome, refusing to change a terminal one.
 *
 * Being told twice means something above reported an outcome it did not own,
 * and quietly taking the second answer misinforms every record attached — so
 * the failure would surface in whichever object was saved rather than in the
 * code that double-reported.
 */
export function settle(state: OutcomeState, outcome: Exclude<TransactionOutcome, "open">): void {
  if (state.outcome !== "open") {
    throw new Error(
      `This transaction is already ${state.outcome} and cannot become ${outcome}. Being told ` +
        `twice means something above it reported an outcome it did not own.`,
    );
  }

  state.outcome = outcome;
}

/**
 * Rails' `rollback_db_transaction` — unwinding the outermost.
 *
 * Marks every open state fully rolled back, not just the one that failed. A
 * record attached to an inner savepoint can only learn that its outer
 * transaction went from here.
 */
export function rollbackDbTransaction(states: readonly OutcomeState[]): OutcomeState[] {
  for (const state of states) {
    if (state.outcome === "open") state.outcome = "fullyRolledback";
  }

  return [...states];
}

/**
 * Rails' `restartable?` — whether a failed transaction can be retried in place.
 *
 * Only a savepoint, and the test says so without naming one: an outermost
 * transaction that rolled back is by definition fully rolled back, so
 * "rolled back but not fully" describes a savepoint and nothing else.
 * Restarting the outermost would mean `ROLLBACK` has already gone, and
 * "restarting" would be beginning a transaction sharing nothing with the old
 * one — including anything it had written.
 */
export function restartable(state: OutcomeState): boolean {
  return rolledback(state) && !fullyRolledback(state);
}

/**
 * Whether a record in this transaction should put its attributes back.
 *
 * Named for the outcome rather than `isRestorable`, which `transaction-manager.ts`
 * already uses for a different question — whether anything wrote inside the
 * transaction. One asks "may this be reused", the other "must this be undone".
 */
export function restorableFromOutcome(state: OutcomeState): boolean {
  return fullyRolledback(state);
}

// --- isolation for a pooled connection -------------------------------------------------

/** The level a block set, and the one the pool was configured with. */
const scopedLevel = new AsyncLocalStorage<IsolationLevel>();
let poolLevel: IsolationLevel | undefined;

/** Rails' `pool_transaction_isolation_level`. */
export function poolTransactionIsolationLevel(): IsolationLevel | undefined {
  return scopedLevel.getStore() ?? poolLevel;
}

export function resetIsolationLevel(): void {
  poolLevel = undefined;
}

/**
 * Rails' `with_pool_transaction_isolation_level`.
 *
 * Scoped to a block and restored afterwards. A level left set applies to every
 * later transaction on that connection, and what it breaks is whichever
 * unrelated code next takes the connection out of the pool — a failure with no
 * visible connection to whatever set it.
 *
 * Validated through `transaction-manager.ts`'s check rather than a second
 * list, so the two cannot come to disagree about what a level is.
 */
export async function withPoolTransactionIsolationLevel<T>(
  level: string,
  body: () => Promise<T> | T,
): Promise<T> {
  const checked = checkIsolationLevel(level);

  // Scoped, not swapped. A module-level variable made this the isolation level
  // of every transaction running beside the block, which is the one setting a
  // concurrent transaction most needs to be its own: a read-committed
  // transaction quietly becoming serializable deadlocks, and the reverse loses
  // the guarantee it was opened for.
  return await scopedLevel.run(checked, async () => await body());
}

/**
 * The statement that sets it.
 *
 * Has to precede the first statement in the transaction: `SET TRANSACTION`
 * only applies before anything has run, so an adapter that materialises
 * lazily must send this first or it is silently ignored — leaving the
 * transaction at the default while the code says otherwise.
 */
export function isolationStatement(level: IsolationLevel): string {
  return `SET TRANSACTION ISOLATION LEVEL ${level.toUpperCase()}`;
}

/**
 * Rails' `disable_ddl_transaction!`.
 *
 * Some migrations cannot run inside a transaction at all — an index added
 * concurrently on Postgres, most `ALTER TYPE`. Declared on the migration
 * rather than detected, because the failure is an error from the database
 * naming the statement, and by then half the migration has applied and cannot
 * be rolled back either.
 */
export function disableDdlTransaction(migration: { disableDdlTransaction?: boolean }): boolean {
  return migration.disableDdlTransaction === true;
}

// --- enqueuing after a commit -------------------------------------------------------------

export type CommitHook = () => void | Promise<void>;

const afterCommitJobs = new WeakMap<object, CommitHook[]>();

/**
 * Rails' `add_after_commit_jobs_callback`.
 *
 * A separate hook from an ordinary `after_commit` for one reason: a job
 * enqueued *inside* a transaction can be picked up by a worker before the
 * transaction commits, and the worker then loads a record that is not there.
 * That is a race, so it happens under load and not in development.
 */
export function addAfterCommitJobsCallback(transaction: object, enqueue: CommitHook): void {
  const held = afterCommitJobs.get(transaction);

  if (held === undefined) afterCommitJobs.set(transaction, [enqueue]);
  else held.push(enqueue);
}

/**
 * Rails' `before_committed!` — hooks that run inside the transaction.
 *
 * The difference from `after_commit` and the reason both exist: a hook that
 * raises here rolls the whole thing back. Anything that must not happen if the
 * transaction fails goes here; anything that must not be undone goes in the
 * other.
 */
export async function beforeCommitted(hooks: readonly CommitHook[]): Promise<number> {
  for (const hook of hooks) await hook();

  return hooks.length;
}

/**
 * Runs the enqueue hooks after a commit, collecting failures.
 *
 * The opposite rule to `beforeCommitted`: the transaction has already
 * committed, so a failure here cannot undo it. Raising would leave the caller
 * believing the save failed when the row is there — and a retry would create a
 * second one.
 */
export async function runAfterCommitJobs(transaction: object): Promise<Error[]> {
  const failures: Error[] = [];

  for (const hook of afterCommitJobs.get(transaction) ?? []) {
    try {
      await hook();
    } catch (error) {
      failures.push(error as Error);
    }
  }

  return failures;
}

/**
 * Rails' `add_default_callbacks` — the ones every transaction gets.
 *
 * Registered once per transaction rather than once per record. A hundred
 * records saved in one transaction should produce one commit hook, not a
 * hundred, or the cost of a bulk insert grows with the square of the batch.
 */
export function addDefaultCallbacks(transaction: object, enqueue: CommitHook): number {
  if ((afterCommitJobs.get(transaction) ?? []).length === 0) {
    addAfterCommitJobsCallback(transaction, enqueue);
  }

  return (afterCommitJobs.get(transaction) ?? []).length;
}

export function forgetAfterCommitJobs(transaction: object): void {
  afterCommitJobs.delete(transaction);
}
