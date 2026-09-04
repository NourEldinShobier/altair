/**
 * Broadcasting to several loggers, ported from
 * `activesupport/test/broadcast_logger_test.rb`.
 */

import { describe, expect, it } from "bun:test";
import { Logger, type Level, type LogEntry } from "../src/logger.js";
import { BroadcastLogger, localLevel, withLocalLevel } from "../src/broadcast-logger.js";

/** A logger that keeps what it was given instead of printing it. */
function collecting(level: Level = "debug") {
  const lines: LogEntry[] = [];
  const logger = new Logger({
    level,
    sink: (_formatted, entry) => {
      lines.push(entry);
    },
  });

  return { logger, lines };
}

describe("broadcasting", () => {
  it("writes to every destination", () => {
    const first = collecting();
    const second = collecting();
    const broadcast = new BroadcastLogger(first.logger, second.logger);

    broadcast.info("hello");

    expect(first.lines).toHaveLength(1);
    expect(second.lines).toHaveLength(1);
    expect(first.lines[0]?.message).toBe("hello");
  });

  it("takes a destination added later", () => {
    const first = collecting();
    const second = collecting();
    const broadcast = new BroadcastLogger(first.logger);

    broadcast.broadcastTo(second.logger);
    broadcast.info("hello");

    expect(second.lines).toHaveLength(1);
  });

  /** By identity, so removing one cannot take another with it. */
  it("stops writing to one that was removed", () => {
    const first = collecting();
    const second = collecting();
    const broadcast = new BroadcastLogger(first.logger, second.logger);

    broadcast.stopBroadcastingTo(second.logger);
    broadcast.info("hello");

    expect(first.lines).toHaveLength(1);
    expect(second.lines).toHaveLength(0);
  });

  it("lists its destinations in order", () => {
    const first = collecting();
    const second = collecting();
    const broadcast = new BroadcastLogger(first.logger, second.logger);

    expect(broadcast.broadcasts).toEqual([first.logger, second.logger]);
  });

  it("writes nowhere when it has no destinations", () => {
    expect(() => new BroadcastLogger().info("hello")).not.toThrow();
  });

  it("carries the payload through", () => {
    const first = collecting();
    new BroadcastLogger(first.logger).warn("careful", { id: 7 });

    expect(first.lines[0]?.payload).toMatchObject({ id: 7 });
  });

  it("has a method per level", () => {
    const first = collecting();
    const broadcast = new BroadcastLogger(first.logger);

    broadcast.debug("a");
    broadcast.info("b");
    broadcast.warn("c");
    broadcast.error("d");
    broadcast.fatal("e");

    expect(first.lines.map((one) => one.level)).toEqual([
      "debug",
      "info",
      "warn",
      "error",
      "fatal",
    ]);
  });
});

describe("each destination keeps its own level", () => {
  /**
   * The whole reason to have several: the file takes everything while stdout
   * takes warnings and above, so the noisy one is the cheap one to read.
   */
  it("lets a strict destination drop what a lenient one keeps", () => {
    const verbose = collecting("debug");
    const strict = collecting("warn");
    const broadcast = new BroadcastLogger(verbose.logger, strict.logger);

    broadcast.debug("noise");
    broadcast.error("trouble");

    expect(verbose.lines.map((one) => one.message)).toEqual(["noise", "trouble"]);
    expect(strict.lines.map((one) => one.message)).toEqual(["trouble"]);
  });
});

describe("localLevel", () => {
  it("is unset outside a block", () => {
    expect(localLevel()).toBeUndefined();
  });

  it("is set inside one", async () => {
    await withLocalLevel("debug", () => {
      expect(localLevel()).toBe("debug");
    });
  });

  /**
   * Scoped rather than assigned: a level set globally would turn debug on for
   * every request the process is handling at once.
   */
  it("does not leak outside the block", async () => {
    await withLocalLevel("debug", () => undefined);

    expect(localLevel()).toBeUndefined();
  });

  it("lowers a strict destination for the block only", async () => {
    const strict = collecting("error");
    const broadcast = new BroadcastLogger(strict.logger);

    broadcast.debug("dropped");

    await withLocalLevel("debug", () => {
      broadcast.debug("kept");
    });

    broadcast.debug("dropped again");

    expect(strict.lines.map((one) => one.message)).toEqual(["kept"]);
  });

  it("puts the destination's level back afterwards", async () => {
    const strict = collecting("error");
    const broadcast = new BroadcastLogger(strict.logger);

    await withLocalLevel("debug", () => {
      broadcast.debug("kept");
    });

    expect(strict.logger.level).toBe("error");
  });

  /** Or one broken destination leaves every other stuck at a level nobody chose. */
  it("puts it back even when a sink throws", async () => {
    const logger = new Logger({
      level: "error",
      sink: () => {
        throw new Error("sink is broken");
      },
    });
    const broadcast = new BroadcastLogger(logger);

    await withLocalLevel("debug", () => {
      expect(() => broadcast.debug("boom")).toThrow("sink is broken");
    });

    expect(logger.level).toBe("error");
  });

  it("returns what the block returned", async () => {
    expect(await withLocalLevel("debug", () => 42)).toBe(42);
  });
});

describe("tagged and silence", () => {
  it("tags every destination", async () => {
    const first = collecting();
    const second = collecting();
    const broadcast = new BroadcastLogger(first.logger, second.logger);

    await broadcast.tagged({ requestId: "abc" }, () => {
      broadcast.info("hello");
    });

    expect(first.lines[0]?.payload).toMatchObject({ requestId: "abc" });
    expect(second.lines[0]?.payload).toMatchObject({ requestId: "abc" });
  });

  it("drops the tags after the block", async () => {
    const first = collecting();
    const broadcast = new BroadcastLogger(first.logger);

    await broadcast.tagged({ requestId: "abc" }, () => undefined);
    broadcast.info("after");

    expect(first.lines[0]?.payload).not.toMatchObject({ requestId: "abc" });
  });

  it("silences every destination for the block", async () => {
    const first = collecting();
    const broadcast = new BroadcastLogger(first.logger);

    await broadcast.silence(() => {
      broadcast.info("quiet");
    });

    expect(first.lines).toHaveLength(0);
  });

  it("returns what the block returned", async () => {
    expect(await new BroadcastLogger().silence(() => 42)).toBe(42);
  });
});
