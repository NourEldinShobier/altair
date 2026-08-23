/**
 * Logging and error reporting.
 *
 * Mirrors activesupport/test/{logger_test,tagged_logging_test,
 * error_reporter_test}.rb. Lines are collected into an array rather than
 * printed, which is also what makes the concurrency tests possible.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  errors,
  ErrorReporter,
  jsonFormatter,
  LEVELS,
  Logger,
  textFormatter,
  type LogEntry,
} from "../src/index.js";

function collector() {
  const lines: string[] = [];
  const entries: LogEntry[] = [];

  const logger = new Logger({
    level: "debug",
    sink: (line, entry) => {
      lines.push(line);
      entries.push(entry);
    },
  });

  return { logger, lines, entries };
}

describe("levels", () => {
  it("writes at or above the level it is set to", () => {
    const { logger, lines } = collector();
    logger.level = "warn";

    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    logger.fatal("f");

    expect(lines).toHaveLength(3);
  });

  it("has one method per level", () => {
    const { logger, entries } = collector();
    for (const level of LEVELS) logger[level](level);

    expect(entries.map((entry) => entry.level)).toEqual([...LEVELS]);
  });

  it("says whether a line would be written", () => {
    const { logger } = collector();
    logger.level = "error";

    expect(logger.enabled("warn")).toBe(false);
    expect(logger.enabled("fatal")).toBe(true);
  });

  // What a bulk import reaches for when the query log would be a hundred
  // thousand lines nobody will read.
  it("can be silenced for a block", async () => {
    const { logger, lines } = collector();

    await logger.silence(async () => {
      logger.info("quiet");
      logger.error("loud");
    });

    logger.info("after");

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("loud");
    expect(lines[1]).toContain("after");
  });

  it("puts the level back even when the block throws", async () => {
    const { logger, lines } = collector();

    await logger
      .silence(async () => {
        throw new Error("nope");
      })
      .catch(() => undefined);

    logger.info("after");
    expect(lines).toHaveLength(1);
  });
});

describe("tags", () => {
  it("attaches them to every line inside the block", () => {
    const { logger, entries } = collector();

    logger.tagged({ requestId: "abc" }, () => logger.info("inside"));
    logger.info("outside");

    expect(entries[0]?.payload).toMatchObject({ requestId: "abc" });
    expect(entries[1]?.payload.requestId).toBeUndefined();
  });

  // A job inside a request keeps the request's id alongside its own.
  it("merges when nested", () => {
    const { logger, entries } = collector();

    logger.tagged({ requestId: "abc" }, () => {
      logger.tagged({ jobId: "42" }, () => logger.info("inside"));
    });

    expect(entries[0]?.payload).toMatchObject({ requestId: "abc", jobId: "42" });
  });

  it("lets the caller's own payload win", () => {
    const { logger, entries } = collector();
    logger.tagged({ a: 1 }, () => logger.info("x", { a: 2 }));

    expect(entries[0]?.payload.a).toBe(2);
  });

  // The whole reason tags live in an AsyncLocalStorage: a process interleaves
  // a hundred requests, and a line that does not say which one it belongs to
  // is nearly useless at 3am.
  it("does not leak between concurrent blocks", async () => {
    const { logger, entries } = collector();

    await Promise.all([
      logger.tagged({ requestId: "slow" }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        logger.info("slow done");
      }),
      logger.tagged({ requestId: "fast" }, async () => {
        logger.info("fast done");
      }),
    ]);

    const byMessage = new Map(entries.map((entry) => [entry.message, entry.payload.requestId]));

    expect(byMessage.get("slow done")).toBe("slow");
    expect(byMessage.get("fast done")).toBe("fast");
  });
});

describe("formatting", () => {
  const entry = (payload: Record<string, unknown> = {}): LogEntry => ({
    level: "info",
    message: "hello",
    time: new Date("2026-01-15T12:34:56.789Z"),
    payload,
  });

  it("writes one JSON object per line", () => {
    expect(JSON.parse(jsonFormatter(entry({ a: 1 })))).toEqual({
      time: "2026-01-15T12:34:56.789Z",
      level: "info",
      message: "hello",
      a: 1,
    });
  });

  it("writes text a person can scan", () => {
    expect(textFormatter(entry({ a: 1 }))).toBe("12:34:56.789 INFO  hello a=1");
  });

  it("quotes a value with spaces in it, so the pairs stay readable", () => {
    expect(textFormatter(entry({ path: "/a b" }))).toContain('path="/a b"');
  });

  it("keeps an error readable rather than empty", () => {
    expect(textFormatter(entry({ error: new Error("boom") }))).toContain("Error: boom");
  });

  it("does not lose a nested object", () => {
    expect(textFormatter(entry({ at: { line: 3 } }))).toContain('at={"line":3}');
  });
});

describe("reporting an error", () => {
  afterEach(() => {
    errors.reset();
  });

  it("hands it to every subscriber", () => {
    const seen: unknown[] = [];
    const reporter = new ErrorReporter();
    reporter.subscribe((error) => seen.push(error));
    reporter.subscribe((error) => seen.push(error));

    const boom = new Error("boom");
    reporter.report(boom);

    expect(seen).toEqual([boom, boom]);
  });

  it("stops when unsubscribed", () => {
    const seen: unknown[] = [];
    const reporter = new ErrorReporter();
    const subscription = reporter.subscribe((error) => seen.push(error));

    subscription.unsubscribe();
    reporter.report(new Error("boom"));

    expect(seen).toEqual([]);
  });

  // Reporting is what happens when something has already gone wrong; a broken
  // reporter must not replace the original error with its own.
  it("survives a subscriber whose own promise rejects", async () => {
    const reporter = new ErrorReporter();
    reporter.subscribe(async () => {
      throw new Error("the reporter is down");
    });

    reporter.report(new Error("boom"));
    // Long enough for a rejection to surface as an unhandled one if it were
    // going to. It would take the process down, not fail this assertion.
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(true).toBe(true);
  });

  it("survives a subscriber that throws", () => {
    const seen: unknown[] = [];
    const reporter = new ErrorReporter();

    reporter.subscribe(() => {
      throw new Error("the reporter is down");
    });
    reporter.subscribe((error) => seen.push(error));

    expect(() => reporter.report(new Error("boom"))).not.toThrow();
    expect(seen).toHaveLength(1);
  });

  it("carries context the caller attached", () => {
    const contexts: Record<string, unknown>[] = [];
    const reporter = new ErrorReporter();
    reporter.subscribe((_error, context) => contexts.push(context.context));

    reporter.report(new Error("boom"), { context: { userId: 7 } });

    expect(contexts[0]).toEqual({ userId: 7 });
  });

  it("carries ambient context too", () => {
    const contexts: Record<string, unknown>[] = [];
    const reporter = new ErrorReporter();
    reporter.subscribe((_error, context) => contexts.push(context.context));

    reporter.withContext({ requestId: "abc" }, () => {
      reporter.report(new Error("boom"), { context: { userId: 7 } });
    });

    expect(contexts[0]).toEqual({ requestId: "abc", userId: 7 });
  });
});

// The distinction is the whole design: one method that both swallows and
// reports is how an error ends up silently ignored by a caller who thought it
// was being raised.
describe("handle and record", () => {
  it("handle swallows and returns the fallback", async () => {
    const seen: unknown[] = [];
    const reporter = new ErrorReporter();
    reporter.subscribe((error) => seen.push(error));

    const rate = await reporter.handle(
      () => {
        throw new Error("the rates service is down");
      },
      { fallback: 1 },
    );

    expect(rate).toBe(1);
    expect(seen).toHaveLength(1);
  });

  it("handle returns the value when nothing goes wrong", async () => {
    const reporter = new ErrorReporter();
    expect(await reporter.handle(() => 2, { fallback: 1 })).toBe(2);
  });

  it("handle marks the error as handled", async () => {
    const reporter = new ErrorReporter();
    let handled: boolean | undefined;
    reporter.subscribe((_error, context) => (handled = context.handled));

    await reporter.handle(() => {
      throw new Error("boom");
    });

    expect(handled).toBe(true);
  });

  it("record reports and throws on", async () => {
    const reporter = new ErrorReporter();
    let handled: boolean | undefined;
    reporter.subscribe((_error, context) => (handled = context.handled));

    await expect(
      reporter.record(() => {
        throw new Error("the card was declined");
      }),
    ).rejects.toThrow("the card was declined");

    expect(handled).toBe(false);
  });

  it("record returns the value when nothing goes wrong", async () => {
    const reporter = new ErrorReporter();
    expect(await reporter.record(async () => "ok")).toBe("ok");
  });
});
