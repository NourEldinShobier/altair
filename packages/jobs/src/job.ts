/**
 * Background jobs, ported from `ActiveJob`.
 *
 * A job is a class with a `perform` method, enqueued by class rather than by
 * closure — which is what lets it survive a process restart:
 *
 *     class WelcomeEmail extends Job<[userId: number]> {
 *       async perform(userId: number) { ... }
 *     }
 *
 *     await WelcomeEmail.performLater(7)
 *     await WelcomeEmail.set({ wait: 60 }).performLater(7)
 *
 * Arguments are serialized, so they must be JSON. Rails has the same rule and
 * the same reason: the worker that runs the job is not the process that
 * enqueued it, and may not exist yet.
 */

import { runCallbacks, Callbacks, callbackDecorators } from "@altair/support";
import { afterCommit, isDeferring } from "@altair/orm";

const {
  before: beforePerform,
  around: aroundPerform,
  after: afterPerform,
} = callbackDecorators("perform");

export { beforePerform, aroundPerform, afterPerform };

export interface JobPayload {
  id: string;
  /** The registered name of the job class. */
  jobClass: string;
  arguments: unknown[];
  queue: string;
  /** Epoch milliseconds before which the job must not run. */
  runAt: number;
  attempts: number;
  enqueuedAt: number;
}

export interface EnqueueOptions {
  /**
   * Whether to wait for the surrounding transaction before enqueueing.
   *
   * On by default, and worth leaving on. Turn it off only for a job that must
   * be visible to a worker regardless of what the transaction does — which is
   * rarer than it sounds, since a job that runs against uncommitted data
   * cannot see it either.
   */
  enqueueAfterCommit?: boolean;
  /** Seconds to wait before the job becomes runnable. Rails' `wait`. */
  wait?: number;
  /** Run at a specific time. Rails' `wait_until`. */
  waitUntil?: Date;
  queue?: string;
}

export interface RetryPolicy {
  /** How many times to run the job in total, including the first attempt. */
  attempts: number;
  /** Seconds before the next attempt, given the attempt number. */
  backoff: (attempt: number) => number;
}

/** Rails' default: retry with a growing wait rather than hammering. */
export const DEFAULT_RETRY: RetryPolicy = {
  attempts: 5,
  // 3s, 18s, 83s, 258s — Rails' polynomial backoff, which spreads retries out
  // fast enough that a failing dependency is not retried into the ground.
  backoff: (attempt) => attempt ** 4 + 3,
};

/** Raised when a job class is enqueued but the worker cannot find it. */
export class UnknownJob extends Error {
  constructor(name: string) {
    super(
      `No job registered as "${name}". Register it with Job.register() so a worker can find it after a restart.`,
    );
    this.name = "UnknownJob";
  }
}

/** Where a queue adapter stores and hands out work. */
export interface QueueAdapter {
  enqueue(payload: JobPayload): Promise<void>;
  /** The next runnable job, or null. Must not return a job whose runAt is future. */
  dequeue(queue: string): Promise<JobPayload | null>;
  /** Number of jobs waiting, for tests and monitoring. */
  size(queue: string): Promise<number>;
}

const REGISTRY = new Map<string, typeof Job>();

export class Job<Args extends unknown[] = unknown[]> extends Callbacks {
  /** The queue this class enqueues to. Rails' `queue_as`. */
  static queueName = "default";
  static retryPolicy: RetryPolicy = DEFAULT_RETRY;
  static adapter: QueueAdapter | undefined;

  static {
    this.defineCallbacks("perform");
  }

  /**
   * Registers the class under a name a worker can resolve.
   *
   * A job is enqueued by name, so the worker needs to map that name back to a
   * class. Rails does this with constant lookup, which needs the class already
   * loaded; registering makes the dependency explicit.
   */
  static register(...classes: (typeof Job)[]): void {
    for (const klass of classes) REGISTRY.set(klass.jobName, klass);
  }

  static get jobName(): string {
    return this.name;
  }

  static lookup(name: string): typeof Job {
    const klass = REGISTRY.get(name);
    if (!klass) throw new UnknownJob(name);
    return klass;
  }

  /** Clears the registry. Used by tests. */
  static resetRegistry(): void {
    REGISTRY.clear();
  }

  static get queue(): QueueAdapter {
    if (!this.adapter) {
      throw new Error("No queue adapter configured. Set Job.adapter before enqueuing.");
    }
    return this.adapter;
  }

  /** Runs the job now, in this process. Rails' `perform_now`. */
  static async performNow<A extends unknown[]>(
    this: { new (): { perform(...args: A): unknown } },
    ...args: A
  ): Promise<unknown> {
    const job = new this();
    return await runCallbacks(job, "perform", async () => await job.perform(...args));
  }

  /** Enqueues the job. Rails' `perform_later`. */
  static async performLater(...args: unknown[]): Promise<JobPayload> {
    return await this.enqueueWith({}, args);
  }

  /**
   * Enqueues with options. Rails' `set(wait: 5.minutes).perform_later`.
   *
   * Returns an object with `performLater` so the call reads the same way.
   */
  static set(options: EnqueueOptions): {
    performLater: (...args: unknown[]) => Promise<JobPayload>;
  } {
    return {
      performLater: (...args: unknown[]) => this.enqueueWith(options, args),
    };
  }

  static async enqueueWith(options: EnqueueOptions, args: unknown[]): Promise<JobPayload> {
    // Serializing here rather than at dequeue time means an unserializable
    // argument fails at the call site, where the stack trace is useful.
    assertSerializable(args, this.jobName);

    const payload: JobPayload = {
      id: crypto.randomUUID(),
      jobClass: this.jobName,
      arguments: args,
      queue: options.queue ?? this.queueName,
      runAt: runAtFor(options),
      attempts: 0,
      enqueuedAt: Date.now(),
    };

    // Deferred until the transaction commits, which Rails made the default in
    // 7.2 because the alternative kept biting people. A job enqueued inside a
    // transaction is enqueued whether or not it commits, so a rollback hands a
    // worker the id of a row that never existed — and a worker can pick it up
    // before the commit lands, when the row is genuinely not there yet.
    //
    // Not routed through `afterCommit`'s own immediate path: outside a
    // transaction an enqueue that fails has to reach the caller, who is still
    // there to hear it. Inside one it cannot — they returned long ago — so it
    // goes to the error reporter instead.
    if ((options.enqueueAfterCommit ?? true) && isDeferring()) {
      await afterCommit(async () => {
        await this.queue.enqueue(payload);
      });

      return payload;
    }

    await this.queue.enqueue(payload);
    return payload;
  }

  /** Override with the work. */
  async perform(...args: Args): Promise<unknown> {
    void args;
    throw new Error(`${this.constructor.name} does not implement perform().`);
  }
}

function runAtFor(options: EnqueueOptions): number {
  if (options.waitUntil) return options.waitUntil.getTime();
  if (options.wait !== undefined) return Date.now() + options.wait * 1000;
  return Date.now();
}

/**
 * Checks that arguments survive a round trip.
 *
 * A job is run by another process, possibly after a deploy, so anything that
 * cannot be written down cannot be an argument. Failing here beats failing in
 * a worker at 3am with no context.
 */
export function assertSerializable(args: unknown[], jobName: string): void {
  for (const [index, arg] of args.entries()) {
    if (arg === undefined) continue;
    if (typeof arg === "function" || typeof arg === "symbol" || typeof arg === "bigint") {
      throw new TypeError(
        `${jobName} cannot take a ${typeof arg} as argument ${index}: job arguments must survive being written to the queue.`,
      );
    }
    if (typeof arg === "object" && arg !== null) {
      try {
        JSON.stringify(arg);
      } catch {
        throw new TypeError(
          `${jobName} argument ${index} cannot be serialized. Pass an id and load the record in perform().`,
        );
      }
    }
  }
}
