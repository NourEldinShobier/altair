/**
 * Building up the context every error report carries, ported from the
 * `add_middleware` cases in `activesupport/test/error_reporter_test.rb`.
 *
 * The case this is for is the one a per-call `context:` cannot cover: the
 * reports that matter most are the ones from places nobody thought about, and
 * those are exactly the call sites where somebody would have forgotten to
 * attach the tenant.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { ErrorReporter, type ErrorContext } from "../src/error_reporter.js";

const reporter = new ErrorReporter();

afterEach(() => reporter.reset());

/** Records what the subscribers were handed. */
function reported(): { seen: ErrorContext[]; errors: unknown[] } {
  const seen: ErrorContext[] = [];
  const errors: unknown[] = [];

  reporter.subscribe((error, context) => {
    errors.push(error);
    seen.push(context);
  });

  return { seen, errors };
}

describe("what the middleware adds", () => {
  it("reaches every subscriber", () => {
    const { seen } = reported();

    reporter.addMiddleware((_error, details) => ({ ...details.context, deploy: "abc123" }));
    reporter.report(new Error("boom"));

    expect(seen[0]?.context).toEqual({ deploy: "abc123" });
  });

  it("is merged with the context the call gave", () => {
    const { seen } = reported();

    reporter.addMiddleware((_error, details) => ({ ...details.context, deploy: "abc123" }));
    reporter.report(new Error("boom"), { context: { order: 7 } });

    expect(seen[0]?.context).toEqual({ order: 7, deploy: "abc123" });
  });

  /** So a middleware can decide based on what the call site said. */
  it("sees the call's own context and the rest of the details", () => {
    let saw: ErrorContext | undefined;

    reported();
    reporter.addMiddleware((_error, details) => void (saw = { ...details }));
    reporter.report(new Error("boom"), {
      context: { order: 7 },
      handled: false,
      severity: "error",
      source: "jobs",
    });

    expect(saw?.context).toEqual({ order: 7 });
    expect(saw?.handled).toBe(false);
    expect(saw?.severity).toBe("error");
    expect(saw?.source).toBe("jobs");
  });

  it("sees the error", () => {
    const boom = new Error("boom");
    let saw: unknown;

    reported();
    reporter.addMiddleware((error) => void (saw = error));
    reporter.report(boom);

    expect(saw).toBe(boom);
  });

  it("can replace the context outright", () => {
    const { seen } = reported();

    reporter.addMiddleware(() => ({ only: "this" }));
    reporter.report(new Error("boom"), { context: { order: 7 } });

    expect(seen[0]?.context).toEqual({ only: "this" });
  });
});

describe("more than one", () => {
  /**
   * So a middleware can build on another's work, rather than each starting
   * from the call's own context with the last writer winning.
   */
  it("runs in order, each seeing what the last produced", () => {
    const { seen } = reported();

    reporter.addMiddleware((_error, details) => ({ ...details.context, first: true }));
    reporter.addMiddleware((_error, details) => ({ ...details.context, second: details.context }));
    reporter.report(new Error("boom"));

    expect(seen[0]?.context).toEqual({ first: true, second: { first: true } });
  });

  /** Forgetting the return would otherwise empty everyone else's context. */
  it("leaves the context alone when one returns nothing", () => {
    const { seen } = reported();

    reporter.addMiddleware((_error, details) => ({ ...details.context, deploy: "abc123" }));
    reporter.addMiddleware(() => undefined);
    reporter.report(new Error("boom"));

    expect(seen[0]?.context).toEqual({ deploy: "abc123" });
  });

  /**
   * This runs while something has already gone wrong: a context builder that
   * took the original error down with it would be the worst failure this
   * class could have.
   */
  it("carries on when one throws", () => {
    const { seen, errors } = reported();
    const boom = new Error("boom");

    reporter.addMiddleware(() => {
      throw new Error("no tenant");
    });
    reporter.addMiddleware((_error, details) => ({ ...details.context, deploy: "abc123" }));
    reporter.report(boom);

    expect(errors).toEqual([boom]);
    expect(seen[0]?.context).toEqual({ deploy: "abc123" });
  });

  it("still reports when every one of them throws", () => {
    const { errors } = reported();
    const boom = new Error("boom");

    reporter.addMiddleware(() => {
      throw new Error("nope");
    });
    reporter.report(boom);

    expect(errors).toEqual([boom]);
  });
});

describe("taking one away", () => {
  it("stops it running", () => {
    const { seen } = reported();

    const added = reporter.addMiddleware((_error, details) => ({
      ...details.context,
      deploy: "abc123",
    }));

    added.remove();
    reporter.report(new Error("boom"));

    expect(seen[0]?.context).toEqual({});
  });

  it("leaves the others alone", () => {
    const { seen } = reported();

    reporter.addMiddleware((_error, details) => ({ ...details.context, one: 1 }));
    const added = reporter.addMiddleware((_error, details) => ({ ...details.context, two: 2 }));
    reporter.addMiddleware((_error, details) => ({ ...details.context, three: 3 }));

    added.remove();
    reporter.report(new Error("boom"));

    expect(seen[0]?.context).toEqual({ one: 1, three: 3 });
  });

  it("is forgotten by a reset, like a subscriber", () => {
    const { seen } = reported();

    reporter.addMiddleware(() => ({ deploy: "abc123" }));
    reporter.reset();

    const after = reported();
    reporter.report(new Error("boom"));

    expect(seen).toHaveLength(0);
    expect(after.seen[0]?.context).toEqual({});
  });
});
