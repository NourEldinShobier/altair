/**
 * Silencing one subscriber for a block, ported from `ErrorReporter#disable` in
 * `activesupport/lib/active_support/error_reporter.rb`.
 *
 * For an integration that handles errors higher in the stack: the library
 * reports, the application catches, and the tracker should hear about it once
 * rather than twice.
 *
 * Rails keeps the disabled list per fiber, in `IsolatedExecutionState`, and
 * that is the whole design. A reporter is process-wide and errors happen
 * everywhere, so a flag on the reporter would silence one integration for
 * every request running beside the block — and an error tracker silenced for
 * somebody else's request is a failure nobody will ever be told about, which
 * is the one failure this class exists to prevent.
 */

import { describe, expect, it } from "bun:test";
import { ErrorReporter } from "../src/error_reporter.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function reporterWith(): {
  reporter: ErrorReporter;
  first: string[];
  second: string[];
  a: (error: unknown) => void;
  b: (error: unknown) => void;
} {
  const reporter = new ErrorReporter();
  const first: string[] = [];
  const second: string[] = [];
  const a = (error: unknown): void => {
    first.push((error as Error).message);
  };
  const b = (error: unknown): void => {
    second.push((error as Error).message);
  };

  reporter.subscribe(a);
  reporter.subscribe(b);

  return { reporter, first, second, a, b };
}

describe("inside the block", () => {
  it("does not tell the one that was disabled", async () => {
    const { reporter, first, second, a } = reporterWith();

    await reporter.disable(a, () => {
      reporter.report(new Error("boom"));
    });

    expect(first).toEqual([]);
    expect(second).toEqual(["boom"]);
  });

  it("still tells it after the block", async () => {
    const { reporter, first, a } = reporterWith();

    await reporter.disable(a, () => undefined);
    reporter.report(new Error("boom"));

    expect(first).toEqual(["boom"]);
  });

  it("carries across an await", async () => {
    const { reporter, first, second, a } = reporterWith();

    await reporter.disable(a, async () => {
      await tick();
      reporter.report(new Error("boom"));
    });

    expect(first).toEqual([]);
    expect(second).toEqual(["boom"]);
  });

  it("nests, and an inner block does not un-silence an outer one", async () => {
    const { reporter, first, second, a, b } = reporterWith();

    await reporter.disable(a, async () => {
      await reporter.disable(b, () => undefined);

      reporter.report(new Error("boom"));
    });

    expect(first).toEqual([]);
    expect(second).toEqual(["boom"]);
  });

  it("silences two when two are asked for", async () => {
    const { reporter, first, second, a, b } = reporterWith();

    await reporter.disable(a, async () => {
      await reporter.disable(b, () => {
        reporter.report(new Error("boom"));
      });
    });

    expect(first).toEqual([]);
    expect(second).toEqual([]);
  });
});

describe("beside the block", () => {
  /**
   * The reason it is scoped. A flag would silence the tracker for every
   * request running while the block ran.
   */
  it("does not silence work running alongside", async () => {
    const { reporter, first, a } = reporterWith();

    await Promise.all([
      reporter.disable(a, async () => {
        await tick();
        await tick();
      }),
      (async () => {
        await tick();
        reporter.report(new Error("elsewhere"));
      })(),
    ]);

    expect(first).toEqual(["elsewhere"]);
  });
});

describe("when the block throws", () => {
  /**
   * Nothing to put back, which is the other half of why this is not
   * unsubscribe-and-resubscribe: that leaves the subscriber gone.
   */
  it("leaves the subscriber subscribed", async () => {
    const { reporter, first, a } = reporterWith();

    await expect(
      reporter.disable(a, () => {
        throw new Error("from the body");
      }),
    ).rejects.toThrow("from the body");

    reporter.report(new Error("boom"));

    expect(first).toEqual(["boom"]);
  });
});

describe("what it returns", () => {
  it("hands back the body's value", async () => {
    const { reporter, a } = reporterWith();

    expect(await reporter.disable(a, () => "done")).toBe("done");
  });
});
