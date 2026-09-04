/**
 * Asserting on what was logged, ported from
 * `ActiveSupport::LogSubscriber::TestHelper` and its `MockLogger#logged`.
 *
 *     const log = collectingLogger()
 *
 *     await withComponentLogger("orm", log, async () => {
 *       await Post.all().toArray()
 *     })
 *
 *     expect(log.logged("debug")).toHaveLength(1)
 *     expect(log.logged("debug")[0]).toMatch(/SELECT/)
 *
 * A log line is behaviour: "this action warned about a slow query" and "this
 * job logged nothing on success" are things worth holding, and there was no
 * way to hold them. Building a collector by hand each time is a `sink` and an
 * array — small enough that everybody writes their own and nobody writes the
 * part that puts the old logger back.
 *
 * Nothing reaches the console. A test that asserts on a log line should not
 * also print it, or a suite of them is unreadable and a failure is buried in
 * output the tests themselves produced.
 */

import { componentLogger, Logger, setComponentLogger, type Level } from "@altair/support";

/** A logger that keeps what it was told and prints none of it. */
export interface CollectingLogger extends Logger {
  /** The lines logged at one level, in order. Rails' `logged(level)`. */
  logged(level: Level): string[];
  /** Every line, whatever its level. */
  lines(): string[];
  /** Forgets them, for a test that asserts twice in one block. */
  clear(): void;
}

export function collectingLogger(options: { level?: Level } = {}): CollectingLogger {
  const kept: { level: Level; line: string }[] = [];

  const logger = new Logger({
    // Everything by default: a collector that dropped debug lines would make
    // "nothing was logged" true for the wrong reason.
    level: options.level ?? "debug",
    sink: (line, entry) => {
      kept.push({ level: entry.level, line });
    },
  }) as CollectingLogger;

  logger.logged = (level) => kept.filter((one) => one.level === level).map((one) => one.line);
  logger.lines = () => kept.map((one) => one.line);
  logger.clear = () => {
    kept.length = 0;
  };

  return logger;
}

/**
 * Runs a block with one component logging somewhere a test can read.
 *
 * Put back afterwards, and put back when the body throws, because a logger
 * left installed makes every later test in the file assert against lines this
 * one produced.
 */
export async function withComponentLogger<T>(
  component: string,
  logger: Logger,
  body: () => T | Promise<T>,
): Promise<T> {
  const before = componentLogger(component);

  setComponentLogger(component, logger);

  try {
    return await body();
  } finally {
    setComponentLogger(component, before);
  }
}
