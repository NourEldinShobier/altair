/**
 * Controlling the clock in a test, ported from `ActiveSupport::Testing::
 * TimeHelpers`.
 *
 *     await travelTo(new Date("2026-01-01"), async () => { … })
 *     await freezeTime(async () => { … })
 *     await travel(3600, async () => { … })
 *
 * Anything that reads the clock is hard to test honestly. The usual
 * alternatives are both bad: sleeping makes a suite slow and still flaky —
 * this repository had a file that slept 1.1 seconds per assertion, seven
 * seconds on each of three adapters, to prove a timestamp had moved — and
 * writing the timestamp by hand tests the assignment rather than the thing
 * that was supposed to set it.
 *
 * The clock is a global, so this replaces it and puts it back. The `finally`
 * is the whole safety of the thing: a test that throws with the clock still
 * moved would leave every test after it in the wrong year, and the failure
 * would appear to be in a file that never touched time.
 */

const RealDate = Date;

/** Whether the clock is currently held. */
export function isTimeFrozen(): boolean {
  return globalThis.Date !== RealDate;
}

/** What the clock says now, real or held. */
export function currentTime(): Date {
  return new globalThis.Date();
}

function install(at: number): void {
  // A subclass rather than a wholesale replacement, so `instanceof Date`,
  // `Date.parse` and everything else a library might reach for keep working.
  class FrozenDate extends RealDate {
    // `unknown[]` rather than the Date constructor's own parameters: those are
    // overloaded, and TypeScript narrows the rest to one overload's arity —
    // which makes the no-argument case look unreachable.
    constructor(...args: unknown[]) {
      if (args.length === 0) super(at);
      else super(...(args as [number]));
    }

    static override now(): number {
      return at;
    }
  }

  globalThis.Date = FrozenDate as DateConstructor;
}

/**
 * Holds the clock at a moment.
 *
 * With a block, the clock is put back when the block ends — however it ends.
 * Nesting is allowed and the inner one wins, since a test that sets a time
 * inside a suite-wide one is saying something more specific.
 *
 * Without one, the clock stays held until `travelBack`. That form exists
 * because a test runner's per-test hooks are two separate functions: there is
 * no block to wrap a whole test in from a `beforeEach`, so a suite that wants
 * every test in a file to run at a fixed date cannot use the block form at
 * all. It is the more dangerous of the two — nothing puts the clock back if
 * the matching `travelBack` is forgotten — which is why the block form is
 * still what a single test should use.
 */
export function travelTo(moment: Date | number): void;
export function travelTo<T>(moment: Date | number, body: () => T | Promise<T>): Promise<T>;
export function travelTo<T>(moment: Date | number, body?: () => T | Promise<T>): Promise<T> | void {
  const previous = globalThis.Date;
  const at = moment instanceof RealDate ? moment.getTime() : Number(moment);

  install(at);

  if (body === undefined) return;

  return (async () => {
    try {
      return await body();
    } finally {
      // Restored whatever the block did, including throwing. A test that left
      // the clock moved would put every test after it in the wrong year, and
      // the failure would look like it came from a file that never touched
      // time.
      globalThis.Date = previous;
    }
  })();
}

/**
 * Gives the clock back. Rails' `travel_back`.
 *
 * Undoes every travel at once rather than one level, because the thing it is
 * for is an `afterEach`, and an `afterEach` does not know how many times the
 * test travelled. Unwinding one level would leave a test that travelled twice
 * holding a clock that the next file inherits.
 *
 * Safe to call when nothing travelled, so a teardown can call it
 * unconditionally rather than asking first — a teardown guarded by a question
 * is a teardown that gets the question wrong once.
 */
export function travelBack(): void {
  globalThis.Date = RealDate;
}

/** Holds the clock exactly where it is. Rails' `freeze_time`. */
export async function freezeTime<T>(body: () => T | Promise<T>): Promise<T> {
  return await travelTo(globalThis.Date.now(), body);
}

/**
 * Moves the clock on by some seconds. Rails' `travel`.
 *
 * Seconds rather than milliseconds, because the durations a test cares about
 * are "an hour later" and "a day later", and writing those in milliseconds is
 * how a test ends up asserting something about 3600 seconds by accident.
 */
export async function travel<T>(seconds: number, body: () => T | Promise<T>): Promise<T> {
  return await travelTo(globalThis.Date.now() + seconds * 1000, body);
}

/**
 * Moves the held clock without leaving the block.
 *
 * For the shape a test actually wants: do something, let an hour pass, check
 * what expired. Only meaningful inside one of the others, and says so rather
 * than silently doing nothing.
 */
export function advanceClock(seconds: number): void {
  if (!isTimeFrozen()) {
    throw new Error("advanceClock needs a held clock. Call it inside travelTo or freezeTime.");
  }

  install(globalThis.Date.now() + seconds * 1000);
}
