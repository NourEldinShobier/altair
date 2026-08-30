/**
 * Grouping a stack and following a cause chain, ported from
 * `actionpack/test/dispatch/exception_wrapper_test.rb` — the `application_trace`,
 * `framework_trace`, `full_trace`, `traces`, `rescue_response?` and `show?`
 * cases.
 *
 * A framework error arrives with forty frames of which three are the
 * application's, and it is usually wrapping the error that actually says what
 * went wrong. A page that shows all forty frames of the outermost error is a
 * page that answers neither question.
 */

import { describe, expect, it } from "bun:test";
import {
  ExceptionWrapper,
  causesFor,
  exceptionId,
  exceptionInspect,
  extractFileAndLineNumber,
  extractSourceFragmentLines,
  hasCause,
  isRescueResponse,
  showDetailedExceptions,
  sourceFragment,
  statusCodeForException,
  wrappedCausesFor,
} from "../src/exception_wrapper.js";

const ROOT = "/app";

/** A stack with two of the application's frames and two of somebody else's. */
function mixedStack(): string {
  return [
    "Error: boom",
    "    at handle (/app/controllers/posts.ts:12:5)",
    "    at render (/app/node_modules/framework/view.js:40:9)",
    "    at show (/app/controllers/posts.ts:3:1)",
    "    at dispatch (node:internal/http:88:2)",
  ].join("\n");
}

function errorWith(stack: string, name = "Error", message = "boom"): Error {
  const error = new Error(message);
  error.name = name;
  error.stack = stack;

  return error;
}

describe("cause chains", () => {
  it("yields every cause, outermost first", () => {
    const root = new Error("driver closed");
    const middle = new Error("query failed", { cause: root });
    const outer = new Error("request failed", { cause: middle });

    expect(Array.from(causesFor(outer)).map((e) => e.message)).toEqual([
      "query failed",
      "driver closed",
    ]);
  });

  it("yields nothing for an error that wraps nothing", () => {
    expect(Array.from(causesFor(new Error("alone")))).toEqual([]);
  });

  it("ignores a cause that is not an error", () => {
    expect(Array.from(causesFor(new Error("x", { cause: "a string" })))).toEqual([]);
  });

  /**
   * Ruby's `cause` is set by the runtime and cannot loop. Ours is an ordinary
   * property, and a loop here would spin forever on the page that is supposed
   * to explain the failure.
   */
  it("stops at a cycle instead of spinning", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    a.cause = b;

    expect(Array.from(causesFor(a)).map((e) => e.message)).toEqual(["b"]);
  });

  it("stops when an error causes itself", () => {
    const a = new Error("a");
    a.cause = a;

    expect(Array.from(causesFor(a))).toEqual([]);
  });

  it("says whether anything wrapped anything", () => {
    expect(hasCause(new Error("x", { cause: new Error("y") }))).toBe(true);
    expect(hasCause(new Error("x"))).toBe(false);
  });

  it("wraps each cause so the page renders them the same way", () => {
    const outer = new Error("outer", { cause: new Error("inner") });

    const wrapped = wrappedCausesFor(outer, ROOT);

    expect(wrapped).toHaveLength(1);
    expect(wrapped[0]?.message()).toBe("inner");
  });

  it("wraps them on the wrapper too", () => {
    const outer = new Error("outer", { cause: new Error("inner") });

    expect(new ExceptionWrapper(outer, ROOT).wrappedCauses).toHaveLength(1);
  });
});

describe("trace groups", () => {
  const wrapper = new ExceptionWrapper(errorWith(mixedStack()), ROOT);

  it("returns only the application's frames", () => {
    expect(wrapper.cleanBacktrace("application").map((f) => f.name)).toEqual(["handle", "show"]);
  });

  it("returns only frames from outside it", () => {
    expect(wrapper.cleanBacktrace("framework").map((f) => f.name)).toEqual(["render", "dispatch"]);
  });

  it("returns both in the full trace", () => {
    expect(wrapper.cleanBacktrace("full")).toHaveLength(4);
  });

  it("cannot return undefined for an error with no stack", () => {
    const bare = new ExceptionWrapper(errorWith(""), ROOT);

    expect(bare.cleanBacktrace("application")).toEqual([]);
    expect(bare.cleanBacktrace("full")).toEqual([]);
  });

  /** The id comes from the full trace so a link survives the reader switching tabs. */
  it("numbers every frame by its place in the full trace", () => {
    const traces = wrapper.traces();

    expect(traces.full.map((each) => each.id)).toEqual([0, 1, 2, 3]);
    expect(traces.application.map((each) => each.id)).toEqual([0, 2]);
    expect(traces.framework.map((each) => each.id)).toEqual([1, 3]);
  });

  it("puts every frame in exactly one of the two groups", () => {
    const traces = wrapper.traces();

    expect(traces.application.length + traces.framework.length).toBe(traces.full.length);
  });
});

describe("exceptionTrace", () => {
  it("is the application's frames when it has some", () => {
    const wrapper = new ExceptionWrapper(errorWith(mixedStack()), ROOT);

    expect(wrapper.exceptionTrace().map((f) => f.name)).toEqual(["handle", "show"]);
  });

  it("falls back to the framework's when it has none", () => {
    const stack = "Error: boom\n    at render (/app/node_modules/framework/view.js:40:9)";

    expect(new ExceptionWrapper(errorWith(stack), ROOT).exceptionTrace()).toHaveLength(1);
  });

  /**
   * A routing error ran no application code — that is what it means. Printing
   * the router's internals in its place suggests the router is what to fix.
   */
  it("stays empty for an error whose emptiness is the answer", () => {
    const stack = "Error: boom\n    at recognize (/app/node_modules/framework/router.js:9:1)";

    expect(new ExceptionWrapper(errorWith(stack, "RoutingError"), ROOT).exceptionTrace()).toEqual(
      [],
    );
  });
});

describe("traceToShow", () => {
  it("opens on the application's frames when there are some", () => {
    expect(new ExceptionWrapper(errorWith(mixedStack()), ROOT).traceToShow()).toBe("application");
  });

  it("opens on the full trace when there are none", () => {
    const stack = "Error: boom\n    at render (/app/node_modules/framework/view.js:40:9)";

    expect(new ExceptionWrapper(errorWith(stack), ROOT).traceToShow()).toBe("full");
  });

  /** A routing error's page is the routes, not a stack. */
  it("stays on the application tab for a routing error", () => {
    const stack = "Error: boom\n    at recognize (/app/node_modules/framework/router.js:9:1)";

    expect(new ExceptionWrapper(errorWith(stack, "RoutingError"), ROOT).traceToShow()).toBe(
      "application",
    );
  });

  it("names the frame whose source is shown first", () => {
    expect(new ExceptionWrapper(errorWith(mixedStack()), ROOT).sourceToShowId()).toBe(0);
  });

  it("names the first framework frame when that is the tab", () => {
    const stack = [
      "Error: boom",
      "    at render (/app/node_modules/framework/view.js:40:9)",
      "    at dispatch (node:internal/http:88:2)",
    ].join("\n");

    expect(new ExceptionWrapper(errorWith(stack), ROOT).sourceToShowId()).toBe(0);
  });

  it("names nothing when there are no frames at all", () => {
    expect(new ExceptionWrapper(errorWith(""), ROOT).sourceToShowId()).toBeUndefined();
  });
});

describe("unwrapping", () => {
  /**
   * A wrapper's own stack points into the machinery that wrapped it, which is
   * never where the bug is.
   */
  it("reports the error a wrapper wrapped", () => {
    const inner = new Error("the real one");
    const outer = errorWith("Error: outer", "TemplateError");
    outer.cause = inner;

    expect(new ExceptionWrapper(outer, ROOT).unwrappedException()).toBe(inner);
  });

  it("reports the error itself when it is not a wrapper", () => {
    const error = errorWith("Error: boom");

    expect(new ExceptionWrapper(error, ROOT).unwrappedException()).toBe(error);
  });

  it("reports the wrapper itself when it wrapped nothing", () => {
    const outer = errorWith("Error: outer", "TemplateError");

    expect(new ExceptionWrapper(outer, ROOT).unwrappedException()).toBe(outer);
  });

  /** The frames shown belong to the error that failed, not the one that noticed. */
  it("takes the backtrace from what was wrapped", () => {
    const inner = errorWith("Error: inner\n    at real (/app/models/post.ts:7:1)");
    const outer = errorWith("Error: outer\n    at render (/app/node_modules/f/view.js:1:1)");
    outer.name = "TemplateError";
    outer.cause = inner;

    expect(new ExceptionWrapper(outer, ROOT).cleanBacktrace("full").map((f) => f.name)).toEqual([
      "real",
    ]);
  });

  /** And so does the status, or a wrapped 404 reports as a 500. */
  it("takes the status from what was wrapped", () => {
    const inner = errorWith("Error: inner", "RecordNotFound");
    const outer = errorWith("Error: outer", "TemplateError");
    outer.cause = inner;

    expect(new ExceptionWrapper(outer, ROOT).statusCode()).toBe(404);
  });

  it("says whether it is a wrapped render failure", () => {
    expect(new ExceptionWrapper(errorWith("", "TemplateError"), ROOT).templateError()).toBe(true);
    expect(new ExceptionWrapper(errorWith(""), ROOT).templateError()).toBe(false);
  });

  it("passes on the message about which partial failed", () => {
    const error = errorWith("", "TemplateError");
    (error as unknown as { subTemplateMessage: string }).subTemplateMessage =
      "Trace of template inclusion: posts/_form";

    expect(new ExceptionWrapper(error, ROOT).subTemplateMessage()).toContain("posts/_form");
  });

  it("reports no such message when there is none", () => {
    expect(new ExceptionWrapper(errorWith(""), ROOT).subTemplateMessage()).toBeUndefined();
  });

  it("passes on the several errors behind one", () => {
    const error = errorWith("");
    (error as unknown as { failures: unknown[] }).failures = [new Error("a"), new Error("b")];

    expect(new ExceptionWrapper(error, ROOT).failures()).toHaveLength(2);
  });

  it("reports none when the error collects nothing", () => {
    expect(new ExceptionWrapper(errorWith(""), ROOT).failures()).toEqual([]);
  });
});

describe("statuses and templates", () => {
  it("gives a classified error its status", () => {
    expect(statusCodeForException("RecordNotFound")).toBe(404);
    expect(statusCodeForException("ParameterMissing")).toBe(400);
  });

  /**
   * An exception nobody has classified is a bug until somebody says otherwise,
   * and reporting a bug as a 404 is how it stops being noticed.
   */
  it("gives an unclassified one a 500", () => {
    expect(statusCodeForException("SomethingNobodyListed")).toBe(500);
  });

  it("takes an override", () => {
    expect(statusCodeForException("PaymentRequired", { PaymentRequired: 402 })).toBe(402);
  });

  it("says whether an error is one the application classified", () => {
    expect(isRescueResponse(errorWith("", "RecordNotFound"))).toBe(true);
    expect(isRescueResponse(errorWith("", "SomeRandomError"))).toBe(false);
    expect(isRescueResponse("not an error")).toBe(false);
  });

  /** Some errors have a better answer than a stack. */
  it("gives a routing error the routes page", () => {
    expect(new ExceptionWrapper(errorWith("", "RoutingError"), ROOT).rescueTemplate()).toBe(
      "routing_error",
    );
  });

  it("gives anything unlisted the diagnostics page", () => {
    expect(new ExceptionWrapper(errorWith("", "WhateverError"), ROOT).rescueTemplate()).toBe(
      "diagnostics",
    );
  });
});

describe("showDetailedExceptions", () => {
  it("shows nothing when told none", () => {
    expect(showDetailedExceptions("none", errorWith("", "RecordNotFound"))).toBe(false);
  });

  it("shows everything when told all", () => {
    expect(showDetailedExceptions("all", errorWith("", "SomeRandomError"))).toBe(true);
  });

  /**
   * The useful middle: a staging environment can be readable without printing
   * source to whoever finds an unhandled bug.
   */
  it("shows only classified errors when told rescuable", () => {
    expect(showDetailedExceptions("rescuable", errorWith("", "RecordNotFound"))).toBe(true);
    expect(showDetailedExceptions("rescuable", errorWith("", "SomeRandomError"))).toBe(false);
  });
});

describe("identity", () => {
  /** Two errors with the same class and message are still two errors. */
  it("gives each error object its own number", () => {
    const a = new Error("same");
    const b = new Error("same");

    expect(exceptionId(a)).not.toBe(exceptionId(b));
  });

  it("gives the same error the same number twice", () => {
    const error = new Error("x");

    expect(exceptionId(error)).toBe(exceptionId(error));
  });

  it("gives the wrapper's error the same number", () => {
    const error = new Error("x");

    expect(new ExceptionWrapper(error, ROOT).exceptionId()).toBe(exceptionId(error));
  });

  it("prints an error the way a log would", () => {
    expect(exceptionInspect(errorWith("", "RecordNotFound", "no such post"))).toBe(
      "#<RecordNotFound: no such post>",
    );
  });

  it("prints just the class when there is no message", () => {
    expect(exceptionInspect(errorWith("", "RoutingError", ""))).toBe("RoutingError");
  });

  it("prints something for a thrown non-error", () => {
    expect(exceptionInspect("just a string")).toBe("just a string");
  });

  it("reports the message", () => {
    expect(new ExceptionWrapper(new Error("boom"), ROOT).message()).toBe("boom");
  });

  it("survives a thrown non-error entirely", () => {
    const wrapper = new ExceptionWrapper("a string", ROOT);

    expect(wrapper.exceptionClassName).toBe("Error");
    expect(wrapper.message()).toBe("a string");
    expect(wrapper.cleanBacktrace("full")).toEqual([]);
  });
});

describe("source fragments", () => {
  it("names the file and line a frame points at", () => {
    const frame = new ExceptionWrapper(errorWith(mixedStack()), ROOT).cleanBacktrace("full")[0];

    expect(extractFileAndLineNumber(frame as never)).toEqual({
      file: "/app/controllers/posts.ts",
      line: 12,
    });
  });

  /** Keyed by real line number, so nothing downstream has to add the offset back. */
  it("keys the lines by their real numbers", () => {
    const lines = ["one", "two", "three", "four", "five"];

    expect(extractSourceFragmentLines(lines, 3, 1)).toEqual({ 2: "two", 3: "three", 4: "four" });
  });

  it("does not run off the top of the file", () => {
    expect(extractSourceFragmentLines(["one", "two", "three"], 1, 3)).toEqual({
      1: "one",
      2: "two",
      3: "three",
    });
  });

  it("does not run off the bottom", () => {
    expect(extractSourceFragmentLines(["one", "two"], 2, 3)).toEqual({ 1: "one", 2: "two" });
  });

  it("reads a real file", async () => {
    const fragment = await sourceFragment(import.meta.path, 1, 1);

    expect(fragment?.[1]).toContain("/**");
  });

  /**
   * This runs when something has already gone wrong; losing the page because a
   * file moved trades a partly useful page for none.
   */
  it("gives nothing rather than throwing when the file is gone", async () => {
    expect(await sourceFragment("/nowhere/at/all.ts", 3)).toBeUndefined();
  });
});
