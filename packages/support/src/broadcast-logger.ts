/**
 * One logger writing to several, ported from
 * `ActiveSupport::BroadcastLogger`.
 *
 *     const logger = new BroadcastLogger(fileLogger)
 *     logger.broadcastTo(stdoutLogger)
 *
 * The case it exists for is a deployment that needs the same line in two
 * places at once — a file for retention and stdout for the log collector, or
 * production output plus a local tail while debugging. Without it the choice
 * is one destination, or every caller holding two loggers and remembering to
 * write to both, which is the arrangement where one of them quietly stops
 * getting anything.
 *
 * Each destination keeps its own level. That is the point rather than a
 * detail: the file can take everything while stdout takes warnings and above,
 * so the noisy destination is the cheap one to read.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { Level, Logger } from "./logger.js";

/**
 * A level in force for the current scope only.
 *
 * Rails' `local_level`, and the reason it is scoped rather than assigned: the
 * use is turning on debug for one request in a running process, and a level
 * set globally would turn it on for every request the process is handling
 * concurrently — which on a busy server is a flood, from a switch somebody
 * flipped to investigate one thing.
 */
const localLevels = new AsyncLocalStorage<Level>();

export function localLevel(): Level | undefined {
  return localLevels.getStore();
}

/** Runs the block at a level of its own. */
export async function withLocalLevel<T>(level: Level, body: () => T | Promise<T>): Promise<T> {
  return await localLevels.run(level, body);
}

export class BroadcastLogger {
  #loggers: Logger[];

  constructor(...loggers: Logger[]) {
    this.#loggers = loggers;
  }

  /** Adds a destination. Rails' `broadcast_to`. */
  broadcastTo(...loggers: Logger[]): this {
    this.#loggers.push(...loggers);

    return this;
  }

  /**
   * Removes one. Rails' `stop_broadcasting_to`.
   *
   * By identity rather than by index, so removing the local tail cannot take
   * the file logger with it when the order has changed since it was added.
   */
  stopBroadcastingTo(logger: Logger): this {
    this.#loggers = this.#loggers.filter((one) => one !== logger);

    return this;
  }

  /** Every destination, in the order they receive. */
  get broadcasts(): Logger[] {
    return [...this.#loggers];
  }

  /**
   * Writes to each destination, letting each apply its own level.
   *
   * The level is not checked here on purpose. Checking centrally would mean
   * the strictest destination silences the others, and the whole reason to
   * have several is that they want different amounts.
   */
  log(level: Level, message: string, payload: Record<string, unknown> = {}): void {
    const scoped = localLevels.getStore();

    for (const logger of this.#loggers) {
      if (scoped) {
        const previous = logger.level;
        logger.level = scoped;

        try {
          logger.log(level, message, payload);
        } finally {
          // Restored even if a sink throws, or one broken destination leaves
          // every other logger stuck at a level nobody chose.
          logger.level = previous;
        }

        continue;
      }

      logger.log(level, message, payload);
    }
  }

  debug(message: string, payload?: Record<string, unknown>): void {
    this.log("debug", message, payload);
  }

  info(message: string, payload?: Record<string, unknown>): void {
    this.log("info", message, payload);
  }

  warn(message: string, payload?: Record<string, unknown>): void {
    this.log("warn", message, payload);
  }

  error(message: string, payload?: Record<string, unknown>): void {
    this.log("error", message, payload);
  }

  fatal(message: string, payload?: Record<string, unknown>): void {
    this.log("fatal", message, payload);
  }

  /**
   * Tags every destination for the block. Rails' `tagged`.
   *
   * Applied to each rather than to the broadcaster, because the tags belong in
   * the output and each destination formats its own.
   */
  async tagged<T>(tags: Record<string, unknown>, body: () => T | Promise<T>): Promise<T> {
    const run = async (remaining: Logger[]): Promise<T> => {
      const [next, ...rest] = remaining;

      if (!next) return await body();

      return await next.tagged(tags, async () => await run(rest));
    };

    return await run(this.#loggers);
  }

  /**
   * Silences every destination for the block.
   *
   * Argument order follows Logger's own — body first, level second — so the
   * two read the same way at a call site rather than one being a transposition
   * of the other.
   */
  async silence<T>(body: () => T | Promise<T>, level: Level = "error"): Promise<T> {
    const run = async (remaining: Logger[]): Promise<T> => {
      const [next, ...rest] = remaining;

      if (!next) return await body();

      return await next.silence(async () => await run(rest), level);
    };

    return await run(this.#loggers);
  }
}
