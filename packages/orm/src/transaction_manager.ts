/**
 * The stack of open transactions, and when each one actually starts. Ported
 * from `ActiveRecord::ConnectionAdapters::TransactionManager`,
 * `RealTransaction` and `SavepointTransaction`.
 *
 * `connection.ts` already opens a transaction and nests with savepoints. What
 * it does not do is decide *when* to send the BEGIN, and that turns out to be
 * the part with consequences.
 *
 * A block that only reads never needs a transaction at all, and an open one is
 * not free:
 *
 *   - On PostgreSQL it pins an MVCC snapshot, so `VACUUM` cannot reclaim any
 *     row that was visible when it started. One long-lived idle transaction on
 *     a busy table is how a database ends up with a hundred gigabytes of dead
 *     tuples and a table scan that used to be fast.
 *   - It holds its connection for the duration, which on a pool of five is a
 *     fifth of the application's capacity spent waiting for whatever the block
 *     does between the BEGIN and the first query.
 *   - `idle_in_transaction_session_timeout` kills it, and the error names the
 *     connection rather than the block that held it.
 *
 * So a transaction is *deferred*: the stack is pushed immediately and the
 * BEGIN is sent when something is about to write. That is what "materialize"
 * means here. A read-only block opens and closes without the database ever
 * hearing about it.
 *
 * The cost is that a transaction can be rolled back before it ever began,
 * which is fine, and that a savepoint inside an unmaterialized transaction has
 * to materialize its parents first — which is what `materializeTransactions`
 * walking the whole stack is for.
 */

/** What a database will promise about what a transaction can see. */
export type IsolationLevel =
  | "read uncommitted"
  | "read committed"
  | "repeatable read"
  | "serializable";

export const TRANSACTION_ISOLATION_LEVELS: readonly IsolationLevel[] = [
  "read uncommitted",
  "read committed",
  "repeatable read",
  "serializable",
];

export function transactionIsolationLevels(): readonly IsolationLevel[] {
  return TRANSACTION_ISOLATION_LEVELS;
}

/** Raised when an isolation level is asked for that is not one. */
export class UnknownIsolationLevel extends Error {
  constructor(given: string) {
    super(
      `"${given}" is not an isolation level. One of: ${TRANSACTION_ISOLATION_LEVELS.join(", ")}.`,
    );
    this.name = "UnknownIsolationLevel";
  }
}

export function checkIsolationLevel(level: string): IsolationLevel {
  if (!TRANSACTION_ISOLATION_LEVELS.includes(level as IsolationLevel)) {
    throw new UnknownIsolationLevel(level);
  }

  return level as IsolationLevel;
}

/** The SQL a transaction sends. Separated so the manager can be tested without a database. */
export interface TransactionDriver {
  beginDbTransaction(): Promise<void>;
  beginIsolatedDbTransaction(level: IsolationLevel): Promise<void>;
  commitDbTransaction(): Promise<void>;
  execRollbackDbTransaction(): Promise<void>;
  createSavepoint(name: string): Promise<void>;
  execRollbackToSavepoint(name: string): Promise<void>;
  releaseSavepoint(name: string): Promise<void>;
  /** Whether the adapter can restart a transaction rather than rolling back and beginning again. */
  supportsRestartDbTransaction?: boolean;
  execRestartDbTransaction?(): Promise<void>;
  /**
   * Whether an error inside a savepoint poisons the whole transaction.
   *
   * MySQL is the reason this exists: some errors there leave the outer
   * transaction unusable even though the savepoint was rolled back cleanly, so
   * carrying on and committing writes nothing and reports success.
   */
  savepointErrorsInvalidateTransactions?: boolean;
}

export type TransactionCallback = () => void | Promise<void>;

/** One entry on the stack. */
export class TransactionState {
  /** Whether the BEGIN (or SAVEPOINT) has actually been sent. */
  materialized = false;
  /** Whether anything has written inside it. */
  dirty = false;
  /** Whether a rollback here unwinds everything rather than to a savepoint. */
  readonly fullRollback: boolean;
  /** The savepoint's name, for a nested transaction. */
  readonly savepointName: string | undefined;
  readonly isolation: IsolationLevel | undefined;
  /** Whether a caller asked for this, rather than it being opened implicitly. */
  readonly userTransaction: boolean;

  readonly beforeCommitCallbacks: TransactionCallback[] = [];
  readonly afterCommitCallbacks: TransactionCallback[] = [];
  readonly afterRollbackCallbacks: TransactionCallback[] = [];
  readonly records: unknown[] = [];

  #committed = false;

  constructor(options: {
    fullRollback: boolean;
    savepointName?: string;
    isolation?: IsolationLevel;
    userTransaction?: boolean;
  }) {
    this.fullRollback = options.fullRollback;
    this.savepointName = options.savepointName;
    this.isolation = options.isolation;
    this.userTransaction = options.userTransaction ?? true;
  }

  /** Whether it has both begun and finished cleanly. Rails' `fully_committed?`. */
  fullyCommitted(): boolean {
    return this.#committed;
  }

  /** Marks it committed. Rails' `full_commit!`. */
  fullCommit(): void {
    this.#committed = true;
  }

  /** Notes that something wrote. Rails' `dirty!`. */
  markDirty(): void {
    this.dirty = true;
  }

  /** Whether it can be restored rather than rebuilt — only if nothing wrote. */
  isRestorable(): boolean {
    return !this.dirty;
  }

  addRecord(record: unknown): void {
    this.records.push(record);
  }

  /** Everything registered to run before the COMMIT. Rails' `before_commit_records`. */
  beforeCommitRecords(): TransactionCallback[] {
    return this.beforeCommitCallbacks;
  }

  /** Everything to run when it unwinds. Rails' `rollback_records`. */
  rollbackRecords(): TransactionCallback[] {
    return this.afterRollbackCallbacks;
  }
}

/**
 * The stack, and the decision about when to send a BEGIN.
 *
 * Holds no connection of its own — it is handed a driver — so the state
 * machine can be exercised without a database, which is the only way to test
 * "did not send a BEGIN".
 */
export class TransactionManager {
  readonly driver: TransactionDriver;

  #stack: TransactionState[] = [];
  #lazyEnabled = true;
  #savepoints = 0;
  #materializing = false;
  #unmaterialized = false;

  constructor(driver: TransactionDriver) {
    this.driver = driver;
  }

  /** The innermost open transaction, or nothing. Rails' `current_transaction`. */
  currentTransaction(): TransactionState | undefined {
    return this.#stack[this.#stack.length - 1];
  }

  get depth(): number {
    return this.#stack.length;
  }

  get open(): boolean {
    return this.#stack.length > 0;
  }

  /** Whether a BEGIN is held back until something writes. */
  lazyTransactionsEnabled(): boolean {
    return this.#lazyEnabled;
  }

  enableLazyTransactions(): void {
    this.#lazyEnabled = true;
  }

  /**
   * Sends the BEGIN immediately from now on.
   *
   * For the case where the block's first statement must run inside the
   * transaction whatever it is — a `SELECT ... FOR UPDATE` taken before a
   * write, which outside a transaction locks nothing and returns immediately.
   */
  disableLazyTransactions(): void {
    this.#lazyEnabled = false;
  }

  get supportsLazyTransactions(): boolean {
    return true;
  }

  /** Notes that the innermost transaction is about to write. Rails' `dirty_current_transaction`. */
  dirtyCurrentTransaction(): void {
    this.currentTransaction()?.markDirty();
  }

  /**
   * Sends every BEGIN and SAVEPOINT that has been deferred. Rails'
   * `materialize_transactions`.
   *
   * The whole stack, outermost first: a savepoint is meaningless inside a
   * transaction that has not begun, so an inner one cannot materialize alone.
   *
   * Re-entrant calls are ignored. Materializing runs SQL, and running SQL is
   * what asks for materialization — without the guard the first write inside a
   * transaction recurses.
   */
  async materializeTransactions(): Promise<void> {
    if (this.#materializing || !this.#unmaterialized) return;

    this.#materializing = true;

    try {
      for (const transaction of this.#stack) {
        if (transaction.materialized) continue;

        await this.#materialize(transaction);
      }

      this.#unmaterialized = false;
    } finally {
      this.#materializing = false;
    }
  }

  async #materialize(transaction: TransactionState): Promise<void> {
    if (transaction.savepointName === undefined) {
      if (transaction.isolation !== undefined) {
        await this.driver.beginIsolatedDbTransaction(transaction.isolation);
      } else {
        await this.driver.beginDbTransaction();
      }
    } else {
      await this.driver.createSavepoint(transaction.savepointName);
    }

    transaction.materialized = true;
  }

  /**
   * Opens one. Rails' `within_new_transaction`.
   *
   * The outermost is a real transaction; anything inside it is a savepoint, so
   * that an inner block which throws undoes only its own work.
   *
   * An isolation level can only be asked for on the outermost: a savepoint
   * cannot change what the surrounding transaction can see, and asking is
   * always a mistake about what the code will do rather than a preference.
   */
  async withinNewTransaction<T>(
    body: (transaction: TransactionState) => Promise<T>,
    options: { isolation?: IsolationLevel; joinable?: boolean; requiresNew?: boolean } = {},
  ): Promise<T> {
    const nested = this.open;

    if (options.isolation !== undefined) {
      checkIsolationLevel(options.isolation);

      if (nested) {
        throw new Error(
          "An isolation level can only be set on the outermost transaction — a savepoint cannot " +
            "change what the transaction around it sees.",
        );
      }
    }

    this.#savepoints += nested ? 1 : 0;

    const transaction = new TransactionState({
      fullRollback: !nested,
      ...(nested ? { savepointName: `altair_savepoint_${String(this.#savepoints)}` } : {}),
      ...(options.isolation === undefined ? {} : { isolation: options.isolation }),
      userTransaction: options.joinable ?? true,
    });

    this.#stack.push(transaction);
    this.#unmaterialized = true;

    // Eagerly when lazy is off, and also when an isolation level was named:
    // the level has to be set as part of the BEGIN, and a caller that asked
    // for one wants it to apply to everything in the block.
    if (!this.#lazyEnabled || options.isolation !== undefined) {
      await this.materializeTransactions();
    }

    try {
      const result = await body(transaction);

      await this.commitTransaction();

      return result;
    } catch (error) {
      await this.rollbackTransaction();

      throw error;
    }
  }

  /** Commits the innermost, running its before-commit callbacks first. */
  async commitTransaction(): Promise<void> {
    const transaction = this.#stack[this.#stack.length - 1];

    if (!transaction) return;

    for (const callback of transaction.beforeCommitRecords()) await callback();

    this.#stack.pop();

    // Nothing was ever sent, so there is nothing to commit. This is the
    // ordinary outcome for a block that only read.
    if (!transaction.materialized) {
      transaction.fullCommit();

      return;
    }

    if (transaction.savepointName === undefined) await this.driver.commitDbTransaction();
    else await this.driver.releaseSavepoint(transaction.savepointName);

    transaction.fullCommit();

    for (const callback of transaction.afterCommitCallbacks) await callback();
  }

  /** Rolls the innermost back. */
  async rollbackTransaction(): Promise<void> {
    const transaction = this.#stack.pop();

    if (!transaction) return;

    if (transaction.materialized) {
      if (transaction.savepointName === undefined) await this.driver.execRollbackDbTransaction();
      else await this.driver.execRollbackToSavepoint(transaction.savepointName);
    }

    // An error inside a savepoint can leave the transaction around it unusable
    // on MySQL, even though the savepoint itself rolled back cleanly. Carrying
    // on would commit nothing and report success.
    if (
      transaction.savepointName !== undefined &&
      this.driver.savepointErrorsInvalidateTransactions === true
    ) {
      for (const outer of this.#stack) outer.markDirty();
    }

    for (const callback of transaction.rollbackRecords()) await callback();
  }

  /**
   * Whether the stack can be put back as it was. Rails' `restorable?`.
   *
   * Only if nothing has written. A transaction that has written cannot be
   * restored, because restoring it would mean pretending those writes are
   * still pending when the database has already been told to forget them.
   */
  isRestorable(): boolean {
    return this.#stack.every((each) => each.isRestorable());
  }

  /**
   * Reopens what was open, after a connection was lost and replaced. Rails'
   * `restore_transactions`.
   *
   * Returns whether it could. False rather than throwing, because the caller's
   * alternative is to fail the request, and it wants to decide that itself.
   */
  async restoreTransactions(): Promise<boolean> {
    if (!this.isRestorable()) return false;

    for (const transaction of this.#stack) {
      transaction.materialized = false;
    }

    this.#unmaterialized = true;
    await this.materializeTransactions();

    return true;
  }

  /** Throws the stack away without touching the database. Rails' `reset_transaction`. */
  resetTransaction(): void {
    this.#stack = [];
    this.#unmaterialized = false;
    this.#materializing = false;
  }

  /**
   * Rolls back and begins again in one step where the adapter can. Rails'
   * `restart_db_transaction`.
   *
   * For a test suite that wraps each case in a transaction: restarting is one
   * round trip where rollback-then-begin is two, and it runs between every
   * pair of tests.
   */
  async restartDbTransaction(): Promise<void> {
    if (this.driver.supportsRestartDbTransaction === true && this.driver.execRestartDbTransaction) {
      await this.driver.execRestartDbTransaction();

      return;
    }

    await this.driver.execRollbackDbTransaction();
    await this.driver.beginDbTransaction();
  }

  /** The transaction a caller opened, as opposed to one opened for them. */
  userTransaction(): TransactionState | undefined {
    return [...this.#stack].reverse().find((each) => each.userTransaction);
  }

  /** Whether anything on the stack was opened by a caller. Rails' `uses_transaction?`. */
  usesTransaction(): boolean {
    return this.userTransaction() !== undefined;
  }

  /** Whether the innermost would unwind everything. Rails' `full_rollback?`. */
  fullRollback(): boolean {
    return this.currentTransaction()?.fullRollback ?? false;
  }

  /** Whether the outermost has committed. */
  fullyCommitted(): boolean {
    return this.currentTransaction()?.fullyCommitted() ?? false;
  }

  /**
   * Swaps a transaction's outcome, for a test harness that runs inside one and
   * wants the opposite. Rails' `invert_transaction`.
   */
  invertTransaction(transaction: TransactionState): void {
    transaction.materialized = !transaction.materialized;
  }
}
