/**
 * Stopping a job partway through on purpose, ported from
 * `activejob/test/cases/continuation_test.rb` and the helper cases in
 * `activejob/test/cases/test_helper_test.rb`.
 *
 * The cases worth having are about scope: a stopping predicate left installed
 * fails an unrelated test while the test that caused it passes.
 */

import { describe, expect, it } from "bun:test";
import { Continuation } from "@altair/jobs";
import {
  type InterruptibleJob,
  interruptJobAfterStep,
  interruptJobDuringStep,
  stoppingReason,
  withStopping,
} from "../src/job_interruption.js";

class ImportJob {}
class OtherJob {}

/** Same name, different namespace — the case a name comparison gets wrong. */
const Billing = { ImportJob: class ImportJob {} };

function jobAt(
  Klass: new () => object,
  state: { completed?: string[]; step?: string; cursor?: unknown },
): InterruptibleJob {
  const job = new Klass();
  const continuation = new Continuation({
    completed: state.completed ?? [],
    ...(state.step === undefined ? {} : { step: state.step }),
    cursor: state.cursor,
    resumptions: 0,
  });

  return { constructor: job.constructor, continuation };
}

describe("nothing installed", () => {
  it("stops nothing", () => {
    expect(stoppingReason(jobAt(ImportJob, { step: "load" }))).toBe(false);
  });
});

describe("stopping inside a step", () => {
  it("stops at the named step", async () => {
    await interruptJobDuringStep(ImportJob, "load", {}, () => {
      expect(stoppingReason(jobAt(ImportJob, { step: "load" }))).toBe("stopping");
    });
  });

  it("leaves another step alone", async () => {
    await interruptJobDuringStep(ImportJob, "load", {}, () => {
      expect(stoppingReason(jobAt(ImportJob, { step: "save" }))).toBe(false);
    });
  });

  /**
   * The class rather than the name: two jobs can share a name across
   * namespaces, and interrupting the wrong one produces a test that passes
   * while proving nothing.
   */
  it("leaves another job alone", async () => {
    await interruptJobDuringStep(ImportJob, "load", {}, () => {
      expect(stoppingReason(jobAt(OtherJob, { step: "load" }))).toBe(false);
    });
  });

  it("leaves a same-named job in another namespace alone", async () => {
    await interruptJobDuringStep(ImportJob, "load", {}, () => {
      expect(stoppingReason(jobAt(Billing.ImportJob, { step: "load" }))).toBe(false);
    });
  });

  it("stops at a given cursor", async () => {
    await interruptJobDuringStep(ImportJob, "load", { cursor: 6 }, () => {
      expect(stoppingReason(jobAt(ImportJob, { step: "load", cursor: 6 }))).toBe("stopping");
      expect(stoppingReason(jobAt(ImportJob, { step: "load", cursor: 5 }))).toBe(false);
    });
  });

  /** An array cursor is the normal case, so cursors compare by value. */
  it("compares an array cursor by value", async () => {
    await interruptJobDuringStep(ImportJob, "load", { cursor: [1, 2] }, () => {
      expect(stoppingReason(jobAt(ImportJob, { step: "load", cursor: [1, 2] }))).toBe("stopping");
    });
  });

  /** What a test asking "does this resume mid-step at all?" wants. */
  it("stops at any cursor when none is given", async () => {
    await interruptJobDuringStep(ImportJob, "load", {}, () => {
      expect(stoppingReason(jobAt(ImportJob, { step: "load", cursor: 99 }))).toBe("stopping");
    });
  });

  it("carries a custom reason", async () => {
    await interruptJobDuringStep(ImportJob, "load", { reason: "deploying" }, () => {
      expect(stoppingReason(jobAt(ImportJob, { step: "load" }))).toBe("deploying");
    });
  });

  it("stops nothing that has not started a step", async () => {
    await interruptJobDuringStep(ImportJob, "load", {}, () => {
      expect(stoppingReason(jobAt(ImportJob, { completed: ["load"] }))).toBe(false);
    });
  });
});

describe("stopping after a step", () => {
  it("stops once the step has finished", async () => {
    await interruptJobAfterStep(ImportJob, "load", {}, () => {
      expect(stoppingReason(jobAt(ImportJob, { completed: ["load"] }))).toBe("stopping");
    });
  });

  it("does not stop while the step is still running", async () => {
    await interruptJobAfterStep(ImportJob, "load", {}, () => {
      expect(stoppingReason(jobAt(ImportJob, { step: "load" }))).toBe(false);
    });
  });

  /**
   * A step that has finished while another is running is not "after" the
   * first: the job is mid-work, and stopping there tests the wrong path.
   */
  it("does not stop once a later step has begun", async () => {
    await interruptJobAfterStep(ImportJob, "load", {}, () => {
      expect(stoppingReason(jobAt(ImportJob, { completed: ["load"], step: "save" }))).toBe(false);
    });
  });

  it("does not stop after a different step", async () => {
    await interruptJobAfterStep(ImportJob, "load", {}, () => {
      expect(stoppingReason(jobAt(ImportJob, { completed: ["load", "save"] }))).toBe(false);
    });
  });

  it("leaves another job alone", async () => {
    await interruptJobAfterStep(ImportJob, "load", {}, () => {
      expect(stoppingReason(jobAt(OtherJob, { completed: ["load"] }))).toBe(false);
    });
  });

  it("carries a custom reason", async () => {
    await interruptJobAfterStep(ImportJob, "load", { reason: "deploying" }, () => {
      expect(stoppingReason(jobAt(ImportJob, { completed: ["load"] }))).toBe("deploying");
    });
  });
});

describe("the scope of a predicate", () => {
  /**
   * Left installed, every later job in the process stops partway — and the
   * failure appears in an unrelated test while the one that caused it passes.
   */
  it("is gone after the block", async () => {
    await interruptJobDuringStep(ImportJob, "load", {}, () => undefined);

    expect(stoppingReason(jobAt(ImportJob, { step: "load" }))).toBe(false);
  });

  it("is gone even when the block throws", async () => {
    await expect(
      interruptJobDuringStep(ImportJob, "load", {}, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(stoppingReason(jobAt(ImportJob, { step: "load" }))).toBe(false);
  });

  /** Restored rather than cleared, so nesting works. */
  it("restores the outer one", async () => {
    await interruptJobDuringStep(ImportJob, "load", {}, async () => {
      await interruptJobDuringStep(ImportJob, "save", {}, () => {
        expect(stoppingReason(jobAt(ImportJob, { step: "save" }))).toBe("stopping");
        expect(stoppingReason(jobAt(ImportJob, { step: "load" }))).toBe(false);
      });

      expect(stoppingReason(jobAt(ImportJob, { step: "load" }))).toBe("stopping");
    });
  });

  it("hands back what the block returned", async () => {
    expect(await interruptJobDuringStep(ImportJob, "load", {}, () => 7)).toBe(7);
  });

  it("waits for an async block", async () => {
    const order: string[] = [];

    await withStopping(
      () => false,
      async () => {
        await Promise.resolve();
        order.push("body");
      },
    );

    expect(order).toEqual(["body"]);
  });
});
