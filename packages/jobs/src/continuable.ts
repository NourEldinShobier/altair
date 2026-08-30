/**
 * A job that can be stopped partway and picked up where it left off, ported
 * from `ActiveJob::Continuable` (Rails 8).
 *
 *     class ProcessImports extends Job {
 *       async perform() {
 *         await this.step("find", async () => { ... })
 *
 *         await this.step("process", async (step) => {
 *           for (const id of await pending(step.cursor)) {
 *             await processOne(id)
 *             await step.advance(id)
 *           }
 *         })
 *       }
 *     }
 *
 * The problem it solves: a job that runs for an hour and a deploy that
 * restarts the worker after fifty minutes. Without this the job is either
 * killed and lost, or killed and retried from the beginning — and retried from
 * the beginning means the first fifty minutes of work happen twice, which for
 * anything that sends mail or charges a card is not merely slow.
 *
 * With it, the worker asks the job to stop, the job stops at its next
 * checkpoint, and it is re-enqueued carrying which steps finished and how far
 * the unfinished one got.
 *
 * Progress is only ever recorded at a checkpoint the job chose, so a step is
 * resumed from a point the job said was safe rather than wherever it happened
 * to be when the signal arrived.
 */

/** Base for the errors a continuation raises. Rails' `Continuation::Error`. */
export class ContinuationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * A step was declared in a way that cannot be resumed from. Rails'
 * `InvalidStepError`.
 *
 * Raised rather than tolerated because the failure it prevents is silent. A
 * resumed job replays `perform` from the top and matches its steps against
 * what finished last time; if the sequence differs — a branch took the other
 * path, a step moved — then matching by name against a different order either
 * skips work that never ran or repeats work that did. Neither shows up as an
 * error at the time.
 */
export class InvalidStepError extends ContinuationError {}

/**
 * A job asked to resume more times than it is allowed. Rails'
 * `ResumeLimitError`.
 *
 * A job that is interrupted every time it runs — because one step cannot
 * finish inside the shutdown window — is otherwise a job that re-enqueues
 * itself forever, occupying a worker and never finishing.
 */
export class ResumeLimitError extends ContinuationError {}

/** `advanceFrom` was given a cursor it cannot add one to. */
export class UnadvanceableCursorError extends ContinuationError {}

/** Thrown inside a job to stop it at a checkpoint. Caught by the runner. */
export class JobInterrupted extends Error {
  constructor(
    readonly continuation: ContinuationState,
    /** Why it stopped, for the log line. Rails' `interrupt!(reason:)`. */
    readonly reason: string = "stopping",
  ) {
    super(`Interrupted ${describe(continuation)} (${reason})`);
    this.name = "JobInterrupted";
  }
}

/** What a resumed job needs to know: what finished, and how far the rest got. */
export interface ContinuationState {
  /** Steps that ran to completion, by name. */
  completed: string[];
  /** The step that was running when the job stopped. */
  step?: string;
  /** How far that step got, as the job last recorded it. */
  cursor?: unknown;
  /** How many times this job has already been resumed. Rails' `resumptions`. */
  resumptions?: number;
}

/** Rails' `to_h` shape: the current step as the `[name, cursor]` pair. */
export interface ContinuationHash {
  completed: string[];
  current?: [string, unknown];
  resumptions: number;
}

/** Cursors are shown as JSON; `undefined` has no JSON form and reads as itself. */
function showCursor(cursor: unknown): string {
  return JSON.stringify(cursor) ?? "undefined";
}

/** Where a job is, in words, from the pair and the finished list. */
function describeAt(current: [string, unknown] | undefined, completed: readonly string[]): string {
  if (current !== undefined) return `at '${current[0]}', cursor ${showCursor(current[1])}`;

  const last = completed[completed.length - 1];

  return last === undefined ? "not started" : `after '${last}'`;
}

/** The same, for a serialized state with no live Continuation behind it. */
function describe(state: ContinuationState): string {
  return describeAt(
    state.step === undefined ? undefined : [state.step, state.cursor],
    state.completed,
  );
}

/**
 * One step of a continuable job, as its body sees it. Rails'
 * `Continuation::Step`.
 */
export class Step {
  #cursor: unknown;

  readonly #initialCursor: unknown;

  constructor(
    readonly name: string,
    cursor: unknown,
    /** Whether this step is being picked up from an earlier attempt. */
    readonly resumed: boolean,
    private readonly onCheckpoint: () => void,
    private readonly onCursor: (cursor: unknown) => void,
  ) {
    this.#cursor = cursor;
    this.#initialCursor = cursor;
  }

  /**
   * Where this step got to last time, or undefined on the first run.
   *
   * Whatever `advance` was last given — an id, an offset, a page number. The
   * job decides what it means, because only the job knows how to start again
   * from it.
   */
  get cursor(): unknown {
    return this.#cursor;
  }

  /** Whether the cursor has moved during this attempt. Rails' `advanced?`. */
  get advanced(): boolean {
    return this.#cursor !== this.#initialCursor;
  }

  /** Records progress without checking whether to stop. Rails' `set!`. */
  set(cursor: unknown): void {
    this.#cursor = cursor;
    this.onCursor(cursor);
  }

  /**
   * Records progress and stops here if the worker is shutting down.
   *
   * The stopping check is on this call rather than on a timer: a job is
   * interruptible exactly where it says it is, and a step interrupted between
   * "charge the card" and "record the charge" is worse than one that runs a
   * minute past the deadline.
   */
  advance(cursor?: unknown): void {
    if (cursor !== undefined) this.set(cursor);

    this.checkpoint();
  }

  /**
   * Moves the cursor one past a value. Rails' `advance!(from:)`.
   *
   * The difference from `advance` is the one that matters on resume: `advance`
   * records the item just handled, so a job resuming from it must skip past it
   * itself. `advanceFrom` records the next item, so `where("id > ?", cursor)`
   * and `where("id >= ?", cursor)` stop being two ways to write the same
   * intention and one of them stops re-processing a record.
   *
   * Only numbers, because "one past" has no meaning for an arbitrary value and
   * guessing at one would put a wrong cursor in the queue rather than raise.
   */
  advanceFrom(from?: unknown): void {
    const base = from === undefined ? this.#cursor : from;

    if (typeof base === "number" && Number.isFinite(base)) {
      this.set(base + 1);
    } else if (typeof base === "bigint") {
      this.set(base + 1n);
    } else {
      throw new UnadvanceableCursorError(
        `Cursor ${JSON.stringify(base) ?? typeof base} cannot be advanced; pass the next value to advance() instead.`,
      );
    }

    this.checkpoint();
  }

  /** Stops the job here if the worker is shutting down. Rails' `checkpoint!`. */
  checkpoint(): void {
    this.onCheckpoint();
  }

  /** The `[name, cursor]` pair this step serializes as. Rails' `to_a`. */
  toA(): [string, unknown] {
    return [this.name, this.#cursor];
  }

  /** For a log line or an interrupt message. Rails' `description`. */
  get description(): string {
    return `at '${this.name}', cursor ${showCursor(this.#cursor)}`;
  }
}

/** Kept for callers that named the step argument's type. */
export type StepContext = Step;

/** What a continuation reports about itself when a step runs. */
export interface ContinuationInstrumentation {
  description: string;
  completedSteps: string[];
  currentStep: string | undefined;
}

/** Told what a continuation is doing, so a worker can log or count it. */
export interface ContinuationEvents {
  /** A step began running. Rails' `step_started`. */
  stepStarted?: (step: Step) => void;
  /** A step was passed over because an earlier attempt finished it. */
  stepSkipped?: (name: string) => void;
  /** The job stopped at a checkpoint. Rails' `interrupt`. */
  interrupt?: (reason: string, instrumentation: ContinuationInstrumentation) => void;
  /** The job picked up from an earlier attempt. Rails' `resume`. */
  resume?: (instrumentation: ContinuationInstrumentation) => void;
}

/** The running state of one continuable job. */
export class Continuation {
  readonly completed: Set<string>;

  /** The step that was interrupted last time, if any. */
  readonly resumingStep: string | undefined;
  readonly resumingCursor: unknown;

  /** How many times this job has been picked up. Rails' `resumptions`. */
  readonly resumptions: number;

  /** Steps seen this attempt, in order, so a changed order is caught. */
  readonly #encountered: string[] = [];

  #current: Step | undefined;
  #cursor: unknown;
  #advanced = false;
  #runningStep = false;

  constructor(
    state: ContinuationState | undefined,
    private readonly shouldStop: () => boolean = () => false,
    private readonly events: ContinuationEvents = {},
  ) {
    this.completed = new Set(state?.completed ?? []);
    this.resumingStep = state?.step;
    this.resumingCursor = state?.cursor;
    this.resumptions = state?.resumptions ?? 0;

    if (this.started) this.events.resume?.(this.instrumentation);
  }

  /** Whether the worker has asked for this job to stop. */
  get stopping(): boolean {
    return this.shouldStop();
  }

  /** Whether an earlier attempt got anywhere. Rails' `started?`. */
  get started(): boolean {
    return this.completed.size > 0 || this.resumingStep !== undefined;
  }

  /**
   * Whether this attempt has made progress. Rails' `advanced?`.
   *
   * A step finished, or the cursor moved inside one. What it is for: a job
   * that raises after advancing is worth resuming rather than retrying from
   * the top, because the work behind the cursor is done and re-doing it is the
   * cost this whole mechanism exists to avoid.
   */
  get advanced(): boolean {
    return this.#advanced || (this.#current?.advanced ?? false);
  }

  /** Where the job is, in words. Rails' `description`. */
  get description(): string {
    const { completed, current } = this.toH();

    return describeAt(current, completed);
  }

  /** What a log line or an event wants to say about the job. */
  get instrumentation(): ContinuationInstrumentation {
    return {
      description: this.description,
      completedSteps: [...this.completed],
      currentStep: this.toH().current?.[0],
    };
  }

  /** What to enqueue so this job resumes from here. */
  toState(): ContinuationState {
    const step = this.#current?.name;

    return {
      completed: [...this.completed],
      ...(step === undefined ? {} : { step }),
      ...(this.#cursor === undefined ? {} : { cursor: this.#cursor }),
      resumptions: this.resumptions,
    };
  }

  /**
   * The same progress with the current step as a `[name, cursor]` pair. Rails'
   * `to_h`.
   *
   * A pair rather than two optional fields because every caller that asks
   * "is the job at this exact point" — the interrupt test helpers below, a
   * dashboard row — is comparing name and cursor together, and comparing them
   * separately is where a cursor of `undefined` starts matching every step.
   */
  toH(): ContinuationHash {
    const current = this.#current?.toA() ?? this.#currentFromState();

    return {
      completed: [...this.completed],
      ...(current === undefined ? {} : { current }),
      resumptions: this.resumptions,
    };
  }

  /**
   * The step an earlier attempt was interrupted in, while it is still ahead of
   * us. Once this attempt has reached it, the live `Step` is the answer and
   * this stops reporting — otherwise a job that finished the resumed step
   * would go on claiming to be inside it.
   */
  #currentFromState(): [string, unknown] | undefined {
    if (this.resumingStep === undefined) return undefined;
    if (this.#encountered.includes(this.resumingStep)) return undefined;

    return [this.resumingStep, this.resumingCursor];
  }

  /** Stops the job here if the worker is shutting down. Rails' `checkpoint!`. */
  checkpoint(): void {
    if (this.stopping) this.interrupt();
  }

  /** Stops the job now, whatever the worker is doing. Rails' `interrupt!`. */
  interrupt(reason = "stopping"): never {
    this.events.interrupt?.(reason, this.instrumentation);

    throw new JobInterrupted(this.toState(), reason);
  }

  /**
   * Runs one step, unless a previous attempt already finished it.
   *
   * Checked before the step rather than after: a step that finished last time
   * must not run twice, and "did it finish" is the only question a resumed job
   * can answer about it.
   */
  async step(
    name: string,
    body: (step: Step) => unknown | Promise<unknown>,
    options: { start?: unknown } = {},
  ): Promise<void> {
    this.#validate(name);
    this.#encountered.push(name);

    if (this.completed.has(name)) {
      this.events.stepSkipped?.(name);

      return;
    }

    // A step may only be resumed if it is the one that was interrupted.
    // Carrying a cursor into a different step would hand it a position from
    // somebody else's list.
    const resumed = this.resumingStep === name;
    const cursor = resumed ? this.resumingCursor : options.start;

    const step = new Step(
      name,
      cursor,
      resumed,
      () => {
        this.checkpoint();
      },
      (to) => {
        this.#cursor = to;
      },
    );

    this.#current = step;
    this.#cursor = cursor;

    // Before the work as well as after: a job resumed onto a worker that is
    // already shutting down should stop rather than start a step it cannot
    // finish.
    this.checkpoint();

    this.#runningStep = true;
    this.events.stepStarted?.(step);

    try {
      await body(step);
    } finally {
      this.#runningStep = false;
      // Read before `#current` is cleared, so a step that moved its cursor and
      // then raised still counts as progress and is resumed rather than
      // retried from the top.
      this.#advanced ||= step.advanced;
    }

    this.completed.add(name);
    this.#current = undefined;
    this.#cursor = undefined;
    this.#advanced = true;
  }

  /**
   * Rails' `Continuation::Validation`, in the order it checks.
   *
   * Every one of these is a case where a resumed job would otherwise carry on
   * quietly against a step list that no longer lines up with the one it was
   * interrupted against.
   */
  #validate(name: string): void {
    if (this.#encountered.includes(name)) {
      throw new InvalidStepError(`Step '${name}' has already been encountered`);
    }

    if (this.#runningStep) {
      throw new InvalidStepError(
        `Step '${name}' is nested inside step '${this.#current?.name ?? "unknown"}'`,
      );
    }

    if (this.resumingStep !== undefined && !this.completed.has(name)) {
      // The interrupted step has to be the next one this attempt reaches. If
      // some other step comes first, the job took a different path and its
      // recorded cursor belongs to a step that is no longer where it was.
      if (this.#current === undefined && !this.#encountered.includes(this.resumingStep)) {
        if (name !== this.resumingStep) {
          throw new InvalidStepError(
            `Step '${name}' found, expected to resume from '${this.resumingStep}'`,
          );
        }
      }
    }

    const expected = [...this.completed][this.#encountered.length];

    if (expected !== undefined && expected !== name) {
      throw new InvalidStepError(`Step '${name}' found, expected to see '${expected}'`);
    }
  }
}

/**
 * How many resumptions a job is allowed before it is treated as stuck.
 *
 * Returns the number of resumptions used, so a caller can report it. Split out
 * of the worker so a test can drive the limit without a queue.
 */
export function checkResumeLimit(state: ContinuationState, max: number | undefined): number {
  const resumptions = state.resumptions ?? 0;

  if (max !== undefined && resumptions >= max) {
    throw new ResumeLimitError(`Job was resumed a maximum of ${String(max)} times`);
  }

  return resumptions;
}

/** The state to enqueue for the next attempt, one resumption further on. */
export function resumedState(state: ContinuationState): ContinuationState {
  return { ...state, resumptions: (state.resumptions ?? 0) + 1 };
}

/**
 * Stops a job the moment it reaches a given step with a given cursor. Rails'
 * `interrupt_job_during_step`.
 *
 * For testing the resume path, which is otherwise only reachable by racing a
 * real shutdown — so it either does not get tested or gets tested by a sleep.
 */
export function interruptDuringStep(
  step: string,
  cursor?: unknown,
): (continuation: Continuation) => boolean {
  return (continuation) => {
    const current = continuation.toH().current;

    return current !== undefined && current[0] === step && sameCursor(current[1], cursor);
  };
}

/**
 * Stops a job once a given step has finished. Rails'
 * `interrupt_job_after_step`.
 *
 * Note there is no checkpoint after the last step, so the last step cannot be
 * interrupted after — the job simply finishes.
 */
export function interruptAfterStep(step: string): (continuation: Continuation) => boolean {
  return (continuation) => {
    const { completed, current } = continuation.toH();

    return current === undefined && completed[completed.length - 1] === step;
  };
}

/** Cursors are compared by value, since an array cursor is the normal case. */
function sameCursor(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}
