/**
 * Logging, ported from `ActiveSupport::Logger` and `TaggedLogging`.
 *
 * Rails' logger exists for one reason worth more than the levels: tags. A
 * process interleaves a hundred requests, so a line that does not say which
 * request it belongs to is nearly useless when something goes wrong at 3am.
 *
 *     logger.tagged({ requestId }, async () => {
 *       logger.info("started", { method, path })
 *     })
 *
 * Rails carries the tags on a thread-local stack; here they live in an
 * `AsyncLocalStorage`, so an `await` inside a request does not lose them and
 * two concurrent requests cannot pick up each other's.
 *
 * The default format is JSON outside development. A log line is read by a
 * machine far more often than by a person, and the machine reading `message=`
 * with `grep` is the reason production incidents take an hour instead of a
 * minute.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export const LEVELS = ["debug", "info", "warn", "error", "fatal"] as const;
export type Level = (typeof LEVELS)[number];

const SEVERITY: Record<Level, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
};

export interface LogEntry {
  level: Level;
  message: string;
  time: Date;
  /** Whatever the caller passed, plus the tags in effect. */
  payload: Record<string, unknown>;
}

export type Formatter = (entry: LogEntry) => string;

/** One JSON object per line: what every log aggregator reads without help. */
export const jsonFormatter: Formatter = (entry) =>
  JSON.stringify({
    time: entry.time.toISOString(),
    level: entry.level,
    message: entry.message,
    ...entry.payload,
  });

/** For a terminal a person is watching. */
export const textFormatter: Formatter = (entry) => {
  const time = entry.time.toISOString().slice(11, 23);
  const pairs = Object.entries(entry.payload)
    .map(([key, value]) => `${key}=${format(value)}`)
    .join(" ");

  return `${time} ${entry.level.toUpperCase().padEnd(5)} ${entry.message}${pairs ? ` ${pairs}` : ""}`;
};

function format(value: unknown): string {
  if (typeof value === "string") return /\s/.test(value) ? JSON.stringify(value) : value;
  if (value instanceof Error) return JSON.stringify(`${value.name}: ${value.message}`);
  if (value === null || value === undefined || typeof value !== "object") return String(value);

  return JSON.stringify(value);
}

/** Where lines go. A function, so a test can collect them into an array. */
export type Sink = (line: string, entry: LogEntry) => void;

export const consoleSink: Sink = (line, entry) => {
  // Errors to stderr, everything else to stdout: a process whose output is
  // piped somewhere should not have its failures swallowed by the pipe.
  if (SEVERITY[entry.level] >= SEVERITY.error) console.error(line);
  else console.log(line);
};

export interface LoggerOptions {
  level?: Level;
  formatter?: Formatter;
  sink?: Sink;
}

const tagStore = new AsyncLocalStorage<Record<string, unknown>>();

export class Logger {
  level: Level;
  formatter: Formatter;
  sink: Sink;

  #silenced: Level | undefined;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? "info";
    this.formatter = options.formatter ?? jsonFormatter;
    this.sink = options.sink ?? consoleSink;
  }

  /** The tags in effect right now. */
  get tags(): Record<string, unknown> {
    return tagStore.getStore() ?? {};
  }

  /**
   * Runs a block with tags attached to every line it logs.
   *
   * Nested calls merge rather than replace, so a job inside a request keeps
   * the request's id alongside its own.
   */
  tagged<T>(tags: Record<string, unknown>, body: () => T): T {
    return tagStore.run({ ...this.tags, ...tags }, body);
  }

  /** Whether a line at this level would be written. */
  enabled(level: Level): boolean {
    return SEVERITY[level] >= SEVERITY[this.#silenced ?? this.level];
  }

  /**
   * Raises the level for a block. Rails' `silence`.
   *
   * What a bulk import reaches for when the query log would be a hundred
   * thousand lines nobody will read.
   */
  async silence<T>(body: () => Promise<T>, level: Level = "error"): Promise<T> {
    const previous = this.#silenced;
    this.#silenced = level;

    try {
      return await body();
    } finally {
      this.#silenced = previous;
    }
  }

  log(level: Level, message: string, payload: Record<string, unknown> = {}): void {
    if (!this.enabled(level)) return;

    const entry: LogEntry = {
      level,
      message,
      time: new Date(),
      payload: { ...this.tags, ...payload },
    };

    this.sink(this.formatter(entry), entry);
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
}

/** The one the framework writes to. Rails' `Rails.logger`. */
export const logger = new Logger();
