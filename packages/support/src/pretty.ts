/**
 * The development log format.
 *
 * Rails' development log is one of the reasons Rails is pleasant to work in:
 * you glance at the terminal and see what happened without reading it. That is
 * a formatting problem, not a logging problem, so it lives here rather than in
 * the logger — the same records that render as JSON in production render as
 * this in a terminal, and nothing about the call site changes.
 *
 * No dependency, and the reason is the dependency rather than the alternatives
 * being bad. Measured on Bun 1.4 with output discarded, an enabled call costs
 * 400ns here, 439 in consola, 463 in pino, 581 in LogTape and 1047 in winston
 * — nothing on offer is faster, so adopting one would buy a package rather
 * than a speed-up. pino brings 14 packages and winston 28; a framework spends
 * that budget on behalf of every application built on it.
 *
 * (`pino-pretty` does work under Bun 1.4 — an earlier version of this comment
 * said it did not, on the strength of a 2023 issue rather than a test.)
 *
 * What gets colour is chosen, not uniform. Colouring everything is the same as
 * colouring nothing; these highlight the four things worth a glance — how bad
 * it was, how slow it was, what the status was, and which request it belongs
 * to.
 */

import type { Formatter, Level, LogEntry } from "./logger.js";
import { defaultBacktraceCleaner, type BacktraceCleaner } from "./backtrace_cleaner.js";

const CODES = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  blue: "\u001b[34m",
  magenta: "\u001b[35m",
  cyan: "\u001b[36m",
  grey: "\u001b[90m",
  redBg: "\u001b[41m\u001b[97m",
} as const;

type Colour = keyof typeof CODES;

/**
 * Whether to emit escape codes at all.
 *
 * `NO_COLOR` is honoured because it is the agreed way to ask, and a log piped
 * into a file or a collector gets none: escape codes in a stored log are
 * rubbish that every later reader has to strip.
 */
export function colourEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0") return true;

  return Boolean(process.stdout.isTTY);
}

function paint(text: string, colour: Colour | undefined, enabled: boolean): string {
  if (!enabled || !colour) return text;
  return `${CODES[colour]}${text}${CODES.reset}`;
}

const LEVEL_COLOUR: Record<Level, Colour> = {
  debug: "grey",
  info: "blue",
  warn: "yellow",
  error: "red",
  fatal: "redBg",
};

/** Green under 50ms, amber under 200, red past it. */
function durationColour(milliseconds: number): Colour {
  if (milliseconds < 50) return "green";
  if (milliseconds < 200) return "yellow";
  return "red";
}

/** The colour a browser's devtools would give the status. */
function statusColour(status: number): Colour {
  if (status >= 500) return "red";
  if (status >= 400) return "yellow";
  if (status >= 300) return "cyan";
  return "green";
}

/**
 * A stable colour per value, so one request's lines share one colour.
 *
 * The point of a request id in a log is to follow one request through
 * interleaved output, and the eye follows a colour far faster than it reads a
 * uuid. Six colours, so two concurrent requests are very unlikely to collide
 * and it does not matter much when they do.
 */
const IDENTITY: Colour[] = ["cyan", "magenta", "green", "yellow", "blue", "grey"];

export function identityColour(value: string): Colour {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) hash = (hash * 31 + value.charCodeAt(i)) | 0;

  return IDENTITY[Math.abs(hash) % IDENTITY.length] as Colour;
}

function colourFor(key: string, value: unknown): Colour | undefined {
  if (typeof value === "number") {
    if (key === "status") return statusColour(value);
    if (key.endsWith("Ms")) return durationColour(value);
    return "cyan";
  }

  if (key === "requestId" || key === "jobId") return identityColour(String(value));
  if (typeof value === "boolean") return value ? "green" : "red";
  if (value instanceof Error) return "red";

  return undefined;
}

function render(value: unknown): string {
  if (typeof value === "string") return /[\s"]/.test(value) ? JSON.stringify(value) : value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (value === null || value === undefined || typeof value !== "object") return String(value);

  return JSON.stringify(value);
}

export interface PrettyOptions {
  /** Overrides the terminal check. */
  colour?: boolean;
  /** Prints an error's stack under the line it belongs to. */
  stacks?: boolean;
  /** Keys to put first, so the eye finds them in the same place every time. */
  leading?: readonly string[];
  /**
   * What decides which stack frames are worth printing.
   *
   * Replaceable, because "which frames are noise" is the application's
   * judgement: a library author debugging the framework wants the frames an
   * application author does not.
   */
  cleaner?: BacktraceCleaner;
}

/**
 * Builds the formatter.
 *
 * The leading keys are the reason this reads well: `method` and `path` always
 * appear in the same place, so scrolling a log is scanning a column rather
 * than reading every line.
 */
export function prettyFormatter(options: PrettyOptions = {}): Formatter {
  const enabled = options.colour ?? colourEnabled();
  const stacks = options.stacks ?? true;
  const cleaner = options.cleaner ?? defaultBacktraceCleaner();
  const leading = options.leading ?? ["method", "path", "status", "durationMs"];

  return (entry: LogEntry): string => {
    const time = paint(entry.time.toISOString().slice(11, 23), "grey", enabled);
    const level = paint(entry.level.toUpperCase().padEnd(5), LEVEL_COLOUR[entry.level], enabled);

    // The request id goes in front of the message rather than among the
    // key/value pairs: it is the thing that says which conversation this line
    // belongs to, and that belongs at the start of the line.
    const id = entry.payload.requestId;
    const tag =
      id === undefined
        ? ""
        : `${paint(`[${String(id).slice(0, 8)}]`, identityColour(String(id)), enabled)} `;

    const keys = Object.keys(entry.payload).filter((key) => key !== "requestId");
    keys.sort((a, b) => order(a, leading) - order(b, leading));

    const pairs = keys
      .map((key) => {
        const value = entry.payload[key];
        const shown = paint(render(value), colourFor(key, value), enabled);
        return `${paint(`${key}=`, "dim", enabled)}${shown}`;
      })
      .join(" ");

    const line = `${time} ${level} ${tag}${paint(entry.message, "bold", enabled)}${pairs ? ` ${pairs}` : ""}`;

    if (!stacks) return line;

    // Indented under its own line rather than inlined: a stack on one line is
    // unreadable, and a stack that is not printed at all is the reason
    // somebody goes looking for it in the database.
    const stack = Object.values(entry.payload).find(
      (value): value is Error => value instanceof Error && Boolean(value.stack),
    );

    if (!stack?.stack) return line;

    // Cleaned before printing: a trace from anything running on a framework is
    // forty lines and three of them are yours, and the other thirty-seven are
    // why nobody reads it. The cleaner hands back the whole thing when keeping
    // only the application's frames would leave nothing — which happens
    // exactly when the failure really is inside the framework, and is when
    // somebody most needs to see where.
    const rows = cleaner.clean(stack.stack);
    const hidden = cleaner.clean(stack.stack, "all").length - rows.length;

    const indented = rows.map((row) => paint(`    ${row.trim()}`, "grey", enabled)).join("\n");

    const note =
      hidden > 0 ? `\n${paint(`    ... ${hidden} framework frames hidden`, "dim", enabled)}` : "";

    return `${line}\n${indented}${note}`;
  };
}

function order(key: string, leading: readonly string[]): number {
  const index = leading.indexOf(key);
  return index === -1 ? leading.length : index;
}
