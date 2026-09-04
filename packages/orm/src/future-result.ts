/**
 * A query started now and collected later. Ported from
 * `ActiveRecord::FutureResult` and `AsynchronousQueriesTracker` — Rails'
 * `load_async`.
 *
 * A page that needs three independent queries waits for all three in sequence,
 * because `await` is where the round trip happens. Three 40ms queries are
 * 120ms of a request spent doing nothing. Started together they are 40.
 *
 * A promise alone does not give you this. Two things have to come with it, and
 * they are the reason this is a class rather than `Promise.all`:
 *
 * **A started query has to be cancellable.** A controller that loads three
 * things and then returns early on the first — a 404, an authorisation
 * failure — has two queries still running against a connection each. Without a
 * way to abandon them the fast path costs more than the slow one.
 *
 * **An unawaited rejection is a crash.** A query started and never collected
 * rejects into nothing, and an unhandled rejection takes the process down in
 * Node's default mode. So the rejection is captured at the moment the query
 * starts, and `result()` re-throws it to whoever actually asks — which is the
 * one place that can do something about it.
 *
 * The session exists because "later" needs a boundary. A future left running
 * past the end of a request holds a connection nobody is waiting for, so the
 * request finishes its session and anything still pending is cancelled.
 */

/** Raised when a future's value is asked for after it was abandoned. */
export class Canceled extends Error {
  constructor() {
    super("This query was canceled before its result was collected.");
    this.name = "Canceled";
  }
}

/** What a future can be doing. */
export type FutureStatus = "pending" | "complete" | "canceled" | "failed";

/**
 * One query in flight.
 *
 * Starts as soon as it is constructed. That is the whole point — a future that
 * waits to be awaited before issuing its query has saved nothing.
 */
export class FutureResult<T> {
  #status: FutureStatus = "pending";
  #value: T | undefined;
  #error: unknown;
  readonly #promise: Promise<void>;

  constructor(run: () => Promise<T>) {
    this.#promise = run().then(
      (value) => {
        // A result that arrives after cancellation is dropped rather than
        // stored: the caller has already said it does not want it, and keeping
        // it would make `canceled` and `complete` both true.
        if (this.#status === "canceled") return;

        this.#value = value;
        this.#status = "complete";
      },
      (error: unknown) => {
        if (this.#status === "canceled") return;

        // Captured rather than left to reject into nothing. An unhandled
        // rejection from a query nobody collected takes the process down.
        this.#error = error;
        this.#status = "failed";
      },
    );
  }

  /** A future holding a value that is already known. Rails' `FutureResult.wrap`. */
  static wrap<T>(value: T): FutureResult<T> {
    return new FutureResult(async () => value);
  }

  get status(): FutureStatus {
    return this.#status;
  }

  /** Rails' `pending?`. */
  pending(): boolean {
    return this.#status === "pending";
  }

  /** Rails' `canceled?`. */
  canceled(): boolean {
    return this.#status === "canceled";
  }

  /** Whether it finished, either way. */
  done(): boolean {
    return this.#status === "complete" || this.#status === "failed";
  }

  /** Whether it finished with a value. */
  fullyCompleted(): boolean {
    return this.#status === "complete";
  }

  /**
   * Abandons it. Rails' `cancel`.
   *
   * The query itself cannot be un-sent — the database is already working — but
   * nothing will wait for it and its error will not be raised. What this buys
   * is the early-return path not blocking on work whose answer is no longer
   * wanted.
   */
  cancel(): void {
    if (this.#status === "pending") this.#status = "canceled";
  }

  /**
   * The value, waiting if it has not arrived. Rails' `result`.
   *
   * Throws whatever the query threw, here rather than where it started —
   * because here is where a caller exists to handle it.
   */
  async result(): Promise<T> {
    await this.#promise;

    if (this.#status === "canceled") throw new Canceled();
    if (this.#status === "failed") throw this.#error;

    return this.#value as T;
  }

  /** The value if it is already here, without waiting. */
  ensureResult(): T | undefined {
    return this.#status === "complete" ? this.#value : undefined;
  }

  /**
   * Runs something over the result when it arrives. Rails calls this `then`.
   *
   * Not named `then` here, and the reason is specific to JavaScript: a class
   * with a `then` method is a thenable, so `await future` would call it with
   * `(resolve, reject)` — two functions where this expects one — instead of
   * awaiting the future. The name Rails uses is the one name this method
   * cannot have.
   */
  async andThen<U>(body: (value: T) => U | Promise<U>): Promise<U> {
    return body(await this.result());
  }

  /** Waits for it to settle without asking for the value or raising. */
  async settled(): Promise<void> {
    await this.#promise;
  }
}

/**
 * The futures started within one unit of work. Rails' asynchronous queries
 * session.
 *
 * "Later" needs a boundary, and a request is it. A future outliving its
 * request holds a connection nobody is waiting for.
 */
export class AsynchronousQueriesSession {
  #futures: FutureResult<unknown>[] = [];
  #active = true;

  track<T>(future: FutureResult<T>): FutureResult<T> {
    this.#futures.push(future as FutureResult<unknown>);

    return future;
  }

  get active(): boolean {
    return this.#active;
  }

  get size(): number {
    return this.#futures.length;
  }

  /** Every one still in flight. */
  pending(): FutureResult<unknown>[] {
    return this.#futures.filter((each) => each.pending());
  }

  /**
   * Ends the session. Rails' `finalize`.
   *
   * `wait` decides which of the two failure modes you would rather have:
   * waiting means a slow query delays the response it is no longer part of,
   * and not waiting means the connection is held until the query finishes on
   * its own. Rails defaults to not waiting and so does this.
   */
  async finalize(wait = false): Promise<void> {
    this.#active = false;

    if (wait) {
      await Promise.all(this.#futures.map((each) => each.settled()));
    } else {
      for (const future of this.#futures) future.cancel();
    }

    this.#futures = [];
  }
}

/**
 * Which session is current, and whether async is on at all. Rails'
 * `AsynchronousQueriesTracker`.
 */
export class AsynchronousQueriesTracker {
  #session: AsynchronousQueriesSession | undefined;
  #enabled = true;

  /** Rails' `async_enabled?`. */
  asyncEnabled(): boolean {
    return this.#enabled;
  }

  /**
   * Turns it off, so every future runs immediately and in order.
   *
   * For a test that has to assert on query order, and for an environment where
   * the extra concurrency is not worth the connections it costs.
   */
  setAsyncEnabled(enabled: boolean): void {
    this.#enabled = enabled;
  }

  /** Rails' `current_session`. */
  currentSession(): AsynchronousQueriesSession | undefined {
    return this.#session;
  }

  /** Rails' `start_session`. */
  startSession(): AsynchronousQueriesSession {
    this.#session = new AsynchronousQueriesSession();

    return this.#session;
  }

  /** Rails' `finalize_session`. */
  async finalizeSession(wait = false): Promise<void> {
    const session = this.#session;
    this.#session = undefined;

    await session?.finalize(wait);
  }

  get finalized(): boolean {
    return this.#session === undefined;
  }

  /**
   * Starts a query, or runs it now. Rails' `execute_or_skip`.
   *
   * Immediately when async is off or nothing has opened a session, because a
   * future with no session has no boundary — it would be started by a request
   * and cancelled by nobody.
   */
  executeOrSkip<T>(run: () => Promise<T>): FutureResult<T> {
    if (!this.#enabled || this.#session === undefined) {
      return new FutureResult(run);
    }

    return this.#session.track(new FutureResult(run));
  }

  /**
   * Wraps a unit of work so whatever it started is cleaned up after. Rails'
   * `install_executor_hooks`.
   *
   * In a `finally`, because the case that matters is the one that threw: an
   * early return or an exception is exactly when futures are left behind.
   */
  async withSession<T>(body: (session: AsynchronousQueriesSession) => Promise<T>): Promise<T> {
    const session = this.startSession();

    try {
      return await body(session);
    } finally {
      await this.finalizeSession();
    }
  }
}

const tracker = new AsynchronousQueriesTracker();

export function asynchronousQueriesTracker(): AsynchronousQueriesTracker {
  return tracker;
}

export function asynchronousQueriesSession(): AsynchronousQueriesSession | undefined {
  return tracker.currentSession();
}

export function asyncEnabled(): boolean {
  return tracker.asyncEnabled();
}

export function setAsyncEnabled(enabled: boolean): void {
  tracker.setAsyncEnabled(enabled);
}

export function finalizeSession(wait = false): Promise<void> {
  return tracker.finalizeSession(wait);
}
