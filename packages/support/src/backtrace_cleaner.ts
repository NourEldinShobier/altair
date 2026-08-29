/**
 * Making a stack trace readable, ported from
 * `ActiveSupport::BacktraceCleaner`.
 *
 *     cleaner.clean(error.stack)
 *
 * A trace from anything running on a framework is forty lines and three of
 * them are yours. The other thirty-seven are true, and they are the reason
 * nobody reads the trace: the eye has to find the application's own frames
 * among the runtime's, the framework's and every dependency's before it can
 * start on the actual question.
 *
 * Two mechanisms, and the distinction is Rails'. A **filter** rewrites a line —
 * usually to strip an absolute path down to something a person recognises. A
 * **silencer** removes one entirely. Filters run first, so a silencer sees the
 * shortened form and can be written against it.
 */

/** Rewrites a line. Returns the line as it should be shown. */
export type BacktraceFilter = (line: string) => string;

/** Whether a line is noise. */
export type BacktraceSilencer = (line: string) => boolean;

/**
 * Which half of the trace to return.
 *
 * `"clean"` is the application's own frames, `"noise"` is everything that was
 * silenced, and `"all"` is every line with the filters applied and nothing
 * removed. The middle one exists because "where did this actually happen"
 * sometimes has its answer inside a dependency, and a cleaner that could only
 * hide those would be hiding the answer.
 */
export type BacktraceKind = "clean" | "noise" | "all";

export class BacktraceCleaner {
  #filters: BacktraceFilter[] = [];
  #silencers: BacktraceSilencer[] = [];

  addFilter(filter: BacktraceFilter): this {
    this.#filters.push(filter);
    return this;
  }

  addSilencer(silencer: BacktraceSilencer): this {
    this.#silencers.push(silencer);
    return this;
  }

  removeFilters(): this {
    this.#filters = [];
    return this;
  }

  removeSilencers(): this {
    this.#silencers = [];
    return this;
  }

  /** Whether every silencer would keep this line. */
  silenced(line: string): boolean {
    return this.#silencers.some((silencer) => silencer(line));
  }

  /**
   * The trace, cleaned.
   *
   * Takes a stack string or the lines of one. The message line a runtime puts
   * at the top of `error.stack` is not a frame and is dropped, since a trace
   * that begins with its own message is a trace nobody can filter.
   *
   * **If cleaning removes everything, the filtered trace is returned instead.**
   * That is Rails' behaviour and the reason for it is worth stating: an empty
   * backtrace is strictly worse than a noisy one. It happens whenever the
   * failure really is inside the framework, which is exactly when somebody
   * needs to see where.
   */
  clean(
    backtrace: string | readonly string[] | undefined,
    kind: BacktraceKind = "clean",
  ): string[] {
    const lines = (typeof backtrace === "string" ? backtrace.split("\n") : (backtrace ?? []))
      .filter((line) => line.trim().length > 0)
      .filter((line) => /^\s*at\s/.test(line));

    const filtered = lines.map((line) => this.#filters.reduce((text, f) => f(text), line));

    if (kind === "all") return filtered;
    if (kind === "noise") return filtered.filter((line) => this.silenced(line));

    const cleaned = filtered.filter((line) => !this.silenced(line));

    return cleaned.length > 0 ? cleaned : filtered;
  }
}

/**
 * A cleaner that knows about this runtime and this project.
 *
 * Silences `node_modules`, the runtime's own `node:`/`bun:` frames, and the
 * framework's own packages; shortens an absolute path to something relative.
 * An application adds its own on top.
 */
export function defaultBacktraceCleaner(root: string = process.cwd()): BacktraceCleaner {
  const cleaner = new BacktraceCleaner();

  // Normalised first, so a silencer written with forward slashes matches on
  // Windows too — where a stack carries backslashes and nothing else would.
  cleaner.addFilter((line) => line.replaceAll("\\", "/"));

  const prefix = root.replaceAll("\\", "/").replace(/\/+$/, "");
  if (prefix) cleaner.addFilter((line) => line.replaceAll(`${prefix}/`, ""));

  cleaner.addSilencer((line) => line.includes("node_modules"));
  cleaner.addSilencer((line) => /\((?:node|bun|internal):/.test(line));
  cleaner.addSilencer((line) => /\bpackages\/[a-z-]+\/src\//.test(line));

  return cleaner;
}
