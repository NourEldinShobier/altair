/**
 * Coalescing many small reads into one query, ported from
 * `ActiveRecord::Associations::Preloader::Batch` and the `load_async`
 * scheduling in `ActiveRecord::FutureResult`.
 *
 * `associations.ts` preloads when the caller says `includes`. This is for when
 * they do not: a page that renders fifty comments and asks each one for its
 * author issues fifty queries, and nothing about the code says so — the N+1 is
 * spread across fifty template renders, none of which looks wrong.
 *
 * A batch loader turns that into one query by *not answering immediately*. Each
 * request records the key it wants and returns a promise; the queries only run
 * once the caller stops asking, at which point every key wanted from the same
 * table goes in one `WHERE id IN (…)`.
 *
 * Three properties make the difference between this and a cache:
 *
 * - **Grouping is by table and column, not by model.** Two models on one table,
 *   or one model loaded through two different columns, are different queries;
 *   merging them returns rows keyed on the wrong thing.
 * - **A key asked for twice is loaded once.** That is the point of the whole
 *   exercise, and it has to hold across callers that never met.
 * - **A key with no row resolves to nothing rather than hanging.** A promise
 *   that never settles is worse than a missing record: the request stops with
 *   no error, and the timeout that eventually fires names the wrong thing.
 */

/** What one caller asked for. */
export interface BatchKey {
  table: string;
  column: string;
  value: unknown;
}

/** Rails' `build_entry` — the identity of a group of pending loads. */
export function buildEntry(table: string, column: string): string {
  return `${table}.${column}`;
}

/** Rails' `grouped_records` — pending keys, one group per query. */
export function groupedRecords(
  keys: readonly BatchKey[],
): Map<string, { table: string; column: string; values: unknown[] }> {
  const groups = new Map<string, { table: string; column: string; values: unknown[] }>();

  for (const key of keys) {
    const entry = buildEntry(key.table, key.column);
    const held = groups.get(entry) ?? { table: key.table, column: key.column, values: [] };

    // De-duplicated per group: asking for the same key twice is the case the
    // loader exists for, and sending it twice would make the `IN` list grow
    // with the page rather than with the data.
    if (!held.values.some((value) => sameKey(value, key.value))) held.values.push(key.value);

    groups.set(entry, held);
  }

  return groups;
}

function sameKey(left: unknown, right: unknown): boolean {
  // Compared as strings as well as by identity, because a foreign key read
  // from one row as a number and from another as a string is the same row —
  // and treating them as two keys issues two queries and fills neither.
  return left === right || String(left) === String(right);
}

/** How a group is actually fetched. */
export type BatchFetch = (
  table: string,
  column: string,
  values: readonly unknown[],
) => Promise<Record<string, unknown>[]>;

interface Pending {
  key: BatchKey;
  resolve: (value: Record<string, unknown> | undefined) => void;
  reject: (error: unknown) => void;
}

/**
 * Collects requests and runs one query per group. Rails' `Preloader::Batch`.
 */
export class BatchLoader {
  #pending: Pending[] = [];
  #scheduled = false;
  #ran = 0;

  constructor(
    private readonly fetch: BatchFetch,
    /** How the batch is deferred. A microtask by default. */
    private readonly schedule: (run: () => void) => void = queueMicrotask,
  ) {}

  /** How many queries this loader has actually issued. */
  get queries(): number {
    return this.#ran;
  }

  /** Rails' `loaders` — groups waiting to run. */
  loaders(): string[] {
    return [...groupedRecords(this.#pending.map((each) => each.key)).keys()];
  }

  /** Rails' `runnable_loaders`. */
  runnableLoaders(): number {
    return this.loaders().length;
  }

  /**
   * Asks for one record. Rails' `load_records_for_keys`.
   *
   * Returns a promise that settles once the batch runs, not before — deferring
   * the answer is the entire mechanism, and answering synchronously from a
   * cache would leave the first request of each key un-batched.
   */
  load(key: BatchKey): Promise<Record<string, unknown> | undefined> {
    return new Promise((resolve, reject) => {
      this.#pending.push({ key, resolve, reject });

      if (!this.#scheduled) {
        this.#scheduled = true;
        this.schedule(() => void this.run());
      }
    });
  }

  /** Rails' `load_records_in_batch` — runs everything waiting. */
  async run(): Promise<void> {
    const pending = this.#pending;
    this.#pending = [];
    this.#scheduled = false;

    const groups = groupedRecords(pending.map((each) => each.key));

    await Promise.all(
      [...groups.values()].map(async ({ table, column, values }) => {
        this.#ran += 1;

        try {
          const rows = await this.fetch(table, column, values);
          const byKey = new Map(rows.map((row) => [String(row[column]), row]));

          for (const waiting of pending) {
            if (waiting.key.table !== table || waiting.key.column !== column) continue;

            // `undefined` rather than a pending promise for a key with no row.
            // A promise that never settles stops the request with no error, and
            // whatever timeout eventually fires names the wrong thing.
            waiting.resolve(byKey.get(String(waiting.key.value)));
          }
        } catch (error) {
          // Every caller in the failed group hears about it. Leaving them
          // pending would turn one failed query into a hung request.
          for (const waiting of pending) {
            if (waiting.key.table === table && waiting.key.column === column) {
              waiting.reject(error);
            }
          }
        }
      }),
    );
  }
}

// --- scheduling a query to run alongside other work ------------------------

/** Rails' `async_executor` — where a deferred query actually runs. */
export interface AsyncExecutor {
  post(work: () => Promise<void>): void;
  /** How many are in flight. */
  readonly inFlight: number;
}

/**
 * Runs deferred work up to a limit. Rails' `async_query_executor`.
 *
 * Bounded, because every in-flight async query holds a connection. Unbounded,
 * a page that calls `load_async` in a loop takes the whole pool and the
 * *synchronous* queries behind it — the ones actually rendering the page —
 * wait for connections that its own optimisation is holding.
 */
export class BoundedExecutor implements AsyncExecutor {
  #running = 0;
  readonly #queue: (() => Promise<void>)[] = [];

  constructor(readonly limit = 4) {}

  get inFlight(): number {
    return this.#running;
  }

  get queued(): number {
    return this.#queue.length;
  }

  post(work: () => Promise<void>): void {
    this.#queue.push(work);
    this.#drain();
  }

  #drain(): void {
    while (this.#running < this.limit && this.#queue.length > 0) {
      const work = this.#queue.shift() as () => Promise<void>;
      this.#running += 1;

      // The failure is delivered to whoever posted the work — `asyncLoadTarget`
      // rejects its own promise — so swallowing it here is not losing it. Left
      // unhandled, this copy would crash the process on a query the caller has
      // already dealt with.
      void work()
        .catch(() => undefined)
        .finally(() => {
          this.#running -= 1;
          this.#drain();
        });
    }
  }
}

/**
 * Whether a query may be deferred at all. Rails' `schedule_query`.
 *
 * Not inside a transaction. A query running on another connection cannot see
 * uncommitted work, so `load_async` in a transaction silently reads the state
 * from *before* it — which looks like a caching bug and is not one.
 */
export function scheduleQuery({
  inTransaction = false,
  executorAvailable = true,
}: {
  inTransaction?: boolean;
  executorAvailable?: boolean;
} = {}): "async" | "immediate" {
  if (inTransaction || !executorAvailable) return "immediate";

  return "async";
}

/** Rails' `future_classes` — what a deferred query resolves to. */
export const FUTURE_KINDS = ["result", "count", "exists", "pluck"] as const;

export type FutureKind = (typeof FUTURE_KINDS)[number];

export function futureClasses(): readonly FutureKind[] {
  return FUTURE_KINDS;
}

/**
 * Kinds that must never be deferred. Rails' `immediate_future_classes`.
 *
 * A query whose answer decides what to do next has nothing to overlap with, so
 * deferring it adds a connection and a context switch and saves nothing.
 */
export function immediateFutureClasses(inTransaction: boolean): readonly FutureKind[] {
  return inTransaction ? FUTURE_KINDS : [];
}

/** Rails' `async_load_target`. */
export async function asyncLoadTarget<T>(
  executor: AsyncExecutor,
  load: () => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    executor.post(async () => {
      try {
        resolve(await load());
      } catch (error) {
        reject(error);
      }
    });
  });
}
