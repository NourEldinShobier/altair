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

import { Continuation, Step, type ContinuationState, type StepContext } from "./continuable.js";
import { serializeArguments } from "./serializers.js";
import { bulkEnqueued, enqueueAt, successfullyEnqueued } from "./events.js";
import {
  runCallbacks,
  Callbacks,
  callbackDecorators,
  currentEnvironment,
  errors,
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

/**
 * An adapter refusing a job, as opposed to failing at one. Rails'
 * `ActiveJob::EnqueueError`.
 *
 * The distinction is the whole feature. A queue that is full, is read-only, or
 * has rejected the payload has *answered*; a driver that threw a TypeError has
 * not. Rails hands the first back to the caller as a job that did not enqueue
 * and lets the second escape, because one of them is a condition an
 * application can be written to expect and the other is a bug.
 *
 * An adapter raises this to say "I did not take it". Anything else it throws
 * still reaches the caller unchanged.
 */
export class EnqueueError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EnqueueError";
  }
}

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
  /**
   * Whether the adapter took it. Rails' `successfully_enqueued?`.
   *
   * False only where the adapter refused with an `EnqueueError`; a job that
   * fails for any other reason throws instead of answering.
   *
   * Rails returns `false` from `perform_later` for this. Returning the payload
   * either way and putting the answer on it says the same thing without a
   * union return type, and leaves the reason attached to the thing it is about
   * rather than needing a second call to find it.
   */
  successfullyEnqueued?: boolean;
  /** Why the adapter refused, when it did. Rails' `enqueue_error`. */
  enqueueError?: EnqueueError;
  /**
   * How many times each retry rule has caught something. Rails'
   * `exception_executions`.
   *
   * One budget per rule rather than one for the job, which is the only reading
   * of `retryOn(Timeout, { attempts: 3 })` that means what it says. Shared, the
   * three tries written against `Timeout` are spent by whatever failed first,
   * and the job gives up on the failure that would have come right.
   *
   * Absent on a job that has never failed, and on one whose failure matched no
   * rule — there is no budget to name, so the total is what counts.
   */
  exceptionExecutions?: Record<string, number>;
  /**
   * What a continuable job finished before it was interrupted.
   *
   * Absent on a job that has never been interrupted, which is nearly all of
   * them — a payload that carried an empty one would put the machinery in
   * every queue row for the benefit of the few jobs that use it.
   */
  continuation?: ContinuationState;
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
  /**
   * Which budget this rule spends, carried in the payload between attempts.
   *
   * Named after the error rather than numbered by declaration order, so
   * inserting a rule above another does not hand a running job the wrong
   * count. Rails keys on the exception list for the same reason.
   */
  key: string;
}

/**
 * A name for the budget a rule spends.
 *
 * A class matcher has one already. A predicate usually does not — an arrow
 * function assigned to nothing is anonymous — so it falls back to its position,
 * which is stable for as long as the rules are.
 */
function ruleKey(matches: ErrorMatcher, existing: readonly ErrorRule[]): string {
  const name = matches.name !== "" ? matches.name : `rule${String(existing.length)}`;
  const taken = existing.filter((rule) => rule.key === name || rule.key.startsWith(`${name}#`));

  // Two rules named the same are a mistake, but a silent shared budget is a
  // worse one than a rule that is hard to read about in a log line.
  return taken.length === 0 ? name : `${name}#${String(taken.length + 1)}`;
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
   * How many times this job may be resumed before it is treated as stuck.
   * Rails' `max_resumptions`. Undefined means no limit, as in Rails.
   *
   * Worth setting on any continuable job whose steps are not certain to fit
   * inside the shutdown window: such a job is interrupted on every attempt and
   * re-enqueues itself for ever, which looks from the outside like a queue
   * that is busy rather than one that is stuck.
   */
  static maxResumptions: number | undefined = undefined;

  /**
   * What is about to be enqueued, for an `enqueue` callback to read.
   *
   * Only set on the instance the callbacks run on: a job that is performing
   * was built from a payload rather than about to become one.
   */
  declare payload?: JobPayload;

  /**
   * Set by the runner for a job that is being performed. Rails' continuation.
   *
   * Absent when a job is performed directly, so `step` outside a worker simply
   * runs every step in order — which is what a test wants, and what makes a
   * continuable job no harder to call than any other.
   */
  declare continuation?: Continuation;

  static {
    this.defineCallbacks(["perform", "enqueue"]);
  }

  /**
   * Runs a named piece of work once across every attempt. Rails' `step`.
   *
   *     await this.step("process", async (step) => {
   *       for (const id of await pending(step.cursor)) {
   *         await handle(id)
   *         await step.advance(id)
   *       }
   *     })
   *
   * A step that finished on an earlier attempt is skipped; the one that was
   * interrupted resumes from the cursor it last recorded. Outside a worker
   * there is nothing to resume from and every step simply runs.
   */
  async step(
    name: string,
    body: (step: StepContext) => unknown | Promise<unknown>,
    options: { start?: unknown } = {},
  ): Promise<void> {
    if (this.continuation) return await this.continuation.step(name, body, options);

    // A real Step rather than a stand-in, so a body that asks whether it was
    // resumed, or advances its cursor, behaves the same when the job is called
    // straight from a test as it does under a worker. Its checkpoints do
    // nothing and its cursor goes nowhere, because there is no next attempt.
    await body(new Step(name, options.start, false, noop, noop));
  }

  /**
   * Stops here if the worker is shutting down. Rails' `checkpoint!`.
   *
   * For the work between steps, and for a step whose progress is not a cursor.
   * Does nothing outside a worker.
   */
  checkpoint(): void {
    this.continuation?.checkpoint();
  }

  /** Whether the worker has asked this job to stop. Rails' `stopping?`. */
  get stopping(): boolean {
    return this.continuation?.stopping ?? false;
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

    const rules = rulesFor(this);

    rules.push({
      matches,
      key: ruleKey(matches, rules),
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
    const rules = rulesFor(this);

    rules.push({ matches, key: ruleKey(matches, rules) });
  }

  /**
   * What to do about a failure: a policy to retry under, or null to discard.
   *
   * Falls back to the class's `retryPolicy` when no rule matches, which is the
   * behaviour every job had before rules existed.
   */
  static policyFor(error: unknown): RetryPolicy | null {
    return this.ruleFor(error).policy;
  }

  /**
   * What to do about this failure, and which budget it comes out of.
   *
   * A `key` of undefined means no rule matched and the class default applies,
   * so there is nothing to keep a separate count for and the job's own total
   * is the count.
   */
  static ruleFor(error: unknown): { policy: RetryPolicy | null; key?: string } {
    const rule = this.errorRules.find((candidate) => matchesError(candidate.matches, error));

    if (rule) return { policy: rule.policy ?? null, key: rule.key };

    return { policy: this.retryPolicy ?? DEFAULT_RETRY };
  }

  /** Runs the job now, in this process. Rails' `perform_now`. */
  static async performNow<A extends unknown[]>(
    this: { new (): { perform(...args: A): unknown } },
    ...args: A
  ): Promise<unknown> {
    const job = new this();
    return await runCallbacks(job, "perform", async () => await job.perform(...args));
  }

  /**
   * The same, with the state a continuable job resumes from.
   *
   * Separate from `performNow` so calling a job directly stays a one-liner:
   * the continuation is the runner's business, and a test that just wants the
   * job to run should not have to construct one.
   */
  static async performNowWith<A extends unknown[]>(
    this: { new (): { perform(...args: A): unknown; continuation?: Continuation } },
    continuation: Continuation,
    ...args: A
  ): Promise<unknown> {
    const job = new this();
    job.continuation = continuation;

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

    bulkEnqueued(payloads);

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
      // Serialized on the way in rather than left to JSON. A Date through
      // `JSON.stringify` and back is a string, and a job that took a date
      // yesterday takes a string today — which throws inside a worker, hours
      // after the code that enqueued it looked fine.
      arguments: serializeArguments(args),
      queue: options.queue ?? this.queueName,
      runAt: runAtFor(options),
      attempts: 0,
      enqueuedAt: Date.now(),
      priority: options.priority ?? this.priority,
      // False until the adapter has taken it, so a payload that never reached
      // an adapter at all reads the same as one that was refused.
      successfullyEnqueued: false,
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

      try {
        await runCallbacks(job, "enqueue", async () => {
          await this.queue.enqueue(payload);
        });
      } catch (error) {
        // Only a refusal. Anything else is a bug in the adapter or the
        // callbacks, and swallowing it here would turn a broken queue into a
        // queue that quietly accepts nothing.
        if (!(error instanceof EnqueueError)) throw error;

        payload.enqueueError = error;

        return;
      }

      payload.successfullyEnqueued = true;

      // After the adapter took it, so nothing announces work that was never
      // queued. A scheduled job is announced separately: how much work is
      // arriving and how much is waiting are different questions, and a
      // dashboard adding them together reports a backlog that is not one.
      if (payload.runAt > Date.now()) enqueueAt(payload, payload.runAt);
      else successfullyEnqueued(payload);
    };

    if ((options.enqueueAfterCommit ?? true) && isDeferring()) {
      await afterCommit(async () => {
        await enqueue();

        // Nobody is left to read the payload: the caller returned when the
        // transaction was still open. A refusal that only sets a field would
        // be a job that vanished, so out here it is reported like any other
        // failure the caller cannot be told about.
        if (payload.enqueueError) {
          errors.report(payload.enqueueError, { handled: false, source: "jobs" });
        }
      });

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
/** For the callbacks a Step outside a worker has nothing to do with. */
function noop(): void {}

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
