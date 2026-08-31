import { addSerializer } from "./serializers.js";
import type { ArgumentSerializer } from "./serializers.js";

/**
 * Choosing a queue, naming it, and deciding what happens when a job fails.
 * Ported from `ActiveJob::QueueAdapters`, `QueueName` and `Exceptions`.
 *
 * `job.ts` defines what a job is and `worker.ts` runs one. What sits between
 * them is the set of decisions that are made once per application and are
 * wrong in a way nobody notices until a Friday:
 *
 * **Which adapter.** An application that never chose one gets the inline
 * adapter, which runs jobs synchronously — and inline is right for a test and
 * catastrophic in production, because every `deliver_later` becomes a
 * `deliver_now` inside the request. The check exists so that is a boot failure
 * rather than a latency graph.
 *
 * **What the queue is called.** A prefix per environment keeps staging's
 * workers from draining production's queue when somebody points a
 * `REDIS_URL` at the wrong host, which is a mistake made roughly once per
 * team.
 *
 * **Whether a failure retries.** The two ways of getting this wrong are
 * symmetrical: retrying something that can never succeed burns a worker
 * forever, and not retrying something transient loses the job. So errors are
 * classified rather than counted.
 */

/** How long to wait before trying again. */
export type Backoff = "exponential" | "polynomial" | ((attempt: number) => number);

export interface RetryRule {
  /** How many times in total the job may run. */
  attempts: number;
  wait: Backoff;
  /** A ceiling, so an exponential backoff does not schedule something for next year. */
  maxWaitMs?: number;
  /** What to do when the attempts run out. */
  onExhausted?: "discard" | "raise";
}

export const DEFAULT_RETRY_RULE: RetryRule = {
  attempts: 5,
  wait: "exponential",
  maxWaitMs: 60 * 60 * 1000,
  onExhausted: "raise",
};

/**
 * How long to wait before attempt N, counting from 1.
 *
 * Jittered, and that is not decoration. A hundred jobs failing on the same
 * downstream outage retry at exactly the same moment without it, so the
 * service that just came back up is hit by the entire backlog at once and goes
 * down again — and the pattern repeats on a widening cycle.
 */
export function retryWait(rule: RetryRule, attempt: number, jitter = Math.random()): number {
  const base =
    typeof rule.wait === "function"
      ? rule.wait(attempt)
      : rule.wait === "polynomial"
        ? attempt ** 4 * 1000
        : 2 ** attempt * 1000;

  const capped = Math.min(base, rule.maxWaitMs ?? Number.POSITIVE_INFINITY);

  return Math.round(capped * (0.85 + jitter * 0.3));
}

/** What an error should cause. */
export type ErrorDisposition = "retry" | "discard" | "raise";

export interface ErrorPolicy {
  /** Errors worth trying again — a timeout, a 503, a deadlock. */
  retryOn?: readonly string[];
  /** Errors that will never succeed — a deleted record, a malformed argument. */
  discardOn?: readonly string[];
}

/**
 * What to do about a failure. Rails' `retry_on` / `discard_on`.
 *
 * `discard` is checked first. An error listed as both is a contradiction the
 * application wrote, and discarding is the safe reading: retrying something
 * declared impossible burns a worker until the attempts run out, while
 * discarding something retryable loses one job and says so in the log.
 */
export function dispositionFor(error: unknown, policy: ErrorPolicy = {}): ErrorDisposition {
  const name = error instanceof Error ? error.name : "Error";

  if ((policy.discardOn ?? []).includes(name)) return "discard";
  if ((policy.retryOn ?? []).includes(name)) return "retry";

  return "raise";
}

/** Whether an error is one this policy will not act on. Rails' `excluded?`. */
export function excluded(error: unknown, policy: ErrorPolicy = {}): boolean {
  return dispositionFor(error, policy) === "raise";
}

export interface RetryDecision {
  action: "retry" | "discard" | "raise";
  attempt: number;
  waitMs?: number;
}

/**
 * Whether a failed job runs again, and when. Rails' `retry_job` /
 * `enqueue_retry`.
 *
 * The attempt count is compared against the total rather than the remainder,
 * because "attempts: 5" reads as five runs and an off-by-one here means either
 * four or six — and six is a job that outlives the incident that caused it.
 */
export function retryJob(
  error: unknown,
  attempt: number,
  rule: RetryRule = DEFAULT_RETRY_RULE,
  policy: ErrorPolicy = {},
  jitter = Math.random(),
): RetryDecision {
  const disposition = dispositionFor(error, policy);

  if (disposition === "discard") return { action: "discard", attempt };
  if (disposition === "raise") return { action: "raise", attempt };

  if (attempt >= rule.attempts) {
    return { action: rule.onExhausted === "discard" ? "discard" : "raise", attempt };
  }

  return { action: "retry", attempt: attempt + 1, waitMs: retryWait(rule, attempt, jitter) };
}

/** The same, as the payload a queue needs. Rails' `enqueue_retry`. */
export function enqueueRetry(
  decision: RetryDecision,
  now: number = Date.now(),
): { runAt: number; attempt: number } | undefined {
  if (decision.action !== "retry") return undefined;

  return { runAt: now + (decision.waitMs ?? 0), attempt: decision.attempt };
}

/** How a queue's full name is built. */
export interface QueueNaming {
  prefix?: string;
  /** What joins the prefix to the name. Rails defaults to `_`. */
  delimiter?: string;
}

let naming: QueueNaming = { delimiter: "_" };

export function configureQueueNaming(options: QueueNaming): void {
  naming = { delimiter: "_", ...options };
}

export function queueNaming(): QueueNaming {
  return { ...naming };
}

export function resetQueueNaming(): void {
  naming = { delimiter: "_" };
}

/**
 * The full name of a queue. Rails' `queue_name_from_part`.
 *
 * The prefix is what stops staging's workers draining production's queue when
 * somebody points a connection string at the wrong host — a mistake made
 * roughly once per team, and one whose symptom is jobs quietly disappearing
 * rather than an error.
 */
export function queueNameFromPart(part: string, options: QueueNaming = naming): string {
  const prefix = options.prefix;

  if (prefix === undefined || prefix === "") return part;

  return `${prefix}${options.delimiter ?? "_"}${part}`;
}

/** Every adapter this process knows. */
const adapters = new Map<string, () => unknown>();

export function registerAdapter(name: string, build: () => unknown): void {
  adapters.set(name.toLowerCase(), build);
}

export function adapterNames(): string[] {
  return Array.from(adapters.keys()).sort();
}

export class UnknownAdapter extends Error {
  constructor(name: string, known: readonly string[]) {
    super(`No queue adapter called "${name}". Registered: ${known.join(", ") || "none"}.`);
    this.name = "UnknownAdapter";
  }
}

/** Rails' `queue_adapter=` resolution. */
export function queueAdapter(name: string): unknown {
  const build = adapters.get(name.toLowerCase());

  if (!build) throw new UnknownAdapter(name, adapterNames());

  return build();
}

/** Adapters that run a job in the caller rather than handing it to a worker. */
export const IMMEDIATE_ADAPTERS: ReadonlySet<string> = new Set(["inline", "test", "async"]);

/** Rails' `immediate?` — whether enqueuing runs the job there and then. */
export function immediate(name: string): boolean {
  return IMMEDIATE_ADAPTERS.has(name.toLowerCase());
}

export class InlineAdapterInProduction extends Error {
  constructor(name: string) {
    super(
      `The "${name}" queue adapter runs jobs inside the request that enqueued them, so ` +
        `every deliver_later becomes a deliver_now. Choose a real adapter, or set ` +
        `allowImmediate if this environment genuinely wants that.`,
    );
    this.name = "InlineAdapterInProduction";
  }
}

/**
 * Refuses an adapter that would run jobs inline where it matters. Rails'
 * `check_adapter`.
 *
 * A boot failure rather than a latency graph. An application that never chose
 * an adapter otherwise runs every background job in the foreground, and the
 * symptom is a slow endpoint rather than anything naming the queue.
 */
export function checkAdapter(
  name: string,
  options: { production?: boolean; allowImmediate?: boolean } = {},
): void {
  if (options.production !== true || options.allowImmediate === true) return;
  if (!immediate(name)) return;

  throw new InlineAdapterInProduction(name);
}

/**
 * Builds the queue an application will use, checking it first. Rails'
 * `build_queue`.
 */
export function buildQueue(
  name: string,
  options: { production?: boolean; allowImmediate?: boolean } = {},
): unknown {
  checkAdapter(name, options);

  return queueAdapter(name);
}

/**
 * Registers several argument serializers at once. Rails' `add_serializers`.
 *
 * Through `serializers.ts`, which already owns the registry: it appends, and
 * replaces in place when a key is registered twice — so a module reloaded in
 * development leaves one serializer rather than two shadowing each other.
 *
 * In the order given, so the first argument is tried before the second. They
 * all come after the built-in ones, which is what makes a serializer for a
 * type the framework already handles a replacement (same key) rather than a
 * competitor.
 */
export function addSerializers(...added: readonly ArgumentSerializer[]): void {
  for (const serializer of added) addSerializer(serializer);
}

/** What ran, for a test that asserts on it. Rails' `performed_jobs`. */
const performed: unknown[] = [];

export function performedJobs(): readonly unknown[] {
  return performed;
}

export function recordPerformedJob(job: unknown): void {
  performed.push(job);
}

export function clearPerformedJobs(): void {
  performed.length = 0;
}

/**
 * Where a job actually runs. Rails' `executor`.
 *
 * A seam rather than a call, so a worker can wrap every job in whatever a
 * request is wrapped in — a connection, a request-scoped store, an error
 * reporter. A job that runs outside those leaks a connection per job, which
 * is a pool exhausted in an hour.
 */
export type JobExecutor = <T>(body: () => Promise<T>) => Promise<T>;

let executorFn: JobExecutor = async (body) => body();

export function executor(): JobExecutor {
  return executorFn;
}

export function setExecutor(replacement: JobExecutor): void {
  executorFn = replacement;
}

export function resetExecutor(): void {
  executorFn = async (body) => body();
}
