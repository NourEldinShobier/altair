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

import {
  runCallbacks,
  Callbacks,
  callbackDecorators,
  currentEnvironment,
  type Environment,
} from "@altair/support";
import { InlineQueue, MemoryQueue } from "./worker.js";
import { afterCommit, isDeferring } from "@altair/orm";

const {
  before: beforePerform,
  around: aroundPerform,
  after: afterPerform,
} = callbackDecorators("perform");

/**
 * Callbacks around the enqueue rather than around the run.
 *
 * Rails' `before_enqueue`, `around_enqueue`, `after_enqueue`. They run in the
 * process that decided to enqueue, where the request that caused it is still
 * in scope — which is the point. A `beforePerform` runs in a worker minutes
 * later with none of that, so anything that needs to know who asked has to
 * happen here.
 *
 * A `beforeEnqueue` that throws stops the enqueue, and the error reaches the
 * caller: they are still there to hear it.
 */
const {
  before: beforeEnqueue,
  around: aroundEnqueue,
  after: afterEnqueue,
} = callbackDecorators("enqueue");

export { beforePerform, aroundPerform, afterPerform };
export { beforeEnqueue, aroundEnqueue, afterEnqueue };

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
  /**
   * Which job runs first when several are due. Lower goes first, as `nice`
   * does and as every queue that has one reads it.
   *
   * Defaults to 0. Without it a password reset waits behind whatever the
   * nightly batch enqueued, because the only order was the order they arrived
   * in.
   */
  priority: number;
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
  /** Lower runs first. Overrides the class's own for this enqueue. */
  priority?: number;
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

/** Something a `catch` can test against — a class, or a predicate. */
export type ErrorMatcher = (new (...args: never[]) => Error) | ((error: unknown) => boolean);

/** One rule about what a particular failure means. */
export interface ErrorRule {
  matches: ErrorMatcher;
  /** Absent for a discard: there is nothing to wait for. */
  policy?: RetryPolicy;
}

/**
 * Whether a rule covers this error.
 *
 * A class is tested with `instanceof` and anything else is called, so a rule
 * can key off a status code or a message when the failure does not have a
 * class of its own — which, for anything that came back over HTTP, it usually
 * does not.
 */
export function matchesError(matcher: ErrorMatcher, error: unknown): boolean {
  // A class has a prototype it did not inherit; an arrow function does not.
  // Calling a class without `new` throws, so telling them apart matters.
  const isClass = typeof matcher === "function" && matcher.prototype !== undefined;

  if (isClass) return error instanceof (matcher as new (...args: never[]) => Error);

  return (matcher as (error: unknown) => boolean)(error);
}

/**
 * A class's own rules, copying the parent's on first write.
 *
 * Without the copy a subclass pushing a rule would add it to whatever class
 * declared the array, and every sibling job would inherit it.
 *
 * A function rather than a static private method: a static `#member` belongs
 * to the class that declared it, and `this` inside a subclass's static block
 * is the subclass — which throws rather than inheriting.
 */
function rulesFor(klass: typeof Job): ErrorRule[] {
  if (!Object.hasOwn(klass, "errorRules")) klass.errorRules = [...klass.errorRules];

  return klass.errorRules;
}

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
  /**
   * Every payload at once, for an adapter that can do better than a loop.
   *
   * Optional: `performAllLater` falls back to enqueuing one at a time, which
   * is correct and slower. The difference is throughput, never whether the
   * jobs were enqueued.
   */
  enqueueAll?(payloads: JobPayload[]): Promise<void>;
}

/** A job described but not yet enqueued, for `performAllLater`. */
export interface PendingJob {
  payload: JobPayload;
}

const REGISTRY = new Map<string, typeof Job>();

/** The environment's adapter, made once and shared. See `Job.queue`. */
let FALLBACK_ADAPTER: QueueAdapter | undefined;

/** Forgets the environment's adapter, so a test can start from nothing. */
export function resetDefaultAdapter(): void {
  FALLBACK_ADAPTER = undefined;
}

export class Job<Args extends unknown[] = unknown[]> extends Callbacks {
  /** The queue this class enqueues to. Rails' `queue_as`. */
  static queueName = "default";
  /** What this class enqueues at. Rails' `queue_with_priority`. */
  static priority = 0;
  static retryPolicy: RetryPolicy = DEFAULT_RETRY;
  static adapter: QueueAdapter | undefined;
  /** Per-error rules, first match wins. Rails' `retry_on` and `discard_on`. */
  static errorRules: ErrorRule[] = [];

  /**
   * What is about to be enqueued, for an `enqueue` callback to read.
   *
   * Only set on the instance the callbacks run on: a job that is performing
   * was built from a payload rather than about to become one.
   */
  declare payload?: JobPayload;

  static {
    this.defineCallbacks(["perform", "enqueue"]);
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
    // Not cached onto `this`: a subclass assigning here would create its own
    // static and stop seeing anything later set on `Job`, which is the same
    // copy-on-write trap the callback and validation statics avoid. The
    // fallback is one per process instead, so what a test enqueues and what it
    // asserts on are the same queue.
    return this.adapter ?? (FALLBACK_ADAPTER ??= defaultAdapter());
  }

  /**
   * Retries this error differently from the rest. Rails' `retry_on`.
   *
   *     class ChargeCard extends Job {
   *       static { this.retryOn(RateLimited, { attempts: 10, wait: 60 }) }
   *     }
   *
   * Rules are tried in the order they are declared and the first match wins,
   * so a specific error goes above a general one.
   */
  static retryOn(
    matches: ErrorMatcher,
    options: { attempts?: number; wait?: number | ((attempt: number) => number) } = {},
  ): void {
    const wait = options.wait ?? DEFAULT_RETRY.backoff;

    rulesFor(this).push({
      matches,
      policy: {
        attempts: options.attempts ?? DEFAULT_RETRY.attempts,
        backoff: typeof wait === "function" ? wait : () => wait,
      },
    });
  }

  /**
   * Gives up on this error at once. Rails' `discard_on`.
   *
   * For a failure that will not come right on its own: the record was deleted,
   * the argument no longer deserializes, the remote said 404. Retrying one of
   * those five times with a growing wait fills the queue and the error
   * tracker with work that was never going to succeed.
   */
  static discardOn(matches: ErrorMatcher): void {
    rulesFor(this).push({ matches });
  }

  /**
   * What to do about a failure: a policy to retry under, or null to discard.
   *
   * Falls back to the class's `retryPolicy` when no rule matches, which is the
   * behaviour every job had before rules existed.
   */
  static policyFor(error: unknown): RetryPolicy | null {
    const rule = this.errorRules.find((candidate) => matchesError(candidate.matches, error));

    if (rule) return rule.policy ?? null;

    return this.retryPolicy ?? DEFAULT_RETRY;
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
  /**
   * The named callback helpers, which is how Rails is written.
   *
   * `setCallback("perform", "before", fn)` says the same thing; these are what
   * appears in an application, and the difference between reading a name and
   * reading a pair of string arguments is the difference between knowing what
   * a line does and going to check.
   */
  static beforePerform(callback: Parameters<typeof Job.setCallback>[2]): void {
    this.setCallback("perform", "before", callback);
  }

  static afterPerform(callback: Parameters<typeof Job.setCallback>[2]): void {
    this.setCallback("perform", "after", callback);
  }

  static aroundPerform(callback: Parameters<typeof Job.setCallback>[2]): void {
    this.setCallback("perform", "around", callback);
  }

  static beforeEnqueue(callback: Parameters<typeof Job.setCallback>[2]): void {
    this.setCallback("enqueue", "before", callback);
  }

  static afterEnqueue(callback: Parameters<typeof Job.setCallback>[2]): void {
    this.setCallback("enqueue", "after", callback);
  }

  static aroundEnqueue(callback: Parameters<typeof Job.setCallback>[2]): void {
    this.setCallback("enqueue", "around", callback);
  }

  /**
   * The queue this job goes on. Rails' `queue_as`.
   *
   * A declaration rather than a value passed at every call site: which queue a
   * job belongs on is a property of the job, and saying it once is what stops
   * half the calls putting it somewhere else.
   */
  static queueAs(name: string): void {
    this.queueName = name;
  }

  /** The priority this job goes on with. Rails' `queue_with_priority`. */
  static queueWithPriority(priority: number): void {
    this.priority = priority;
  }

  /** The adapter's own name, for a log line that has to say where a job went. */
  static get queueAdapterName(): string {
    return this.queue.constructor.name;
  }

  static set(options: EnqueueOptions): {
    performLater: (...args: unknown[]) => Promise<JobPayload>;
  } {
    return {
      performLater: (...args: unknown[]) => this.enqueueWith(options, args),
    };
  }

  /**
   * Enqueues several jobs in one go. Rails 7.1's `perform_all_later`.
   *
   *     await Job.performAllLater(
   *       ChargeCard.later(order.id),
   *       SendReceipt.later(order.id),
   *     )
   *
   * A hundred jobs enqueued in a loop is a hundred round trips, and the loop
   * is the obvious way to write it.
   *
   * The enqueue callbacks do not run, which is what Rails does and is worth
   * knowing before reaching for this: a `beforeEnqueue` that refuses a job, or
   * an `afterEnqueue` that records one, is skipped for everything in the
   * batch. A job that depends on either should be enqueued on its own.
   */
  static async performAllLater(...jobs: PendingJob[]): Promise<JobPayload[]> {
    const payloads = jobs.map((job) => job.payload);
    if (payloads.length === 0) return [];

    const queue = this.queue;

    if (queue.enqueueAll) await queue.enqueueAll(payloads);
    else for (const payload of payloads) await queue.enqueue(payload);

    return payloads;
  }

  /**
   * Describes a job without enqueueing it, for `performAllLater`.
   *
   * `performLater` cannot be used here: it enqueues as it builds, and the
   * point of a batch is that nothing is written until all of them are ready.
   */
  static later(...args: unknown[]): PendingJob {
    assertSerializable(args, this.jobName);

    return { payload: this.buildPayload({}, args) };
  }

  /** The payload an enqueue would write, without writing it. */
  static buildPayload(options: EnqueueOptions, args: unknown[]): JobPayload {
    // Every path that makes a payload comes through here, so this is the one
    // place registration cannot be missed. A job is enqueued by name and
    // something on the other end has to turn that name back into a class;
    // leaving it to the application means the failure waits until a worker
    // picks the job up, in another process, possibly after a deploy.
    this.register(this as unknown as typeof Job);

    return {
      id: crypto.randomUUID(),
      jobClass: this.jobName,
      arguments: args,
      queue: options.queue ?? this.queueName,
      runAt: runAtFor(options),
      attempts: 0,
      enqueuedAt: Date.now(),
      priority: options.priority ?? this.priority,
    };
  }

  static async enqueueWith(options: EnqueueOptions, args: unknown[]): Promise<JobPayload> {
    // Serializing here rather than at dequeue time means an unserializable
    // argument fails at the call site, where the stack trace is useful.
    assertSerializable(args, this.jobName);

    const payload = this.buildPayload(options, args);

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
    // The callbacks wrap the enqueue itself rather than this method, so
    // `afterEnqueue` runs after the adapter took it and not before. Inside a
    // transaction that is at commit time, which is also when a `beforeEnqueue`
    // that throws can no longer reach the caller — the same trade the deferred
    // enqueue already makes, and for the same reason.
    const enqueue = async () => {
      const job = new this() as unknown as { payload: JobPayload };
      job.payload = payload;

      await runCallbacks(job, "enqueue", async () => {
        await this.queue.enqueue(payload);
      });
    };

    if ((options.enqueueAfterCommit ?? true) && isDeferring()) {
      await afterCommit(enqueue);

      return payload;
    }

    await enqueue();
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

/**
 * The adapter an environment gets when nothing says otherwise.
 *
 * Rails defaults `queue_adapter` per environment so a generated application
 * can enqueue on the first day. The same here, and chosen so that neither
 * default can lose work: test collects, so a case can assert on what was
 * enqueued; development runs the job then and there, so nothing sits in a
 * queue nobody is draining.
 *
 * Production refuses. Its jobs have to outlive the process that enqueued them,
 * and every default here is in memory.
 */
export function defaultAdapter(env: Environment = currentEnvironment()): QueueAdapter {
  if (env === "test") return new MemoryQueue();
  if (env === "development") return new InlineQueue();

  throw new Error(
    "No queue adapter configured. Set Job.adapter to a DatabaseQueue, a RedisQueue, or your own.",
  );
}
