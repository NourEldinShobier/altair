/**
 * What can cross an isolate boundary, ported from Rails' Ractor support —
 * `ActiveSupport::Ractor`, the `make_shareable` helpers, and the fork hooks in
 * `ActiveSupport::ForkTracker`.
 *
 * Rails' Ractors and this runtime's workers are different mechanisms with the
 * same rule: an isolate has its own heap, so a value handed across is copied
 * unless it is provably immutable, and a value that *cannot* be copied cannot
 * be handed across at all. Everything here is about finding that out at the
 * boundary rather than after it.
 *
 * Why it needs code rather than a `try`:
 *
 * - **The failure is asymmetric.** A value that cannot cross raises where it is
 *   sent, which is recoverable. A value that crosses *by copy* when the caller
 *   expected sharing is not an error at all — the worker mutates its copy, the
 *   parent never sees it, and the bug is a feature that silently does nothing.
 * - **Freezing is deep or it is nothing.** A frozen array of mutable objects is
 *   shareable by the letter of the check and not by its purpose: two isolates
 *   holding it can still write to the same objects through it.
 * - **A fork hook that raises must not take the process with it.** Forking is
 *   how the test runner and the job worker start, and a hook that throws
 *   during one leaves a child that is half-initialised and a parent that thinks
 *   it started fine.
 */

// --- what can cross ---------------------------------------------------------------

/**
 * Rails' `Ractor.shareable?` — whether a value can cross without being copied.
 *
 * Primitives always can; nothing else can unless it is frozen all the way
 * down. Checking only the outer object is the mistake worth naming: a frozen
 * array of mutable objects passes a shallow check and still lets two isolates
 * write to the same objects through it.
 */
export function shareable(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value !== "object") {
    // A function is not an object here but is not shareable either: it closes
    // over a scope the other isolate does not have.
    return typeof value !== "function" && typeof value !== "symbol";
  }

  if (seen.has(value)) return true;

  seen.add(value);

  if (!Object.isFrozen(value)) return false;

  if (value instanceof Map || value instanceof Set) {
    // Freezing a Map freezes the reference and not the entries; `set` on a
    // frozen Map still works, which is exactly the shallow-check trap.
    return false;
  }

  return Object.values(value).every((each) => shareable(each, seen));
}

/**
 * Rails' `Ractor.make_shareable` — freeze deeply, or say why it cannot.
 *
 * Mutates rather than copying, matching Rails: a copy would leave the caller
 * holding the mutable original and passing the frozen one, so a later write
 * through the original would be lost with no error anywhere.
 */
export function makeShareable<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") {
    if (typeof value === "function") {
      throw new TypeError(
        "A function cannot be made shareable: it closes over a scope the other isolate does not " +
          "have. Send the data it needs and rebuild the function on the other side.",
      );
    }

    return value;
  }

  const object = value as unknown as object;

  if (seen.has(object)) return value;

  seen.add(object);

  if (object instanceof Map || object instanceof Set) {
    throw new TypeError(
      `A ${object.constructor.name} cannot be made shareable: freezing one freezes the reference ` +
        `and not the entries, so both isolates could still write through it. Convert it to a ` +
        `plain object or array first.`,
    );
  }

  for (const each of Object.values(object)) makeShareable(each, seen);

  Object.freeze(object);

  return value;
}

/**
 * Rails' `Ractor.try_make_shareable` — the same, reporting rather than raising.
 *
 * For the case where an unshareable value is expected and has a fallback: a
 * cache that shares what it can and copies the rest, rather than refusing to
 * cache anything containing a function.
 */
export function tryMakeShareable<T>(
  value: T,
): { ok: true; value: T } | { ok: false; reason: string } {
  try {
    return { ok: true, value: makeShareable(value) };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
}

/**
 * Rails' `shareable_proc` — a function that can be rebuilt in another isolate.
 *
 * The source text, not the function. A function crosses only as something the
 * other side can compile, and that means it must not close over anything —
 * which is checked by refusing any function whose source names a free
 * variable the caller listed as captured.
 */
export function shareableProc(source: string, captured: readonly string[] = []): string {
  if (captured.length > 0) {
    throw new TypeError(
      `This function closes over ${captured.join(", ")}, which the other isolate does not have. ` +
        `A function crosses as source text that the other side compiles, so anything it needs has ` +
        `to be passed as an argument instead.`,
    );
  }

  return source;
}

/** Rails' `shareable_lambda` — the same for an expression. */
export function shareableLambda(source: string, captured: readonly string[] = []): string {
  return shareableProc(source, captured);
}

export function tryShareableProc(
  source: string,
  captured: readonly string[] = [],
): string | undefined {
  return captured.length > 0 ? undefined : source;
}

export function tryShareableLambda(
  source: string,
  captured: readonly string[] = [],
): string | undefined {
  return tryShareableProc(source, captured);
}

/**
 * Rails' `share_with` — hand a value to a named isolate.
 *
 * Refuses an unshareable value rather than copying it silently. Copying is the
 * failure that is not an error: the other side mutates its copy, this side
 * never sees it, and the feature quietly does nothing.
 */
export function shareWith<T>(target: string, value: T): { target: string; value: T } {
  if (!shareable(value)) {
    throw new TypeError(
      `This value cannot be shared with ${JSON.stringify(target)} because it is not frozen all ` +
        `the way down. Copying it instead would not be an error — the other side would mutate ` +
        `its copy, this side would never see it, and the feature would quietly do nothing.`,
    );
  }

  return { target, value };
}

// --- snapshots ----------------------------------------------------------------------

/**
 * Rails' `to_ractor_snapshot` — the configuration an isolate starts from.
 *
 * A snapshot rather than a live reference. An isolate reading configuration
 * through a reference would see changes made after it started, and the point
 * of starting one is that it does not.
 */
export function toRactorSnapshot(config: Record<string, unknown>): string {
  return JSON.stringify(config, (_key, value: unknown) => {
    if (typeof value === "function") {
      throw new TypeError(
        "Configuration containing a function cannot be snapshotted for an isolate. Whatever " +
          "the function decides has to be decided before the snapshot is taken.",
      );
    }

    return value;
  });
}

/** Rails' `load_ractor_snapshot`. */
export function loadRactorSnapshot(snapshot: string): Record<string, unknown> {
  const loaded = JSON.parse(snapshot) as Record<string, unknown>;

  // Frozen on arrival, so the isolate cannot edit configuration that the
  // parent believes it shares — the two would then disagree with nothing
  // reporting it.
  return makeShareable(loaded);
}

// --- which isolate is running --------------------------------------------------------

let mainIsolate = true;

/** Rails' `Ractor.main?`. */
export function main(): boolean {
  return mainIsolate;
}

export function setMainIsolate(isMain: boolean): void {
  mainIsolate = isMain;
}

/**
 * Rails' `on_main` — run something only in the main isolate.
 *
 * Used for anything with a single owner: writing a log file, binding a port,
 * running a migration. Done in every isolate, each of those is a race whose
 * loser fails with an error about the resource rather than about the
 * duplication.
 */
export function onMain<T>(body: () => T): T | undefined {
  return mainIsolate ? body() : undefined;
}

/**
 * Rails' `ractor_logger` — a logger an isolate can hold.
 *
 * Named by isolate. Two isolates writing interleaved lines to one destination
 * produce a log where no single line is wrong and no sequence of them is
 * right, which is harder to debug than no log.
 */
export function ractorLogger(
  name: string,
  write: (line: string) => void,
): (message: string) => void {
  return (message) => write(`[${name}] ${message}`);
}

/**
 * Rails' `thread_safely` — run a body under a lock keyed by name.
 *
 * Named rather than global: one lock for everything makes any two unrelated
 * critical sections wait for each other, which turns a correctness fix into a
 * throughput problem nobody connects back to it.
 */
const locks = new Map<string, Promise<unknown>>();

export async function threadSafely<T>(name: string, body: () => Promise<T> | T): Promise<T> {
  const previous = locks.get(name) ?? Promise.resolve();

  // `then(body, body)` rather than `then(body)`: the next body runs whether the
  // previous one succeeded or threw. One failure freeing the lock for
  // everything queued behind it to run at once is the opposite of what a lock
  // is for.
  const run = previous.then(body, body);

  // The caller gets the rejection through `run`; this copy is stored and never
  // awaited, so it is neutralised to keep a handled failure from surfacing as
  // an unhandled rejection.
  locks.set(
    name,
    run.catch(() => undefined),
  );

  return run;
}

export function resetLocks(): void {
  locks.clear();
}

/**
 * Rails' `run_in_isolation` — a body that must not affect this process.
 *
 * Returns what the body produced *and* whether it was isolated, because a
 * runtime without isolation available runs the body inline. A caller that
 * could not tell the difference would believe a test ran in a fresh process
 * when it ran in this one.
 */
export async function runInIsolation<T>(
  body: () => Promise<T> | T,
  isolate?: (body: () => Promise<T> | T) => Promise<T>,
): Promise<{ result: T; isolated: boolean }> {
  if (isolate === undefined) return { result: await body(), isolated: false };

  return { result: await isolate(body), isolated: true };
}

// --- fork hooks -------------------------------------------------------------------

type ForkHook = () => void | Promise<void>;

const beforeForkHooks: ForkHook[] = [];
const afterForkHooks: ForkHook[] = [];

/** Rails' `before_fork` — anything that must not be inherited. */
export function beforeFork(hook: ForkHook): void {
  beforeForkHooks.push(hook);
}

/** Rails' `after_fork` — anything the child needs of its own. */
export function afterFork(hook: ForkHook): void {
  afterForkHooks.push(hook);
}

/** Rails' `parallelize_before_fork` for a test runner. */
export function parallelizeBeforeFork(hook: ForkHook): void {
  beforeFork(hook);
}

/**
 * Rails' `after_fork_callback` — runs the child's hooks.
 *
 * Every hook runs even if one throws, and the failures are collected. A hook
 * that raised partway through would otherwise leave the child with some of its
 * per-process state set up and some not — a database connection but no cache,
 * say — and that child then does work that looks fine and is not.
 */
export async function afterForkCallback(): Promise<Error[]> {
  return runAll(afterForkHooks);
}

export async function beforeForkCallback(): Promise<Error[]> {
  return runAll(beforeForkHooks);
}

async function runAll(hooks: readonly ForkHook[]): Promise<Error[]> {
  const failures: Error[] = [];

  for (const hook of hooks) {
    try {
      await hook();
    } catch (error) {
      failures.push(error as Error);
    }
  }

  return failures;
}

export function resetForkHooks(): void {
  beforeForkHooks.length = 0;
  afterForkHooks.length = 0;
}

// --- what a body cost ----------------------------------------------------------------

/**
 * Rails' `allocations` — objects created while a body ran.
 *
 * Reported as a difference rather than a total, because a total is a number
 * about the process and this is a question about the code: "did this request
 * allocate more than the last one" is answerable, "does this process hold
 * four million objects" is not.
 */
export function allocations(before: number, after: number): number {
  return Math.max(0, after - before);
}

/**
 * Rails' `gc_time` — milliseconds spent collecting while a body ran.
 *
 * Separate from wall time, because the two answer different questions. A
 * request that took 200ms of which 180 was collection is not a slow request,
 * it is a symptom of something that allocated heavily earlier.
 */
export function gcTime(before: number, after: number): number {
  return Math.max(0, after - before);
}
