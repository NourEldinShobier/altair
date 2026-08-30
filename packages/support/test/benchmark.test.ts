/**
 * Timing helpers and the backtrace cleaner's frame accessors, ported from
 * `activesupport/test/benchmarkable_test.rb` and
 * `activesupport/test/clean_backtrace_test.rb`.
 */

import { describe, expect, it } from "bun:test";
import { benchmark, cpuTime, humanDuration, realtime, realtimeSync } from "../src/benchmark.js";
import { BacktraceCleaner } from "../src/backtrace_cleaner.js";

describe("realtime", () => {
  it("gives the result and a duration", async () => {
    const { duration, result } = await realtime(() => 42);

    expect(result).toBe(42);
    expect(duration).toBeGreaterThanOrEqual(0);
  });

  it("measures something that takes time", async () => {
    const { duration } = await realtime(
      async () => await new Promise((resolve) => setTimeout(resolve, 20)),
    );

    expect(duration).toBeGreaterThan(10);
  });

  /**
   * A monotonic clock, so a duration cannot come out negative when the wall
   * clock steps backwards for an NTP correction.
   */
  it("is never negative", async () => {
    const { duration } = await realtime(() => 1);

    expect(duration).toBeGreaterThanOrEqual(0);
  });

  it("has a synchronous form", () => {
    const { duration, result } = realtimeSync(() => "done");

    expect(result).toBe("done");
    expect(duration).toBeGreaterThanOrEqual(0);
  });

  it("lets an error through", async () => {
    await expect(
      realtime(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});

describe("cpuTime", () => {
  it("gives the result and a duration", async () => {
    const { duration, result } = await cpuTime(() => 42);

    expect(result).toBe(42);
    expect(duration).toBeGreaterThanOrEqual(0);
  });

  /**
   * The distinction that matters for a slow endpoint: elapsed time counts
   * waiting, CPU time does not.
   */
  it("counts far less than elapsed time for a block that only waits", async () => {
    const waiting = async () => await new Promise((resolve) => setTimeout(resolve, 50));

    const { duration: elapsed } = await realtime(waiting);
    const { duration: cpu } = await cpuTime(waiting);

    expect(elapsed).toBeGreaterThan(40);
    expect(cpu).toBeLessThan(elapsed);
  });
});

describe("benchmark", () => {
  it("returns what the block returned", async () => {
    expect(
      await benchmark(
        "work",
        () => {},
        () => 42,
      ),
    ).toBe(42);
  });

  /** After, not before, so the duration is in the line. */
  it("logs once, with the duration", async () => {
    const lines: string[] = [];
    await benchmark(
      "Reindexing",
      (line) => lines.push(line),
      () => 1,
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Reindexing");
    expect(lines[0]).toMatch(/\d+\.\dms/);
  });

  /** Often the most interesting timing of all. */
  it("still logs when the block throws", async () => {
    const lines: string[] = [];

    await expect(
      benchmark(
        "Reindexing",
        (line) => lines.push(line),
        () => {
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");

    expect(lines).toHaveLength(1);
  });
});

describe("humanDuration", () => {
  it("writes microseconds", () => {
    expect(humanDuration(0.4)).toBe("400µs");
  });

  it("writes milliseconds", () => {
    expect(humanDuration(12.34)).toBe("12.3ms");
  });

  it("writes seconds", () => {
    expect(humanDuration(1500)).toBe("1.50s");
  });

  it("writes minutes and seconds", () => {
    expect(humanDuration(90_000)).toBe("1m30s");
  });
});

describe("the cleaner's frame accessors", () => {
  const trace = [
    "    at internal (node:internal/process:1:1)",
    "    at handle (/app/node_modules/framework/index.js:10:5)",
    "    at show (/app/app/controllers/posts.ts:42:9)",
    "    at run (/app/app/models/post.ts:7:3)",
  ];

  function cleaner(): BacktraceCleaner {
    const one = new BacktraceCleaner();
    one.addSilencer((line) => line.includes("node_modules"));
    one.addSilencer((line) => line.includes("node:internal"));
    return one;
  }

  /** The single most useful line: where it came from, not what it passed through. */
  it("finds the first application frame", () => {
    expect(cleaner().firstCleanFrame(trace)).toContain("app/controllers/posts.ts");
  });

  it("gives its location without the at prefix", () => {
    expect(cleaner().firstCleanLocation(trace)).toBe("/app/app/controllers/posts.ts:42:9");
  });

  it("gives every surviving location", () => {
    expect(cleaner().cleanLocations(trace)).toEqual([
      "/app/app/controllers/posts.ts:42:9",
      "/app/app/models/post.ts:7:3",
    ]);
  });

  it("cleans a single frame", () => {
    expect(cleaner().cleanFrame("    at show (/app/app/controllers/posts.ts:42:9)")).toContain(
      "posts.ts",
    );
  });

  it("gives undefined for a frame that is silenced", () => {
    expect(
      cleaner().cleanFrame("    at handle (/app/node_modules/framework/index.js:10:5)"),
    ).toBeUndefined();
  });

  /** A frame with no function name is what a top-level statement produces. */
  it("reads a location off a frame with no function name", () => {
    expect(cleaner().cleanLocations(["    at /app/app/boot.ts:3:1"])).toEqual([
      "/app/app/boot.ts:3:1",
    ]);
  });

  it("copes with nothing", () => {
    expect(cleaner().cleanLocations(undefined)).toEqual([]);
    expect(cleaner().firstCleanFrame(undefined)).toBeUndefined();
    expect(cleaner().firstCleanLocation(undefined)).toBeUndefined();
  });
});
