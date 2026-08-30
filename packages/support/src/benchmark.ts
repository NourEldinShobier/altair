/**
 * Measuring how long something took, ported from
 * `ActiveSupport::Benchmarkable` and `ActiveSupport::Benchmark`.
 *
 * All of these use a monotonic clock rather than the wall clock, and that is
 * the whole reason they exist as helpers rather than two lines inline. The
 * wall clock can move backwards — an NTP correction, a leap second, a laptop
 * waking up — so a duration measured with `Date.now()` can come out negative,
 * and a timing that occasionally reports minus four milliseconds is a bug
 * nobody can reproduce.
 */

/**
 * How long the block took, in milliseconds. Rails' `realtime`.
 *
 * Returns the duration and the block's own result together, because the caller
 * almost always wants both and threading the result out through a mutable
 * variable is the alternative.
 */
export async function realtime<T>(body: () => T | Promise<T>): Promise<{
  duration: number;
  result: T;
}> {
  const startedAt = performance.now();
  const result = await body();

  return { duration: performance.now() - startedAt, result };
}

/** The synchronous form, for a block that does not await. */
export function realtimeSync<T>(body: () => T): { duration: number; result: T } {
  const startedAt = performance.now();
  const result = body();

  return { duration: performance.now() - startedAt, result };
}

/**
 * How much CPU the *process* used while the block ran, in milliseconds.
 * Rails' `cpu_time`.
 *
 * The distinction that makes it worth having: elapsed time counts waiting on
 * the database and CPU time does not, so a request taking 900ms on 12ms of CPU
 * is waiting on something while one taking 900ms on 880ms is computing, and
 * those want opposite fixes.
 *
 * Process-wide, and the word is load-bearing. `process.cpuUsage` cannot
 * attribute work to one block, so anything else the process does while this
 * awaits is counted too. That makes it a fair measure in a quiet process and a
 * misleading one in a busy server handling other requests concurrently — worth
 * knowing before quoting a figure from production.
 */
export async function cpuTime<T>(body: () => T | Promise<T>): Promise<{
  duration: number;
  result: T;
}> {
  const before = process.cpuUsage();
  const result = await body();
  const after = process.cpuUsage(before);

  return { duration: (after.user + after.system) / 1000, result };
}

/**
 * Runs the block and reports how long it took. Rails' `benchmark`.
 *
 *     await benchmark("Reindexing", (line) => logger.info(line), () => reindex())
 *
 * The message is written after the block, not before, so the duration is in
 * it. Logging "starting" and "done" as two lines is the usual alternative, and
 * it leaves anybody reading the log to subtract two timestamps by hand — which
 * they will not do for the ninety lines that were fine.
 */
export async function benchmark<T>(
  message: string,
  log: (line: string) => void,
  body: () => T | Promise<T>,
): Promise<T> {
  const startedAt = performance.now();

  try {
    return await body();
  } finally {
    // In a finally, so a block that threw still reports how long it ran
    // before failing — often the most interesting timing of all.
    log(`${message} (${(performance.now() - startedAt).toFixed(1)}ms)`);
  }
}

/** A duration in the shortest sensible unit, for a log line or a page. */
export function humanDuration(milliseconds: number): string {
  if (milliseconds < 1) return `${(milliseconds * 1000).toFixed(0)}µs`;
  if (milliseconds < 1000) return `${milliseconds.toFixed(1)}ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(2)}s`;

  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = ((milliseconds % 60_000) / 1000).toFixed(0);

  return `${minutes}m${seconds}s`;
}
