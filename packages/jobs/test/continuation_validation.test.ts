/**
 * Step validation, resumption limits, and what a continuation reports about
 * itself. Ported from `activejob/test/cases/continuation_test.rb` and the
 * validation cases in `activejob/lib/active_job/continuation/validation.rb`
 * (Rails 8).
 *
 * All of it guards the same failure: a resumed job replays `perform` from the
 * top and matches its steps by name against what finished last time. If the
 * sequence it produces this time differs from the one it was interrupted
 * against, matching by name either skips work that never ran or repeats work
 * that did — and neither shows up as an error at the time.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  Continuation,
  InvalidStepError,
  Job,
  JobInterrupted,
  MemoryQueue,
  ResumeLimitError,
  Step,
  UnadvanceableCursorError,
  interruptAfterStep,
  interruptDuringStep,
  runJob,
  type ContinuationState,
  type JobPayload,
} from "../src/index.js";

/** Runs a body with a continuation, returning it so tests can read its state. */
async function run(
  body: (step: Continuation) => Promise<void>,
  state?: ContinuationState,
  stopping: () => boolean = () => false,
): Promise<Continuation> {
  const continuation = new Continuation(state, stopping);

  await body(continuation);

  return continuation;
}

describe("step validation", () => {
  it("refuses a step it has already run this attempt", async () => {
    const continuation = new Continuation(undefined);

    await continuation.step("one", () => undefined);

    expect(continuation.step("one", () => undefined)).rejects.toThrow(InvalidStepError);
  });

  it("names the repeated step", async () => {
    const continuation = new Continuation(undefined);

    await continuation.step("one", () => undefined);

    expect(continuation.step("one", () => undefined)).rejects.toThrow(
      "Step 'one' has already been encountered",
    );
  });

  /**
   * A nested step cannot be resumed: only the outer one is recorded, so an
   * interrupt inside the inner step resumes the outer from the top and runs
   * the inner again.
   */
  it("refuses a step declared inside another", async () => {
    const continuation = new Continuation(undefined);

    expect(
      continuation.step("outer", async () => {
        await continuation.step("inner", () => undefined);
      }),
    ).rejects.toThrow("Step 'inner' is nested inside step 'outer'");
  });

  it("refuses to resume into a different step", async () => {
    const continuation = new Continuation({ completed: [], step: "two" });

    expect(continuation.step("three", () => undefined)).rejects.toThrow(
      "Step 'three' found, expected to resume from 'two'",
    );
  });

  /**
   * The completed list is a sequence, not a set. Reaching them in a different
   * order means the job took a different path and the recorded position no
   * longer points where it did.
   */
  it("refuses a completed step out of the order it completed in", async () => {
    const continuation = new Continuation({ completed: ["one", "two"] });

    expect(continuation.step("two", () => undefined)).rejects.toThrow(
      "Step 'two' found, expected to see 'one'",
    );
  });

  it("allows the recorded order", async () => {
    const ran: string[] = [];
    const continuation = new Continuation({ completed: ["one", "two"], step: "three" });

    await continuation.step("one", () => ran.push("one"));
    await continuation.step("two", () => ran.push("two"));
    await continuation.step("three", () => ran.push("three"));

    expect(ran).toEqual(["three"]);
  });

  /** Steps after the resumed one are new, so nothing constrains their names. */
  it("allows fresh steps once the resumed one is past", async () => {
    const ran: string[] = [];
    const continuation = new Continuation({ completed: [], step: "one" });

    await continuation.step("one", () => ran.push("one"));
    await continuation.step("two", () => ran.push("two"));

    expect(ran).toEqual(["one", "two"]);
  });
});

describe("what a step knows about itself", () => {
  it("says whether it was picked up from an earlier attempt", async () => {
    const seen: boolean[] = [];
    const continuation = new Continuation({ completed: [], step: "one", cursor: 4 });

    await continuation.step("one", (step) => seen.push(step.resumed));
    await continuation.step("two", (step) => seen.push(step.resumed));

    expect(seen).toEqual([true, false]);
  });

  it("serializes as its name and cursor", async () => {
    let pair: [string, unknown] | undefined;
    const continuation = new Continuation(undefined);

    await continuation.step("one", (step) => {
      step.set(7);
      pair = step.toA();
    });

    expect(pair).toEqual(["one", 7]);
  });

  it("describes where it is", async () => {
    let description = "";
    const continuation = new Continuation(undefined);

    await continuation.step("process", (step) => {
      step.set(12);
      description = step.description;
    });

    expect(description).toBe("at 'process', cursor 12");
  });

  it("knows whether its cursor moved", async () => {
    const moved: boolean[] = [];
    const continuation = new Continuation(undefined);

    await continuation.step("one", (step) => {
      moved.push(step.advanced);
      step.set(1);
      moved.push(step.advanced);
    });

    expect(moved).toEqual([false, true]);
  });

  it("takes a starting cursor", async () => {
    const seen: unknown[] = [];
    const continuation = new Continuation(undefined);

    await continuation.step("one", (step) => seen.push(step.cursor), { start: 0 });

    expect(seen).toEqual([0]);
  });

  /** The resumed cursor wins: it is where the job actually got to. */
  it("prefers the resumed cursor over the starting one", async () => {
    const seen: unknown[] = [];
    const continuation = new Continuation({ completed: [], step: "one", cursor: 40 });

    await continuation.step("one", (step) => seen.push(step.cursor), { start: 0 });

    expect(seen).toEqual([40]);
  });
});

describe("advanceFrom", () => {
  /**
   * The distinction this exists for: `advance(id)` records the record just
   * handled, `advanceFrom(id)` records the next one. A job resuming with
   * `id >= cursor` re-processes one record under the first and none under the
   * second.
   */
  it("records one past the value it is given", async () => {
    let cursor: unknown;
    const continuation = new Continuation(undefined);

    await continuation.step("one", (step) => {
      step.advanceFrom(41);
      cursor = step.cursor;
    });

    expect(cursor).toBe(42);
  });

  it("moves on from where it already is when given nothing", async () => {
    let cursor: unknown;
    const continuation = new Continuation(undefined);

    await continuation.step(
      "one",
      (step) => {
        step.advanceFrom();
        step.advanceFrom();
        cursor = step.cursor;
      },
      { start: 0 },
    );

    expect(cursor).toBe(2);
  });

  it("handles a bigint cursor", async () => {
    let cursor: unknown;
    const continuation = new Continuation(undefined);

    await continuation.step("one", (step) => {
      step.advanceFrom(9007199254740993n);
      cursor = step.cursor;
    });

    expect(cursor).toBe(9007199254740994n);
  });

  /** Guessing at "one past a string" would enqueue a wrong cursor silently. */
  it("refuses a cursor it cannot add one to", async () => {
    const continuation = new Continuation(undefined);

    expect(
      continuation.step("one", (step) => {
        step.advanceFrom("abc");
      }),
    ).rejects.toThrow(UnadvanceableCursorError);
  });

  it("refuses an undefined cursor with no starting value", async () => {
    const continuation = new Continuation(undefined);

    expect(
      continuation.step("one", (step) => {
        step.advanceFrom();
      }),
    ).rejects.toThrow(UnadvanceableCursorError);
  });
});

describe("what a continuation reports", () => {
  it("has not started before anything ran", () => {
    expect(new Continuation(undefined).started).toBe(false);
    expect(new Continuation(undefined).description).toBe("not started");
  });

  it("has started once a step completed", () => {
    expect(new Continuation({ completed: ["one"] }).started).toBe(true);
  });

  it("has started when it was interrupted inside a step", () => {
    expect(new Continuation({ completed: [], step: "one" }).started).toBe(true);
  });

  it("describes the step it was interrupted in", () => {
    const continuation = new Continuation({ completed: ["one"], step: "two", cursor: 5 });

    expect(continuation.description).toBe("at 'two', cursor 5");
  });

  it("describes the last completed step when between steps", () => {
    expect(new Continuation({ completed: ["one", "two"] }).description).toBe("after 'two'");
  });

  /**
   * Once the resumed step is behind us the live position is the answer, or a
   * finished job goes on claiming to be inside the step it was interrupted in.
   */
  it("stops describing the resumed step once it is finished", async () => {
    const continuation = new Continuation({ completed: [], step: "one", cursor: 5 });

    await continuation.step("one", () => undefined);

    expect(continuation.description).toBe("after 'one'");
    expect(continuation.toH().current).toBeUndefined();
  });

  it("gives the current step as a name and cursor pair", async () => {
    const continuation = await run(async (c) => {
      await c.step("one", () => undefined);
    });

    expect(continuation.toH()).toEqual({ completed: ["one"], resumptions: 0 });
  });

  it("carries the interrupted step in the pair", () => {
    const continuation = new Continuation({ completed: ["one"], step: "two", cursor: 9 });

    expect(continuation.toH().current).toEqual(["two", 9]);
  });

  it("reports what a log line wants", () => {
    const continuation = new Continuation({ completed: ["one"], step: "two", cursor: 9 });

    expect(continuation.instrumentation).toEqual({
      description: "at 'two', cursor 9",
      completedSteps: ["one"],
      currentStep: "two",
    });
  });
});

describe("advanced", () => {
  it("is false before anything happens", () => {
    expect(new Continuation(undefined).advanced).toBe(false);
  });

  it("is true once a step completes", async () => {
    const continuation = await run(async (c) => {
      await c.step("one", () => undefined);
    });

    expect(continuation.advanced).toBe(true);
  });

  /**
   * The point of tracking it separately from completion: a step that moved its
   * cursor and then raised is worth resuming rather than retrying from the
   * top, because the work behind the cursor is already done.
   */
  it("is true when a step moved its cursor and then failed", async () => {
    const continuation = new Continuation(undefined);

    await continuation
      .step("one", (step) => {
        step.set(3);
        throw new Error("boom");
      })
      .catch(() => undefined);

    expect(continuation.advanced).toBe(true);
  });

  it("is false when a step failed without moving", async () => {
    const continuation = new Continuation(undefined);

    await continuation
      .step("one", () => {
        throw new Error("boom");
      })
      .catch(() => undefined);

    expect(continuation.advanced).toBe(false);
  });
});

describe("interrupting", () => {
  it("carries a reason", () => {
    const continuation = new Continuation({ completed: ["one"] });

    expect(() => continuation.interrupt("deploying")).toThrow(JobInterrupted);

    try {
      continuation.interrupt("deploying");
    } catch (error) {
      expect((error as JobInterrupted).reason).toBe("deploying");
      expect((error as Error).message).toBe("Interrupted after 'one' (deploying)");
    }
  });

  it("defaults the reason to stopping", () => {
    try {
      new Continuation(undefined).interrupt();
    } catch (error) {
      expect((error as JobInterrupted).reason).toBe("stopping");
    }
  });

  it("carries the position to resume from", async () => {
    let thrown: JobInterrupted | undefined;
    let stopping = false;
    const continuation = new Continuation({ completed: [] }, () => stopping);

    try {
      await continuation.step("two", (step) => {
        step.set(3);
        stopping = true;
        step.checkpoint();
      });
    } catch (error) {
      thrown = error as JobInterrupted;
    }

    expect(thrown?.continuation).toEqual({
      completed: [],
      step: "two",
      cursor: 3,
      resumptions: 0,
    });
  });
});

describe("events", () => {
  it("says when a step starts and when one is skipped", async () => {
    const started: string[] = [];
    const skipped: string[] = [];
    const continuation = new Continuation({ completed: ["one"] }, () => false, {
      stepStarted: (step: Step) => started.push(step.name),
      stepSkipped: (name) => skipped.push(name),
    });

    await continuation.step("one", () => undefined);
    await continuation.step("two", () => undefined);

    expect(started).toEqual(["two"]);
    expect(skipped).toEqual(["one"]);
  });

  it("says when a job is picked up", () => {
    const resumed: string[] = [];

    new Continuation({ completed: ["one"], step: "two", cursor: 4 }, () => false, {
      resume: (instrumentation) => resumed.push(instrumentation.description),
    });

    expect(resumed).toEqual(["at 'two', cursor 4"]);
  });

  it("says nothing about resuming on a first attempt", () => {
    const resumed: string[] = [];

    new Continuation(undefined, () => false, {
      resume: () => resumed.push("resumed"),
    });

    expect(resumed).toEqual([]);
  });

  it("says why the job stopped", () => {
    const reasons: string[] = [];
    const continuation = new Continuation({ completed: [] }, () => false, {
      interrupt: (reason) => reasons.push(reason),
    });

    expect(() => continuation.interrupt("deploying")).toThrow();
    expect(reasons).toEqual(["deploying"]);
  });
});

describe("interrupt matchers", () => {
  it("matches a step at a given cursor", async () => {
    const matches = interruptDuringStep("process", 3);
    const continuation = new Continuation(undefined);

    await continuation.step("process", (step) => {
      expect(matches(continuation)).toBe(false);
      step.set(3);
      expect(matches(continuation)).toBe(true);
      step.set(4);
      expect(matches(continuation)).toBe(false);
    });
  });

  it("matches an array cursor by value", async () => {
    const matches = interruptDuringStep("process", [1, 2]);
    const continuation = new Continuation(undefined);

    await continuation.step("process", (step) => {
      step.set([1, 2]);
      expect(matches(continuation)).toBe(true);
    });
  });

  it("matches after a named step finished", async () => {
    const matches = interruptAfterStep("one");
    const continuation = new Continuation(undefined);

    await continuation.step("one", () => undefined);

    expect(matches(continuation)).toBe(true);

    await continuation.step("two", () => undefined);

    expect(matches(continuation)).toBe(false);
  });

  it("does not match while the step is still running", async () => {
    const matches = interruptAfterStep("one");
    const continuation = new Continuation(undefined);

    await continuation.step("one", () => {
      expect(matches(continuation)).toBe(false);
    });
  });
});

describe("the resumption limit", () => {
  let queue: MemoryQueue;
  const runs: number[] = [];

  class Endless extends Job {
    static override maxResumptions: number | undefined = 2;

    override async perform(): Promise<void> {
      await this.step("forever", (step) => {
        runs.push(runs.length);
        step.advance(runs.length);
      });
    }
  }

  beforeEach(() => {
    queue = new MemoryQueue();
    Job.adapter = queue;
    runs.length = 0;
    Job.register(Endless);
  });

  afterEach(() => {
    Job.adapter = undefined;
    Job.resetRegistry();
  });

  function payloadWith(resumptions: number): JobPayload {
    return {
      id: "1",
      jobClass: "Endless",
      queue: "default",
      arguments: [],
      attempts: 0,
      runAt: 0,
      enqueuedAt: 0,
      priority: 0,
      continuation: { completed: [], step: "forever", cursor: 0, resumptions },
    };
  }

  it("counts a resumption each time the job is put back", async () => {
    const result = await runJob(payloadWith(0), queue, { shouldStop: () => true });

    expect(result.status).toBe("interrupted");
    expect(result.payload.continuation?.resumptions).toBe(1);
  });

  /**
   * Without this a job whose step cannot finish inside the shutdown window
   * re-enqueues itself for ever, which from the outside looks like a busy
   * queue rather than a stuck one.
   */
  it("fails the job once it has resumed as often as it may", async () => {
    const result = await runJob(payloadWith(2), queue, { shouldStop: () => true });

    expect(result.status).toBe("failed");
    expect(result.error).toBeInstanceOf(ResumeLimitError);
  });

  it("does not run the job again once the limit is reached", async () => {
    await runJob(payloadWith(2), queue, { shouldStop: () => true });

    expect(runs).toEqual([]);
  });

  it("lets a job under the limit run", async () => {
    const result = await runJob(payloadWith(1), queue, { shouldStop: () => false });

    expect(result.status).toBe("completed");
  });

  it("has no limit unless one is set", async () => {
    Endless.maxResumptions = undefined;

    const result = await runJob(payloadWith(99), queue, { shouldStop: () => true });

    expect(result.status).toBe("interrupted");
  });
});

describe("a job performed outside a worker", () => {
  /** A body that reads its step must not behave differently under a test. */
  it("still gives its steps a real cursor", async () => {
    const seen: unknown[] = [];

    class Direct extends Job {
      override async perform(): Promise<void> {
        await this.step(
          "one",
          (step) => {
            seen.push(step.resumed, step.cursor, step.description);
            step.advance(5);
            seen.push(step.cursor);
          },
          { start: 0 },
        );
      }
    }

    await Direct.performNow();

    expect(seen).toEqual([false, 0, "at 'one', cursor 0", 5]);
  });
});
