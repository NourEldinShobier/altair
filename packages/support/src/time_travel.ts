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
 * Runs a block with the clock held at a moment.
 *
 * Nesting is allowed and the inner one wins, since a test that sets a time
 * inside a suite-wide one is saying something more specific.
 */
export async function travelTo<T>(moment: Date | number, body: () => T | Promise<T>): Promise<T> {
  const previous = globalThis.Date;
  const at = moment instanceof RealDate ? moment.getTime() : Number(moment);

  install(at);

  try {
    return await body();
  } finally {
    // Restored whatever the block did, including throwing. A test that left
    // the clock moved would put every test after it in the wrong year, and
    // the failure would look like it came from a file that never touched time.
    globalThis.Date = previous;
  }
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
