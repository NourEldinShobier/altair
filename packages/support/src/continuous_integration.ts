/**
 * Running a project's checks and saying what happened, ported from
 * `ActiveSupport::ContinuousIntegration`.
 *
 * A shell script that runs four commands in a row is the version everybody
 * writes first, and it is wrong in the same three ways every time:
 *
 * - **It stops at the first failure**, so a run tells you the formatter is
 *   unhappy and nothing about whether the tests pass. The next run tells you
 *   about the tests. Finding out that both were broken takes as many pushes as
 *   there are broken things.
 * - **It says nothing about time.** The check that quietly grew to four
 *   minutes is invisible until somebody times the whole run by hand, and by
 *   then it has been slow for months.
 * - **It reports the wrong exit status**, because getting a pipeline's status
 *   right in shell needs `pipefail` and a subshell, and the failure mode is a
 *   green build over a red test run.
 *
 * So every step is run, every step is timed, the failures are listed again at
 * the end where they can be read without scrolling, and the process exits
 * non-zero if any of them failed. Fail-fast is available and is *opt-in*,
 * because the default a person wants locally and the default a person wants in
 * CI are the same one: tell me everything that is broken.
 *
 * The command runner, the output sink and the clock are all parameters, which
 * is what makes this testable without starting processes — and, incidentally,
 * what lets a caller run the same declaration against a different executor.
 */

import { colorizeLogging, colorize } from "./logger.js";

/** What a line of output is, which is all that decides its colour. */
export type CiTone = "banner" | "title" | "subtitle" | "error" | "success" | "progress";

/** Rails' `ContinuousIntegration::COLORS`. */
export const CI_COLOURS: Record<CiTone, string> = {
  banner: "[32m",
  title: "[35m",
  subtitle: "[90m",
  error: "[31m",
  success: "[32m",
  progress: "[36m",
};

export interface StepResult {
  title: string;
  ok: boolean;
  seconds: number;
}

/** Runs one command and says whether it succeeded. */
export type CommandRunner = (command: readonly string[]) => boolean | Promise<boolean>;

export interface CiOptions {
  run?: CommandRunner;
  write?: (line: string) => void;
  /** Monotonic milliseconds. A parameter so a test can assert on a duration. */
  clock?: () => number;
  /** Stop after the first failure. Rails' `--fail-fast`. */
  failFast?: boolean;
  colour?: boolean;
}

export class ContinuousIntegration {
  readonly results: StepResult[] = [];

  #run: CommandRunner;
  #write: (line: string) => void;
  #clock: () => number;
  #failFast: boolean;
  #colour: boolean;

  constructor(options: CiOptions = {}) {
    this.#run = options.run ?? notConfigured;
    this.#write = options.write ?? ((line) => void console.log(line));
    this.#clock = options.clock ?? (() => performance.now());
    this.#failFast = options.failFast ?? false;
    this.#colour = options.colour ?? colorizeLogging();
  }

  /** Whether everything that ran passed. Rails' `success?`. */
  success(): boolean {
    return this.results.every((result) => result.ok);
  }

  /** Writes one line in the colour its kind calls for. Rails' `echo`. */
  echo(text: string, type: CiTone): void {
    this.#write(this.#colour ? colorize(text, CI_COLOURS[type], { bold: true }) : text);
  }

  /** A title with an optional subtitle under it. Rails' `heading`. */
  heading(title: string, subtitle?: string, type: CiTone = "banner"): void {
    this.echo(title, type);

    if (subtitle !== undefined) this.echo(subtitle, "subtitle");
  }

  /** An error heading, for when the run is being abandoned. Rails' `failure`. */
  failure(title: string, subtitle?: string): void {
    this.heading(title, subtitle, "error");
  }

  /**
   * Announces a step, times what it does, and records the outcome. Rails'
   * `report_step`.
   *
   * The announcement comes *before* the work, not after: a step that hangs
   * should say which one it is while it is hanging, and one that only prints
   * on completion leaves somebody staring at a blank terminal wondering what
   * is stuck.
   */
  async reportStep(
    title: string,
    command: readonly string[],
    body: () => boolean | Promise<boolean>,
  ): Promise<boolean> {
    this.heading(title, command.join(" ") || undefined, "title");

    const started = this.#clock();
    let ok: boolean;

    try {
      ok = await body();
    } catch {
      // A runner that threw is a step that failed, not a run that crashed.
      // Losing the other steps' results to an exception in one of them is how
      // a report ends up less useful than the shell script it replaced.
      ok = false;
    }

    const seconds = (this.#clock() - started) / 1000;

    this.results.push({ title, ok, seconds });
    this.echo(
      `${ok ? "PASS" : "FAIL"} ${title} in ${formatElapsed(seconds)}`,
      ok ? "success" : "error",
    );

    return ok;
  }

  /**
   * Declares a step. Rails' `step`.
   *
   * Skipped once something has failed and fail-fast is on — recorded as
   * nothing rather than as a pass, so the report does not claim a check ran
   * that did not.
   */
  async step(title: string, ...command: string[]): Promise<boolean> {
    if (this.#failFast && !this.success()) return false;

    return await this.reportStep(title, command, () => this.#run(command));
  }

  /**
   * Runs the declaration and reports. Rails' `ContinuousIntegration.run`.
   *
   * Returns whether everything passed rather than exiting, because a module
   * that calls `process.exit` cannot be tested and cannot be used from
   * anything that wanted to do something afterwards. The caller decides what a
   * failure means.
   */
  async run(
    title: string,
    subtitle: string | undefined,
    body: () => void | Promise<void>,
  ): Promise<boolean> {
    this.heading(title, subtitle);

    const started = this.#clock();

    await body();

    const seconds = (this.#clock() - started) / 1000;
    const ok = this.success();

    // Listed again only when there was more than one step: with one, the line
    // above already said which one failed, and repeating it reads as two
    // failures.
    if (!ok && this.results.length > 1) {
      for (const failed of this.results.filter((result) => !result.ok)) {
        this.echo(`  -> ${failed.title} failed`, "error");
      }
    }

    this.echo(
      `${ok ? "PASS" : "FAIL"} ${title} in ${formatElapsed(seconds)}`,
      ok ? "success" : "error",
    );

    return ok;
  }
}

/**
 * A duration a person can read. Rails' `format_elapsed`.
 *
 * Minutes are only shown once there are any: "0m3.40s" is noise on the three
 * seconds a formatter takes, and the number that matters is the seconds.
 */
export function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = (seconds - minutes * 60).toFixed(2);

  return minutes > 0 ? `${minutes}m${rest}s` : `${rest}s`;
}

function notConfigured(): never {
  throw new Error(
    "ContinuousIntegration needs a `run` that executes a command. Pass one — this module " +
      "deliberately does not reach for a shell on its own, so that what it launches is always " +
      "something the caller chose.",
  );
}
