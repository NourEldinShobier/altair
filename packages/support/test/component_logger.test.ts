/**
 * A logger per component, ported from the `logger=` cases Rails exercises
 * through `activerecord/test/cases/log_subscriber_test.rb` and friends.
 *
 * There was one logger for everything, which makes the commonest thing anybody
 * wants impossible: quieten one component. An application drowning in query
 * lines wants the ORM at warn and its own code at debug, and with a single
 * logger the only choices are both or neither.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  componentLogger,
  configuredComponents,
  resetComponentLoggers,
  setComponentLogger,
  silenceComponent,
} from "../src/component_logger.js";
import { Logger, logger as shared } from "../src/logger.js";

afterEach(() => {
  resetComponentLoggers();
});

function collecting(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];

  return { logger: new Logger({ level: "debug", sink: (line) => lines.push(line) }), lines };
}

describe("componentLogger", () => {
  /**
   * The shared one rather than a copy: an application that configures the
   * shared logger expects every component to follow, and a copy taken at
   * import time leaves whichever loaded first writing somewhere else.
   */
  it("is the shared logger until something replaces it", () => {
    expect(componentLogger("orm")).toBe(shared);
  });

  it("is its own once one is set", () => {
    const { logger } = collecting();

    setComponentLogger("orm", logger);

    expect(componentLogger("orm")).toBe(logger);
  });

  it("leaves other components on the shared one", () => {
    const { logger } = collecting();

    setComponentLogger("orm", logger);

    expect(componentLogger("jobs")).toBe(shared);
  });

  it("writes through the one it was given", () => {
    const { logger, lines } = collecting();

    setComponentLogger("orm", logger);
    componentLogger("orm").info("a query");

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("a query");
  });

  /** What makes it usable from a test: unset it and nothing has to remember. */
  it("goes back to the shared one when unset", () => {
    const { logger } = collecting();

    setComponentLogger("orm", logger);
    setComponentLogger("orm", undefined);

    expect(componentLogger("orm")).toBe(shared);
    // Forgotten rather than set to nothing: a component holding an undefined
    // logger still reads as configured, which is what a diagnostic listing
    // them would report and what a reload would preserve.
    expect(configuredComponents()).toEqual([]);
  });

  it("lists what has been configured", () => {
    setComponentLogger("orm", collecting().logger);
    setComponentLogger("jobs", collecting().logger);

    expect(configuredComponents().sort()).toEqual(["jobs", "orm"]);
  });

  it("forgets everything when reset", () => {
    setComponentLogger("orm", collecting().logger);
    resetComponentLoggers();

    expect(configuredComponents()).toEqual([]);
  });
});

describe("the point of it", () => {
  /**
   * Two components at different levels, which is the thing a single logger
   * cannot do.
   */
  it("lets one component be quiet while another is loud", () => {
    const quiet = collecting();
    const loud = collecting();

    setComponentLogger(
      "orm",
      new Logger({ level: "error", sink: (line) => quiet.lines.push(line) }),
    );
    setComponentLogger("app", loud.logger);

    componentLogger("orm").info("a query");
    componentLogger("app").info("something worth reading");

    expect(quiet.lines).toEqual([]);
    expect(loud.lines).toHaveLength(1);
  });
});

describe("silenceComponent", () => {
  it("quietens it for the block", async () => {
    const { logger, lines } = collecting();

    setComponentLogger("jobs", logger);

    await silenceComponent("jobs", () => {
      componentLogger("jobs").error("expected failure");
    });

    expect(lines).toEqual([]);
  });

  /** Remembering to put the level back is exactly what nobody does. */
  it("puts back what was there", async () => {
    const { logger, lines } = collecting();

    setComponentLogger("jobs", logger);

    await silenceComponent("jobs", () => undefined);

    componentLogger("jobs").error("heard again");

    expect(lines).toHaveLength(1);
  });

  it("puts it back when the block throws", async () => {
    const { logger, lines } = collecting();

    setComponentLogger("jobs", logger);

    await silenceComponent("jobs", () => {
      throw new Error("boom");
    }).catch(() => undefined);

    componentLogger("jobs").error("heard again");

    expect(lines).toHaveLength(1);
  });

  it("leaves it unconfigured if it was", async () => {
    await silenceComponent("jobs", () => undefined);

    expect(configuredComponents()).toEqual([]);
    expect(componentLogger("jobs")).toBe(shared);
  });

  it("gives back what the block returned", async () => {
    expect(await silenceComponent("jobs", () => 42)).toBe(42);
  });

  it("lets the error through", async () => {
    expect(
      silenceComponent("jobs", () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});
