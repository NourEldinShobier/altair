/**
 * Asserting on what was logged, ported from
 * `ActiveSupport::LogSubscriber::TestHelper` and its `MockLogger#logged` in
 * `activesupport/lib/active_support/log_subscriber/test_helper.rb`.
 *
 * A log line is behaviour. "This action warned about a slow query" and "this
 * job logged nothing on success" are worth holding, and there was no way to
 * hold them: building a collector by hand is a `sink` and an array, small
 * enough that everybody writes their own and nobody writes the part that puts
 * the old logger back.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { componentLogger, Logger, resetComponentLoggers } from "@altair/support";
import { collectingLogger, withComponentLogger } from "../src/log-assertions.js";

afterEach(() => {
  resetComponentLoggers();
});

describe("collecting", () => {
  it("keeps what it was told, by level", () => {
    const log = collectingLogger();

    log.info("started");
    log.warn("slow");
    log.info("finished");

    expect(log.logged("info")).toHaveLength(2);
    expect(log.logged("warn")).toHaveLength(1);
  });

  it("keeps them in order", () => {
    const log = collectingLogger();

    log.info("first");
    log.info("second");

    expect(log.logged("info")[0]).toContain("first");
    expect(log.logged("info")[1]).toContain("second");
  });

  it("gives every line whatever the level", () => {
    const log = collectingLogger();

    log.debug("a");
    log.error("b");

    expect(log.lines()).toHaveLength(2);
  });

  it("says nothing was logged at a level nothing used", () => {
    const log = collectingLogger();

    log.info("started");

    expect(log.logged("error")).toEqual([]);
  });

  /**
   * Everything by default. A collector that dropped debug lines would make
   * "nothing was logged" true for the wrong reason.
   */
  it("keeps debug lines, which a default logger would drop", () => {
    const log = collectingLogger();

    log.debug("a query");

    expect(log.logged("debug")).toHaveLength(1);
  });

  it("takes a level when a test wants one", () => {
    const log = collectingLogger({ level: "warn" });

    log.debug("dropped");
    log.warn("kept");

    expect(log.lines()).toHaveLength(1);
  });

  it("forgets on request, for a test that asserts twice", () => {
    const log = collectingLogger();

    log.info("first");
    log.clear();
    log.info("second");

    expect(log.logged("info")).toHaveLength(1);
    expect(log.logged("info")[0]).toContain("second");
  });

  /**
   * Nothing reaches the console. A test that asserts on a log line should not
   * also print it, or a suite of them is unreadable and a failure is buried
   * in output the tests produced.
   */
  it("prints nothing", () => {
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);

    (process.stdout as unknown as { write: unknown }).write = (chunk: string) => {
      written.push(String(chunk));

      return true;
    };

    try {
      collectingLogger().info("quiet");
    } finally {
      (process.stdout as unknown as { write: unknown }).write = original;
    }

    expect(written).toEqual([]);
  });
});

describe("installing one for a component", () => {
  it("is what that component logs to inside the block", async () => {
    const log = collectingLogger();

    await withComponentLogger("orm", log, () => {
      componentLogger("orm").info("a query");
    });

    expect(log.logged("info")).toHaveLength(1);
  });

  it("puts the old one back afterwards", async () => {
    const before = componentLogger("orm");

    await withComponentLogger("orm", collectingLogger(), () => undefined);

    expect(componentLogger("orm")).toBe(before);
  });

  /**
   * A logger left installed makes every later test in the file assert against
   * lines this one produced.
   */
  it("puts it back when the body throws", async () => {
    const before = componentLogger("orm");

    await expect(
      withComponentLogger("orm", collectingLogger(), () => {
        throw new Error("from the body");
      }),
    ).rejects.toThrow("from the body");

    expect(componentLogger("orm")).toBe(before);
  });

  it("leaves another component alone", async () => {
    const log = collectingLogger();
    // The other component gets a collector too, so this test asserts on
    // isolation rather than printing a line into the suite's output.
    const elsewhere = collectingLogger();

    await withComponentLogger("controller", elsewhere, async () => {
      await withComponentLogger("orm", log, () => {
        componentLogger("controller").info("elsewhere");
      });
    });

    expect(log.lines()).toEqual([]);
    expect(elsewhere.lines()).toHaveLength(1);
  });

  it("restores one that was set rather than the shared default", async () => {
    const mine = new Logger({ sink: () => undefined });

    await withComponentLogger("orm", mine, async () => {
      await withComponentLogger("orm", collectingLogger(), () => undefined);

      expect(componentLogger("orm")).toBe(mine);
    });
  });

  it("hands back the body's value", async () => {
    expect(await withComponentLogger("orm", collectingLogger(), () => "done")).toBe("done");
  });
});
