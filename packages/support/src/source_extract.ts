/**
 * Showing the code a failure happened in, ported from
 * `ActionDispatch::ExceptionWrapper` and `ActiveSupport::SourceExtract`.
 *
 * `backtrace_cleaner.ts` decides which frames are worth reading. This turns a
 * frame into the thing a person actually wants: the file, the line, and the
 * few lines either side, with the failing one marked.
 *
 *     const [frame] = sourceExtracts(error)
 *     console.log(annotatedSourceCode(frame))
 *
 *     >  41 |   const total = items.reduce(sum)
 *        42 |   return total / items.length
 *
 * A stack trace names a position and shows none of it, so reading one means
 * opening each file and counting lines — and the frame that matters is rarely
 * the top one. Rails puts the source on the error page for that reason, and
 * the same information is what makes a logged production trace legible months
 * later when the line numbers have moved.
 */

import { readFileSync } from "node:fs";
import type { BacktraceCleaner } from "./backtrace_cleaner.js";

/** One frame of a stack, taken apart. */
export interface BacktraceFrame {
  /** The path as the stack wrote it. */
  file: string;
  lineNumber: number;
  column?: number;
  /** The function name, when the runtime recorded one. */
  method?: string;
  /** The frame as it was written, for anything this did not pull out. */
  line: string;
}

/**
 * The two shapes V8 writes a frame in.
 *
 * `at name (/path/file.ts:41:9)` when it knows the function, and
 * `at /path/file.ts:41:9` when it does not — a top-level statement, or a
 * callback nobody named. Handling only the first drops exactly the frames a
 * bare `throw` at module scope produces.
 */
const NAMED = /^\s*at\s+(.+?)\s+\((.+):(\d+):(\d+)\)\s*$/;
const BARE = /^\s*at\s+(.+):(\d+):(\d+)\s*$/;

/** Takes one stack line apart, or null if it is not a frame. */
export function parseBacktraceFrame(line: string): BacktraceFrame | null {
  const named = NAMED.exec(line);

  if (named) {
    return {
      method: named[1],
      file: named[2] as string,
      lineNumber: Number(named[3]),
      column: Number(named[4]),
      line,
    };
  }

  const bare = BARE.exec(line);

  if (bare) {
    return {
      file: bare[1] as string,
      lineNumber: Number(bare[2]),
      column: Number(bare[3]),
      line,
    };
  }

  return null;
}

/** Every frame of a trace, in order, skipping the message line at the top. */
export function backtraceFrames(
  backtrace: string | readonly string[] | undefined,
): BacktraceFrame[] {
  if (backtrace === undefined) return [];

  const lines = typeof backtrace === "string" ? backtrace.split("\n") : backtrace;

  return lines
    .map((line) => parseBacktraceFrame(line))
    .filter((frame): frame is BacktraceFrame => frame !== null);
}

/** One line of a file, with its number and whether it is the failing one. */
export interface SourceLine {
  number: number;
  text: string;
  /** True for the line the frame named. */
  failing: boolean;
}

export interface SourceExtract {
  frame: BacktraceFrame;
  /** Empty when the file could not be read. */
  lines: SourceLine[];
}

export interface ExtractOptions {
  /** How many lines either side. Rails shows three. */
  context?: number;
  /** Reads a file, so a test — or a bundle — can supply its own. */
  read?: (file: string) => string;
}

function readSource(file: string): string {
  return readFileSync(file, "utf8");
}

/**
 * The lines around a position in a file. Rails' `extract_source`.
 *
 * An empty list when the file cannot be read, rather than a throw: the whole
 * point of this is to explain a failure that already happened, and failing
 * while doing so would replace a useful error with a useless one. A stack can
 * name a file that has been deleted, moved, bundled, or was never on disk.
 */
export function extractSource(frame: BacktraceFrame, options: ExtractOptions = {}): SourceLine[] {
  const context = options.context ?? 3;
  const read = options.read ?? readSource;

  let source: string;

  try {
    source = read(frame.file);
  } catch {
    return [];
  }

  const all = source.split("\n");
  const index = frame.lineNumber - 1;

  if (index < 0 || index >= all.length) return [];

  const from = Math.max(0, index - context);
  const to = Math.min(all.length, index + context + 1);
  const lines: SourceLine[] = [];

  for (let at = from; at < to; at += 1) {
    lines.push({ number: at + 1, text: all[at] ?? "", failing: at === index });
  }

  return lines;
}

/**
 * Source for the top frames of a trace. Rails' `source_extracts`.
 *
 * Bounded, because a deep recursion produces thousands of frames and reading a
 * file for each turns an error page into its own outage.
 */
export function sourceExtracts(
  error: { stack?: string } | string | undefined,
  options: ExtractOptions & { limit?: number } = {},
): SourceExtract[] {
  const stack = typeof error === "string" ? error : error?.stack;

  return backtraceFrames(stack)
    .slice(0, options.limit ?? 5)
    .map((frame) => ({ frame, lines: extractSource(frame, options) }));
}

/**
 * The extract as text, with the failing line marked. Rails'
 * `annotated_source_code`.
 *
 * The marker is in the gutter rather than around the text, so the code stays
 * copyable and the columns still line up — an arrow inserted into the line
 * itself shifts everything after it and makes a column number a lie.
 */
export function annotatedSourceCode(extract: SourceExtract): string {
  if (extract.lines.length === 0) return "";

  const width = String(extract.lines[extract.lines.length - 1]?.number ?? 0).length;

  return extract.lines
    .map((line) => {
      const gutter = String(line.number).padStart(width, " ");

      return `${line.failing ? ">" : " "} ${gutter} | ${line.text}`;
    })
    .join("\n");
}

/** Where a frame points, as `file:line`, which is what an editor opens. */
export function frameLocation(frame: BacktraceFrame): string {
  return `${frame.file}:${String(frame.lineNumber)}`;
}

/**
 * The frames in the application's own code. Rails' `application_trace`.
 *
 * The one to read first. A failure inside a framework almost always started
 * with a call from the application, and that call is what the person looking
 * can change.
 */
export function applicationTrace(
  error: { stack?: string } | string | undefined,
  cleaner: BacktraceCleaner,
): string[] {
  return cleaner.clean(stackOf(error), "clean");
}

/** The frames this trace passed through in the framework and the runtime. */
export function frameworkTrace(
  error: { stack?: string } | string | undefined,
  cleaner: BacktraceCleaner,
): string[] {
  return cleaner.clean(stackOf(error), "noise");
}

/** Everything, filtered but not silenced. Rails' `full_trace`. */
export function fullTrace(
  error: { stack?: string } | string | undefined,
  cleaner: BacktraceCleaner,
): string[] {
  return cleaner.clean(stackOf(error), "all");
}

function stackOf(error: { stack?: string } | string | undefined): string | undefined {
  return typeof error === "string" ? error : error?.stack;
}

/**
 * The name to show for an error. Rails' `exception_name`.
 *
 * The constructor's name rather than `name`, when they differ: a subclass that
 * forgot to set `name` still reports as its own class, which is what somebody
 * reading the page is looking for in the source.
 */
export function exceptionName(error: unknown): string {
  if (error instanceof Error) {
    const constructed = error.constructor.name;

    return constructed === "Error" ? error.name : constructed;
  }

  return typeof error;
}
