/**
 * What the debug page needs to know about an exception, ported from
 * `ActionDispatch::ExceptionWrapper`.
 *
 * `error-page.ts` can already take a stack apart and read source around a
 * frame. That is not enough to render a useful page, for two reasons.
 *
 * **A stack is mostly not yours.** A framework error arrives with forty frames
 * of which three are the application's. Showing all forty buries the line
 * somebody has to change; showing only the three loses the path that got there
 * when the bug is in how we called the framework. So the trace is grouped —
 * Application, Framework, Full — and the page opens on the group most likely
 * to hold the answer.
 *
 * **An exception is usually not one exception.** A driver error wrapped by a
 * query error wrapped by a request error is three messages, and the one that
 * says what went wrong is the innermost. A page showing only the outermost
 * says "query failed", which is the part the developer already knew.
 */

import type { StackFrame } from "./error-page.js";
import { parseStack } from "./error-page.js";
import { RESCUE_RESPONSES } from "./rescue-responses.js";

/**
 * Errors that exist only to add context to another one.
 *
 * The status and the source location should come from what they wrap: a
 * template error's own stack points into the renderer, which is never where
 * the bug is.
 */
export const WRAPPER_EXCEPTIONS: readonly string[] = ["TemplateError", "ViewError"];

/**
 * Errors not worth a framework trace when the application trace is empty.
 *
 * A routing error has no application frames because no application code ran —
 * that is what it means. Printing the router's own internals in its place
 * suggests the router is broken, which is exactly the wrong thing to look at.
 */
export const SILENT_EXCEPTIONS: readonly string[] = ["RoutingError", "ActionNotFound"];

/**
 * Which page an error gets. Rails' `rescue_templates`.
 *
 * Some errors have a better answer than a stack: a missing route should show
 * the routes, a missing template the paths that were searched. Anything
 * unlisted gets the diagnostics page.
 */
export const RESCUE_TEMPLATES: Readonly<Record<string, string>> = {
  MissingTemplate: "missing_template",
  RoutingError: "routing_error",
  ActionNotFound: "unknown_action",
  StatementInvalid: "invalid_statement",
  TemplateError: "template_error",
};

/** Which frames a trace group holds. */
export type TraceKind = "application" | "framework" | "full";

/** One frame with the identity the page needs to link to it. */
export interface IdentifiedFrame {
  /** Index within the full trace, so a link survives the grouping. */
  id: number;
  frame: StackFrame;
}

export type Traces = Record<TraceKind, IdentifiedFrame[]>;

/**
 * Whether to show the detailed page at all. Rails' `show_exceptions` setting.
 *
 * `rescuable` is the interesting one: it shows a page for errors the
 * application has classified — a 404, a 422 — and the plain response for
 * anything else, so a staging environment can be readable without printing
 * source to whoever finds an unhandled bug.
 */
export type ShowExceptions = "all" | "none" | "rescuable";

export function showDetailedExceptions(setting: ShowExceptions, error: unknown): boolean {
  if (setting === "none") return false;
  if (setting === "all") return true;

  return isRescueResponse(error);
}

/** Whether an error is one the application has given a status to. */
export function isRescueResponse(error: unknown): boolean {
  return error instanceof Error && error.name in RESCUE_RESPONSES;
}

/** The status a class name should answer with. Rails' `status_code_for_exception`. */
export function statusCodeForException(
  className: string,
  overrides: Readonly<Record<string, number>> = {},
): number {
  return overrides[className] ?? RESCUE_RESPONSES[className] ?? 500;
}

/**
 * Every error in the `cause` chain, outermost first, not counting the one
 * given. Rails' `causes_for`.
 *
 * Stops at a repeat. Ruby does not need to: its `cause` is set by the runtime
 * and cannot loop. Ours is an ordinary property anybody can assign, and
 * `a.cause = b; b.cause = a` would otherwise spin here forever — on the page
 * that is supposed to explain the failure.
 */
export function* causesFor(error: unknown): Generator<Error> {
  const seen = new Set<unknown>([error]);
  let current: unknown = error instanceof Error ? error.cause : undefined;

  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    yield current;
    current = current.cause;
  }
}

/** Each cause wrapped, so the page can render them the same way. Rails' `wrapped_causes_for`. */
export function wrappedCausesFor(error: unknown, root: string): ExceptionWrapper[] {
  return Array.from(causesFor(error), (cause) => new ExceptionWrapper(cause, root));
}

/** Whether anything wrapped anything. */
export function hasCause(error: unknown): boolean {
  return error instanceof Error && error.cause instanceof Error;
}

let nextId = 0;
const ids = new WeakMap<object, number>();

/**
 * A stable number for one error object. Rails uses `object_id`.
 *
 * The page needs it to key the disclosure for each exception in the chain; two
 * errors with the same class and message are still two errors, and collapsing
 * one must not collapse the other.
 */
export function exceptionId(error: unknown): number {
  if (typeof error !== "object" || error === null) return -1;

  const existing = ids.get(error);
  if (existing !== undefined) return existing;

  nextId += 1;
  ids.set(error, nextId);

  return nextId;
}

/** How an error prints in a log. Rails' `exception_inspect`. */
export function exceptionInspect(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  return error.message === "" ? error.name : `#<${error.name}: ${error.message}>`;
}

/** The file and line a frame points at. Rails' `extract_file_and_line_number`. */
export function extractFileAndLineNumber(frame: StackFrame): { file: string; line: number } {
  return { file: frame.file, line: frame.line };
}

/**
 * Lines around a failing one, keyed by line number. Rails'
 * `extract_source_fragment_lines`.
 *
 * Keyed rather than an array because the page prints the real line numbers,
 * and an array would make every consumer add the offset back — which is the
 * kind of arithmetic that ends up off by one on the page you read when
 * something is already broken.
 */
export function extractSourceFragmentLines(
  sourceLines: readonly string[],
  line: number,
  context = 3,
): Record<number, string> {
  const start = Math.max(line - context, 1);
  const end = Math.min(line + context, sourceLines.length);
  const fragment: Record<number, string> = {};

  for (let at = start; at <= end; at += 1) fragment[at] = sourceLines[at - 1] ?? "";

  return fragment;
}

/**
 * The same, read from a file. Rails' `source_fragment`.
 *
 * Undefined when the file cannot be read, rather than thrown: this runs when
 * something has already gone wrong, and losing the whole page because a file
 * moved trades a partly useful page for none.
 */
export async function sourceFragment(
  file: string,
  line: number,
  context = 3,
): Promise<Record<number, string> | undefined> {
  try {
    const text = await Bun.file(file).text();

    return extractSourceFragmentLines(text.split("\n"), line, context);
  } catch {
    return undefined;
  }
}

/**
 * One exception, ready to render.
 *
 * Built once and read many times, because the page asks the same questions in
 * several places and taking a stack apart on each is work done while the site
 * is down.
 */
export class ExceptionWrapper {
  readonly exception: unknown;
  readonly exceptionClassName: string;
  readonly root: string;
  readonly wrappedCauses: ExceptionWrapper[];

  readonly #backtrace: StackFrame[];

  constructor(exception: unknown, root: string) {
    this.exception = exception;
    this.exceptionClassName = exception instanceof Error ? exception.name : "Error";
    this.root = root;
    // Causes first: they are wrapped with the same root, and building them here
    // means the page never has to walk the chain itself.
    this.wrappedCauses = wrappedCausesFor(exception, root);
    this.#backtrace = this.buildBacktrace();
  }

  /** The frames, taken apart. Rails' `build_backtrace`. */
  buildBacktrace(): StackFrame[] {
    const source = this.unwrappedException();

    return parseStack(source instanceof Error ? source.stack : undefined, this.root);
  }

  /**
   * The error actually worth reporting. Rails' `unwrapped_exception`.
   *
   * A wrapper's own stack points into the machinery that wrapped it, so its
   * status and its source location both belong to what it wrapped.
   */
  unwrappedException(): unknown {
    if (!WRAPPER_EXCEPTIONS.includes(this.exceptionClassName)) return this.exception;

    const cause = this.exception instanceof Error ? this.exception.cause : undefined;

    return cause ?? this.exception;
  }

  hasCause(): boolean {
    return hasCause(this.exception);
  }

  /** The extra line a template error carries about which partial failed. */
  subTemplateMessage(): string | undefined {
    const message = (this.exception as { subTemplateMessage?: unknown }).subTemplateMessage;

    return typeof message === "string" ? message : undefined;
  }

  /** Whether this is a wrapped render failure, which the page renders differently. */
  templateError(): boolean {
    return this.exceptionClassName === "TemplateError";
  }

  /** The several errors behind one, for an error that collects them. */
  failures(): unknown[] {
    const failures = (this.exception as { failures?: unknown }).failures;

    return Array.isArray(failures) ? failures : [];
  }

  /** The frames belonging to one group. Rails' `clean_backtrace`. */
  cleanBacktrace(kind: TraceKind): StackFrame[] {
    if (kind === "full") return this.#backtrace;

    const wanted = kind === "application";

    return this.#backtrace.filter((frame) => frame.application === wanted);
  }

  /**
   * The trace to report. Rails' `exception_trace`.
   *
   * Falls back to the framework's frames when the application has none, except
   * for the errors where having none is the answer — a routing error ran no
   * application code, and showing the router's internals suggests the router is
   * what to fix.
   */
  exceptionTrace(): StackFrame[] {
    const application = this.cleanBacktrace("application");

    if (application.length > 0) return application;
    if (SILENT_EXCEPTIONS.includes(this.exceptionClassName)) return [];

    return this.cleanBacktrace("framework");
  }

  /**
   * All three groups, each frame carrying its index in the full trace. Rails'
   * `traces`.
   *
   * The id comes from the full trace so that a frame keeps it in every group:
   * the page links source to a frame, and the link has to survive the reader
   * switching tabs.
   */
  traces(): Traces {
    const full: IdentifiedFrame[] = this.#backtrace.map((frame, id) => ({ id, frame }));

    return {
      application: full.filter((each) => each.frame.application),
      framework: full.filter((each) => !each.frame.application),
      full,
    };
  }

  /** Which page this error gets. Rails' `rescue_template`. */
  rescueTemplate(): string {
    return RESCUE_TEMPLATES[this.exceptionClassName] ?? "diagnostics";
  }

  /** The status it answers with, taken from what it wrapped. */
  statusCode(overrides: Readonly<Record<string, number>> = {}): number {
    const unwrapped = this.unwrappedException();
    const name = unwrapped instanceof Error ? unwrapped.name : "Error";

    return statusCodeForException(name, overrides);
  }

  /**
   * Which group the page opens on. Rails' `trace_to_show`.
   *
   * Application when there is one, because that is where the fix is. Full
   * otherwise — except for a routing error, whose own page is the routes and
   * not a stack at all.
   */
  traceToShow(): TraceKind {
    if (this.traces().application.length === 0 && this.rescueTemplate() !== "routing_error") {
      return "full";
    }

    return "application";
  }

  /** The frame whose source is shown first. Rails' `source_to_show_id`. */
  sourceToShowId(): number | undefined {
    return this.traces()[this.traceToShow()][0]?.id;
  }

  exceptionId(): number {
    return exceptionId(this.exception);
  }

  exceptionInspect(): string {
    return exceptionInspect(this.exception);
  }

  message(): string {
    return this.exception instanceof Error ? this.exception.message : String(this.exception);
  }
}
