/**
 * Colour and silence bracketing on the logger, ported from
 * `activesupport/test/logger_test.rb` and the
 * `ActiveSupport::LogSubscriber` colour cases.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  LEVEL_COLOURS,
  Logger,
  colorize,
  colorizeLogging,
  colourFormatter,
  textFormatter,
  type LogEntry,
} from "../src/logger.js";

const before = { NO_COLOR: process.env.NO_COLOR, FORCE_COLOR: process.env.FORCE_COLOR };

afterEach(() => {
  for (const [name, value] of Object.entries(before)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function entry(level: LogEntry["level"] = "info", message = "hello"): LogEntry {
  return { level, message, time: new Date("2026-01-01T12:00:00Z"), payload: {} };
}

describe("colorize", () => {
  it("wraps text in the colour", () => {
    expect(colorize("x", LEVEL_COLOURS.error)).toContain("x");
    expect(colorize("x", LEVEL_COLOURS.error).startsWith(LEVEL_COLOURS.error)).toBe(true);
  });

  /**
   * A line that ends mid-escape leaves the terminal coloured for everything
   * after it — which is what makes a crashed process turn the rest of
   * somebody's shell green.
   */
  it("always resets at the end", () => {
    expect(colorize("x", LEVEL_COLOURS.error).endsWith("[0m")).toBe(true);
  });

  it("gives each level its own colour", () => {
    const colours = Object.values(LEVEL_COLOURS);

    expect(new Set(colours).size).toBe(colours.length);
  });
});

describe("colorizeLogging", () => {
  it("is on for a terminal", () => {
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;

    expect(colorizeLogging({ isTTY: true })).toBe(true);
  });

  /**
   * The check that matters: a log piped to a file or shipped to a collector
   * with escape codes in it is a log every grep has to strip first, and most
   * do not.
   */
  it("is off for anything else", () => {
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;

    expect(colorizeLogging({ isTTY: false })).toBe(false);
    expect(colorizeLogging({})).toBe(false);
  });

  it("honours NO_COLOR even on a terminal", () => {
    delete process.env.FORCE_COLOR;
    process.env.NO_COLOR = "1";

    expect(colorizeLogging({ isTTY: true })).toBe(false);
  });

  /** A CI terminal often is one and does not say so. */
  it("honours FORCE_COLOR off a terminal", () => {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "1";

    expect(colorizeLogging({ isTTY: false })).toBe(true);
  });

  it("lets NO_COLOR win over FORCE_COLOR", () => {
    process.env.NO_COLOR = "1";
    process.env.FORCE_COLOR = "1";

    expect(colorizeLogging({ isTTY: true })).toBe(false);
  });

  it("ignores an empty NO_COLOR, which is how a shell unsets one", () => {
    delete process.env.FORCE_COLOR;
    process.env.NO_COLOR = "";

    expect(colorizeLogging({ isTTY: true })).toBe(true);
  });
});

describe("colourFormatter", () => {
  it("colours the level when colour is wanted", () => {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "1";

    expect(colourFormatter()(entry("error"))).toContain(LEVEL_COLOURS.error);
  });

  it("leaves the line alone when it is not", () => {
    delete process.env.FORCE_COLOR;
    process.env.NO_COLOR = "1";

    const line = colourFormatter()(entry("error"));

    expect(line).toBe(textFormatter(entry("error")));
    expect(line).not.toContain("");
  });

  /** A coloured message is harder to read; the level is what somebody scans for. */
  it("colours only the level, not the message", () => {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "1";

    const line = colourFormatter()(entry("error", "something happened"));

    expect(line).toContain(`something happened`);
    expect(line.indexOf("[0m")).toBeLessThan(line.indexOf("something happened"));
  });

  it("wraps whatever formatter it was given", () => {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "1";

    const line = colourFormatter(() => "INFO  custom")(entry("info"));

    expect(line).toContain("custom");
  });
});

describe("silence bracketing", () => {
  function collecting(): { logger: Logger; lines: string[] } {
    const lines: string[] = [];
    const logger = new Logger({ level: "debug", sink: (line) => lines.push(line) });

    return { logger, lines };
  }

  it("quietens everything below the floor", () => {
    const { logger, lines } = collecting();

    logger.beginSilence("error");
    logger.info("quiet");
    logger.error("loud");

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("loud");
  });

  it("puts the level back", () => {
    const { logger, lines } = collecting();

    logger.beginSilence("error");
    logger.endSilence();
    logger.info("heard");

    expect(lines).toHaveLength(1);
  });

  it("defaults to silencing everything under error", () => {
    const { logger, lines } = collecting();

    logger.beginSilence();
    logger.warn("quiet");

    expect(lines).toHaveLength(0);
  });

  it("is quiet about ending a silence that never began", () => {
    const { logger, lines } = collecting();

    logger.endSilence();
    logger.info("heard");

    expect(lines).toHaveLength(1);
  });
});

describe("debugMode", () => {
  it("is true when debug lines are written", () => {
    expect(new Logger({ level: "debug" }).debugMode()).toBe(true);
  });

  it("is false when they are not", () => {
    expect(new Logger({ level: "info" }).debugMode()).toBe(false);
  });

  it("follows a silence", () => {
    const logger = new Logger({ level: "debug" });

    logger.beginSilence("error");

    expect(logger.debugMode()).toBe(false);
  });
});

describe("currentTags", () => {
  it("gives what tagged put in scope", async () => {
    const logger = new Logger({ sink: () => undefined });

    await logger.tagged({ requestId: "abc" }, async () => {
      expect(logger.currentTags()).toEqual({ requestId: "abc" });
    });
  });

  it("is empty outside a tagged scope", () => {
    expect(new Logger({ sink: () => undefined }).currentTags()).toEqual({});
  });
});
