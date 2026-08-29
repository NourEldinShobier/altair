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

/** Thrown inside a job to stop it at a checkpoint. Caught by the runner. */
export class JobInterrupted extends Error {
  constructor(readonly continuation: ContinuationState) {
    super("The job was interrupted at a checkpoint and will resume.");
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
}

/** What a step body is handed. */
export interface StepContext {
  readonly name: string;
  /**
   * Where this step got to last time, or undefined on the first run.
   *
   * Whatever `advance` was last given — an id, an offset, a page number. The
   * job decides what it means, because only the job knows how to start again
   * from it.
   */
  readonly cursor: unknown;
  /**
   * Records progress and stops here if the worker is shutting down.
   *
   * The stopping check is on this call rather than on a timer: a job is
   * interruptible exactly where it says it is, and a step interrupted between
   * "charge the card" and "record the charge" is worse than one that runs a
   * minute past the deadline.
   */
  advance(cursor?: unknown): Promise<void>;
  /** Records progress without checking whether to stop. */
  set(cursor: unknown): void;
}

/** The running state of one continuable job. */
export class Continuation {
  readonly completed: Set<string>;

  /** The step that was interrupted last time, if any. */
  readonly resumingStep: string | undefined;
  readonly resumingCursor: unknown;

  #currentStep: string | undefined;
  #cursor: unknown;

  constructor(
    state: ContinuationState | undefined,
    private readonly shouldStop: () => boolean = () => false,
  ) {
    this.completed = new Set(state?.completed ?? []);
    this.resumingStep = state?.step;
    this.resumingCursor = state?.cursor;
  }

  /** Whether the worker has asked for this job to stop. */
  get stopping(): boolean {
    return this.shouldStop();
  }

  /** What to enqueue so this job resumes from here. */
  toState(): ContinuationState {
    return {
      completed: [...this.completed],
      ...(this.#currentStep === undefined ? {} : { step: this.#currentStep }),
      ...(this.#cursor === undefined ? {} : { cursor: this.#cursor }),
    };
  }

  /** Stops the job here if the worker is shutting down. Rails' `checkpoint!`. */
  checkpoint(): void {
    if (this.stopping) throw new JobInterrupted(this.toState());
  }

  /**
   * Runs one step, unless a previous attempt already finished it.
   *
   * Checked before the step rather than after: a step that finished last time
   * must not run twice, and "did it finish" is the only question a resumed job
   * can answer about it.
   */
  async step(name: string, body: (step: StepContext) => unknown | Promise<unknown>): Promise<void> {
    if (this.completed.has(name)) return;

    // A step may only be resumed if it is the one that was interrupted.
    // Carrying a cursor into a different step would hand it a position from
    // somebody else's list.
    let cursor = this.resumingStep === name ? this.resumingCursor : undefined;

    this.#currentStep = name;
    this.#cursor = cursor;

    // Before the work as well as after: a job resumed onto a worker that is
    // already shutting down should stop rather than start a step it cannot
    // finish.
    this.checkpoint();

    const record = (to: unknown) => {
      cursor = to;
      this.#cursor = to;
    };

    const context: StepContext = {
      name,
      // A closure over the local rather than a read of the private field, so
      // the getter needs no `this` of its own and stays live as `advance`
      // moves it.
      get cursor() {
        return cursor;
      },
      advance: async (to?: unknown) => {
        if (to !== undefined) record(to);
        this.checkpoint();
      },
      set: record,
    };

    await body(context);

    this.completed.add(name);
    this.#currentStep = undefined;
    this.#cursor = undefined;
  }
}
