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

/**
 * The colours a level is written in. Rails' `SEVERITY_TO_COLOR_MAP`.
 *
 * Written as SGR codes rather than through a colour library, because there is
 * nothing here a dependency would do better and a log formatter is exactly the
 * place a dependency's own output would be hardest to trace.
 */
export const LEVEL_COLOURS: Record<Level, string> = {
  debug: "[36m",
  info: "[32m",
  warn: "[33m",
  error: "[31m",
  fatal: "[35m",
};

const RESET = "[0m";

/**
 * The SGR codes for the ways text can be set apart other than by colour.
 * Rails' `ColorizeLogging::MODES`.
 */
export const SGR_MODES = {
  bold: 1,
  italic: 3,
  underline: 4,
} as const;

export type SgrMode = keyof typeof SGR_MODES;

/**
 * One escape sequence for a set of modes. Rails' `mode_from`.
 *
 * One sequence rather than one per mode, because a single `[0m` is what
 * reverses it — emitting `[1m[4m` needs the reader to know that
 * one reset undoes both, and a line built by concatenating them is one edit
 * away from resetting in the middle.
 *
 * The modes come out in a fixed order rather than whatever order the object
 * happened to have, so the same request always produces the same bytes. A
 * formatter whose output varies by key order is one no test can compare and
 * no log can be diffed.
 *
 * Nothing at all when no mode is asked for: an empty `[m` is a sequence
 * that means "reset", so emitting it for "no modes" would clear the colour
 * that follows it.
 */
export function modeFrom(options: Partial<Record<SgrMode, boolean>> = {}): string {
  const codes = (Object.keys(SGR_MODES) as SgrMode[])
    .filter((mode) => options[mode] === true)
    .map((mode) => SGR_MODES[mode]);

  return codes.length === 0 ? "" : `[${codes.join(";")}m`;
}

/**
 * Wraps text in a colour. Rails' `colorize`.
 *
 * The reset is unconditional and comes last, so a line that ends mid-escape
 * cannot leave the terminal coloured for everything after it — which is what
 * makes a crashed process turn the rest of somebody's shell green.
 *
 * Modes go before the colour, because the reset that ends the run clears
 * both and there is no way to end one without the other.
 */
export function colorize(
  text: string,
  colour: string,
  modes: Partial<Record<SgrMode, boolean>> = {},
): string {
  return `${modeFrom(modes)}${colour}${text}${RESET}`;
}

/**
 * Whether output should carry colour. Rails' `colorize_logging`.
 *
 * Off when the stream is not a terminal, which is the check that matters: a
 * log piped to a file or shipped to a collector with escape codes in it is a
 * log every grep has to strip first, and most do not. `NO_COLOR` is honoured
 * because it is the convention, and `FORCE_COLOR` because a CI terminal often
 * is one and does not say so.
 */
export function colorizeLogging(stream: { isTTY?: boolean } = process.stdout): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== "") return true;

  return stream.isTTY === true;
}

/**
 * The text formatter with the level coloured, when colour is wanted.
 *
 * Only the level, not the whole line: a coloured message is harder to read
 * than a plain one, and the thing somebody scans a log for is the level.
 */
export function colourFormatter(inner: Formatter = textFormatter): Formatter {
  return (entry) => {
    const line = inner(entry);

    if (!colorizeLogging()) return line;

    const level = entry.level.toUpperCase().padEnd(5);

    // Replaced rather than rebuilt, so this wraps whatever formatter it was
    // given instead of duplicating its layout — and a formatter that changes
    // does not leave this one behind.
    return line.replace(level, colorize(level, LEVEL_COLOURS[entry.level]));
  };
}

/** Where lines go. A function, so a test can collect them into an array. */
export type Sink = (line: string, entry: LogEntry) => void;

export const consoleSink: Sink = (line, entry) => {
  // Written to the stream rather than through `console`. Bun wraps
  // `console.error` output in its own red escape, which lands in front of ours
  // and repaints the timestamp — found by piping a real application's output
  // through `od`. Writing the line as given also skips the inspect machinery
  // `console` runs on every argument.
  //
  // Errors to stderr, everything else to stdout: a process whose output is
  // piped somewhere should not have its failures swallowed by the pipe.
  const stream = SEVERITY[entry.level] >= SEVERITY.error ? process.stderr : process.stdout;
  stream.write(`${line}
`);
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
  /**
   * Adds tags for the rest of the current scope. Rails' `push_tags`.
   *
   * `tagged` is the one to reach for: it takes them away again at the end of
   * the block, and a pushed tag that nobody pops is a tag on every line for
   * the rest of the request. This is for the case a block cannot express —
   * a tag learned halfway through, after the work has started.
   */
  /** The tags in effect, under Rails' name for it. */
  currentTags(): Record<string, unknown> {
    return this.tags;
  }

  /** Whether debug lines are being written. Rails' `debug_mode?`. */
  debugMode(): boolean {
    return this.enabled("debug");
  }

  /**
   * Raises the floor for everything after it. Rails' `begin_silence`.
   *
   * `silence(body)` is the one to reach for, since it puts the level back at
   * the end of the block. This pair is for a caller whose quiet stretch does
   * not fit inside one — a stream opened here and closed by a callback — and
   * it is worth saying that an unmatched `beginSilence` is a logger that stays
   * quiet for the rest of the process.
   */
  beginSilence(level: Level = "error"): void {
    this.#silenced = level;
  }

  /** Puts the level back. Rails' `end_silence`. */
  endSilence(): void {
    this.#silenced = undefined;
  }

  pushTags(tags: Record<string, unknown>): void {
    const store = tagStore.getStore();

    if (!store) {
      throw new Error(
        "There is no logging scope to push tags onto. Use `tagged({ ... }, body)`, which makes one.",
      );
    }

    Object.assign(store, tags);
  }

  /** Takes named tags away again. Rails' `pop_tags`. */
  popTags(...names: string[]): void {
    const store = tagStore.getStore();
    if (!store) return;

    for (const name of names) delete store[name];
  }

  /** Takes all of them away. Rails' `clear_tags!`. */
  clearTags(): void {
    const store = tagStore.getStore();
    if (!store) return;

    for (const name of Object.keys(store)) delete store[name];
  }

  /** The tags as they would appear on a line, for a format that writes text. */
  tagsText(): string {
    return Object.entries(this.tags)
      .map(([name, value]) => `[${name}=${String(value)}]`)
      .join("");
  }

  /**
   * Runs a block at a named level. Rails' `log_at`.
   *
   * `silence` already turns the volume down; this is the same mechanism said
   * the other way round, for a block that needs to be heard rather than one
   * that needs to be quiet.
   */
  async logAt<T>(level: Level, body: () => Promise<T>): Promise<T> {
    return await this.silence(body, level);
  }

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
