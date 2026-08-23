/**
 * Recurring jobs, in place of Rails' `recurring.yml`.
 *
 * Rails 8 ships this in Solid Queue; before that everyone reached for a gem or
 * a crontab. Bun has a scheduler in the runtime, with the property that
 * matters: the next fire time is computed after the callback settles, so a job
 * that takes longer than its interval never stacks up behind itself.
 *
 *     const scheduler = new Scheduler({
 *       "clean up sessions": { cron: "0 * * * *", job: SweepSessionsJob },
 *     })
 *     scheduler.start()
 *
 * A schedule is a list of things that must happen once. Run the same schedule
 * on four servers and each one happens four times, which is why `lock` exists
 * and why it is the first thing documented rather than a footnote.
 */

import type { CacheStore } from "@altair/support";
import type { Job } from "./job.js";

/** What Bun hands back for a scheduled job. */
interface Scheduled {
  stop(): void;
  unref?(): void;
}

/** The scheduler primitive. Declared so this file states what it depends on. */
type CronFactory = (expression: string, callback: () => void | Promise<void>) => Scheduled;

export interface ScheduledTask {
  /** A five-field cron expression. */
  cron: string;
  /** The job to enqueue when it fires. */
  job: typeof Job;
  /** Arguments to enqueue it with. */
  args?: unknown[];
  /** Runs the job instead of enqueuing it. For work too small to be worth a queue. */
  performNow?: boolean;
}

export interface SchedulerOptions {
  /**
   * Makes a task run once across every process that shares the store.
   *
   * Without it, a schedule running on four servers happens four times. With
   * it, the first process to claim a fire time is the one that runs it.
   */
  lock?: CacheStore;
  /** How long a claim is held. Longer than the job takes, shorter than the interval. */
  lockFor?: number;
  /** Reports a task that threw, since a scheduler has nobody to return to. */
  onError?: (error: unknown, name: string) => void;
  /** Swapped in tests. Defaults to Bun's scheduler. */
  cron?: CronFactory;
  /** Used for the lock key, so two schedules cannot claim each other's slots. */
  now?: () => number;
}

/** Raised when a cron expression is not one the scheduler can read. */
export class InvalidCronExpression extends Error {
  constructor(expression: string) {
    super(`"${expression}" is not a five-field cron expression.`);
    this.name = "InvalidCronExpression";
  }
}

/**
 * A quick shape check, so a typo is caught when the schedule is declared.
 *
 * ponytail: counts the fields and checks the characters. Bun parses the
 * expression properly when the job is registered; this is only here to fail at
 * the declaration rather than at the first fire.
 */
export function isCronExpression(expression: string): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  return fields.every((field) => /^[\d*,\-/]+$/.test(field));
}

/** The key one fire of one task claims. */
export function lockKey(name: string, at: number, window: number): string {
  return `schedule/${name}/${Math.floor(at / 1000 / window)}`;
}

export class Scheduler {
  readonly tasks: Readonly<Record<string, ScheduledTask>>;

  #running: Scheduled[] = [];
  #options: SchedulerOptions;

  constructor(tasks: Record<string, ScheduledTask>, options: SchedulerOptions = {}) {
    for (const [name, task] of Object.entries(tasks)) {
      if (!isCronExpression(task.cron)) throw new InvalidCronExpression(task.cron);
      void name;
    }

    this.tasks = tasks;
    this.#options = options;
  }

  get isRunning(): boolean {
    return this.#running.length > 0;
  }

  /**
   * Claims one fire of one task.
   *
   * The claim is keyed by the task and the slot it fired in, so two processes
   * waking at the same second contend for the same key and exactly one wins.
   * Without a store there is nothing to contend over and every process runs.
   */
  async claim(name: string, at: number = Date.now()): Promise<boolean> {
    const store = this.#options.lock;
    if (!store) return true;

    const window = this.#options.lockFor ?? 60;
    const key = lockKey(name, at, window);

    // increment is the atomic one: whoever gets 1 back is the one that
    // created it, and everybody else sees a larger number. The expiry travels
    // with it, so a second process cannot reset the claim by writing the
    // window separately.
    return (await store.increment(key, 1, { expiresIn: window })) === 1;
  }

  /** Runs one task now, whether or not it is scheduled. */
  async run(name: string): Promise<void> {
    const task = this.tasks[name];
    if (!task) throw new Error(`No scheduled task named "${name}".`);

    const at = (this.#options.now ?? Date.now)();
    if (!(await this.claim(name, at))) return;

    const args = task.args ?? [];
    if (task.performNow) await task.job.performNow(...args);
    else await task.job.performLater(...args);
  }

  /** Registers every task with the scheduler. */
  start(): this {
    if (this.isRunning) return this;

    const cron = this.#options.cron ?? (Bun.cron as unknown as CronFactory);

    for (const name of Object.keys(this.tasks)) {
      const task = this.tasks[name]!;

      this.#running.push(
        cron(task.cron, async () => {
          try {
            await this.run(name);
          } catch (error) {
            // A scheduler has nobody to return an error to, and Bun would
            // reschedule after an unhandled rejection anyway — reporting it
            // beats letting it reach the process handler unlabelled.
            this.#options.onError?.(error, name);
          }
        }),
      );
    }

    return this;
  }

  /** Unregisters everything. */
  stop(): void {
    for (const scheduled of this.#running) scheduled.stop();
    this.#running = [];
  }

  /** Lets the process exit even with tasks registered. */
  unref(): this {
    for (const scheduled of this.#running) scheduled.unref?.();
    return this;
  }
}
