/**
 * Queue adapters and the worker loop.
 *
 * The worker is the part that has to be careful: a job that fails must be
 * retried with a growing wait, a job that keeps failing must stop and be kept
 * for inspection, and a worker asked to stop must finish what it is holding
 * rather than dropping it.
 */

import { deserializeArguments } from "./serializers.js";
import { Continuation, JobInterrupted, checkResumeLimit, resumedState } from "./continuable.js";
import { Job, type JobPayload, type QueueAdapter } from "./job.js";

/**
 * An in-process queue.
 *
 * Right for tests and development, wrong for more than one process — the same
 * caveat Rails' async adapter carries. Jobs are lost when the process exits.
 */
export class MemoryQueue implements QueueAdapter {
  readonly #queues = new Map<string, JobPayload[]>();
  readonly failed: JobPayload[] = [];

  #for(queue: string): JobPayload[] {
    let entries = this.#queues.get(queue);
    if (!entries) {
      entries = [];
      this.#queues.set(queue, entries);
    }
    return entries;
  }

  async enqueue(payload: JobPayload): Promise<void> {
    const entries = this.#for(payload.queue);
    entries.push(payload);
    // Earliest runAt first, so a delayed job does not block a ready one.
    entries.sort((a, b) => a.runAt - b.runAt);
  }

  async dequeue(queue: string): Promise<JobPayload | null> {
    const entries = this.#for(queue);
    const next = entries[0];

    if (!next || next.runAt > Date.now()) return null;
    return entries.shift() ?? null;
  }

  async size(queue = "default"): Promise<number> {
    return this.#for(queue).length;
  }

  /** Everything waiting, for assertions. */
  pending(queue = "default"): readonly JobPayload[] {
    return [...this.#for(queue)];
  }
}

/**
 * Runs a job the moment it is enqueued. Rails' `:inline` adapter.
 *
 * The default in development, where the alternative is that `performLater`
 * quietly puts work somewhere nothing is watching. Running it here is visible:
 * it happens, or it throws where the person who asked for it can see.
 *
 * A delay is ignored, as Rails' inline adapter ignores it — `set({ wait })`
 * runs now. Nothing waits, so there is nothing to wait for.
 */
export class InlineQueue implements QueueAdapter {
  async enqueue(payload: JobPayload): Promise<void> {
    const klass = Job.lookup(payload.jobClass) as unknown as {
      performNow(...args: unknown[]): Promise<unknown>;
    };

    await klass.performNow(...deserializeArguments(payload.arguments));
  }

  /** Nothing is ever waiting: it ran on the way in. */
  async dequeue(): Promise<JobPayload | null> {
    return null;
  }

  async size(): Promise<number> {
    return 0;
  }
}

/** The subset of `Bun.RedisClient` the queue adapter uses. */
export interface RedisQueueClient {
  lpush(key: string, ...values: string[]): Promise<number>;
  rpop(key: string): Promise<string | null>;
  llen(key: string): Promise<number>;
}

/**
 * A queue in Redis, over `Bun.RedisClient`.
 *
 * ponytail: a single list per queue, polled by the worker. That is enough for
 * one process per queue; a multi-worker deployment wants a reliable queue
 * (RPOPLPUSH into a processing list) so a crashed worker does not drop the job
 * it was holding.
 */
export class RedisQueue implements QueueAdapter {
  constructor(
    private readonly client: RedisQueueClient,
    private readonly namespace = "altair:jobs",
  ) {}

  #key(queue: string): string {
    return `${this.namespace}:${queue}`;
  }

  async enqueue(payload: JobPayload): Promise<void> {
    await this.client.lpush(this.#key(payload.queue), JSON.stringify(payload));
  }

  async dequeue(queue: string): Promise<JobPayload | null> {
    const raw = await this.client.rpop(this.#key(queue));
    if (raw === null) return null;

    let payload: JobPayload;
    try {
      payload = JSON.parse(raw) as JobPayload;
    } catch {
      // Something else wrote to this list. Dropping it is better than crashing
      // the worker on every poll.
      return null;
    }

    // Redis lists have no delay, so a job that is not ready goes back.
    if (payload.runAt > Date.now()) {
      await this.client.lpush(this.#key(queue), raw);
      return null;
    }
    return payload;
  }

  async size(queue = "default"): Promise<number> {
    return await this.client.llen(this.#key(queue));
  }
}

export interface WorkerOptions {
  queue?: string;
  adapter: QueueAdapter;
  /** Milliseconds to wait when the queue is empty. */
  pollInterval?: number;
  onError?: (error: unknown, payload: JobPayload) => void;
  /** Called when a job exhausts its retries. */
  onFailure?: (error: unknown, payload: JobPayload) => void | Promise<void>;
}

export interface RunResult {
  status: "completed" | "retried" | "failed" | "discarded" | "interrupted";
  payload: JobPayload;
  error?: unknown;
}

/** What the runner needs beyond the payload. */
export interface RunOptions {
  /**
   * Whether the worker has been asked to shut down.
   *
   * Consulted only at the checkpoints a continuable job chooses, so a job
   * stops where it said it was safe to rather than wherever the signal
   * happened to arrive.
   */
  shouldStop?: () => boolean;
}

/**
 * Runs one job.
 *
 * Exposed separately from the loop so a test can drive a single job without
 * starting a worker, and so a caller can build a different loop.
 */
export async function runJob(
  payload: JobPayload,
  adapter: QueueAdapter,
  options: RunOptions = {},
): Promise<RunResult> {
  const klass = Job.lookup(payload.jobClass);

  try {
    // Before the job runs, so a job that has exhausted its resumptions fails
    // once and leaves the queue rather than being started again and stopped
    // again at its first checkpoint for ever.
    if (payload.continuation) checkResumeLimit(payload.continuation, klass.maxResumptions);
  } catch (error) {
    return { status: "failed", payload: { ...payload, attempts: payload.attempts + 1 }, error };
  }

  const continuation = new Continuation(payload.continuation, options.shouldStop);

  try {
    await (
      klass as unknown as {
        performNowWith: (continuation: Continuation, ...args: unknown[]) => Promise<unknown>;
      }
    ).performNowWith(continuation, ...deserializeArguments(payload.arguments));

    return { status: "completed", payload };
  } catch (error) {
    // An interrupted job is not a failure and must not count as an attempt:
    // it stopped because it was asked to, and burning a retry for a deploy
    // would mean a long job dies after however many deploys the policy allows.
    if (error instanceof JobInterrupted) {
      const resumed: JobPayload = {
        ...payload,
        continuation: resumedState(error.continuation),
        runAt: 0,
      };
      await adapter.enqueue(resumed);

      return { status: "interrupted", payload: resumed };
    }

    const policy = klass.policyFor(error);
    const attempts = payload.attempts + 1;

    // Null means a rule said this failure will not come right. Reported apart
    // from a failure on purpose: a discard is the job working as intended, and
    // counting it as a failure trains people to ignore the failure count.
    if (policy === null) {
      return { status: "discarded", payload: { ...payload, attempts }, error };
    }

    if (attempts >= policy.attempts) {
      return { status: "failed", payload: { ...payload, attempts }, error };
    }

    // Re-enqueued rather than retried in place, so a slow retry does not hold
    // the worker and a restart does not lose the job.
    const retried: JobPayload = {
      ...payload,
      attempts,
      runAt: Date.now() + policy.backoff(attempts) * 1000,
    };
    await adapter.enqueue(retried);

    return { status: "retried", payload: retried, error };
  }
}

/** Polls a queue and runs what it finds, until stopped. */
export class Worker {
  #running = false;
  #current: Promise<unknown> | undefined;

  constructor(private readonly options: WorkerOptions) {}

  get isRunning(): boolean {
    return this.#running;
  }

  /** Runs every job that is ready right now, then returns. */
  async drain(): Promise<RunResult[]> {
    const queue = this.options.queue ?? "default";
    const results: RunResult[] = [];

    for (;;) {
      const payload = await this.options.adapter.dequeue(queue);
      if (!payload) return results;

      // Never interruptible. A draining worker is not shutting down — it is
      // running everything that is ready — and a job that interrupted here
      // would re-enqueue itself ready to run and be dequeued again on the next
      // turn of this loop, forever.
      const result = await this.#run(payload, () => false);
      results.push(result);
    }
  }

  async #run(payload: JobPayload, shouldStop: () => boolean): Promise<RunResult> {
    const result = await runJob(payload, this.options.adapter, { shouldStop });

    if (result.status !== "completed") this.options.onError?.(result.error, result.payload);
    if (result.status === "failed") await this.options.onFailure?.(result.error, result.payload);

    return result;
  }

  /** Polls until stopped. */
  async start(): Promise<void> {
    this.#running = true;
    const queue = this.options.queue ?? "default";
    const interval = this.options.pollInterval ?? 100;

    while (this.#running) {
      const payload = await this.options.adapter.dequeue(queue);

      if (!payload) {
        await Bun.sleep(interval);
        continue;
      }

      // Held so stop() can wait for it rather than dropping it. A continuable
      // job sees the flag go false at its next checkpoint and re-enqueues
      // itself carrying its progress; everything else runs to the end, because
      // a job with no checkpoints has nowhere safe to stop.
      this.#current = this.#run(payload, () => !this.#running);
      await this.#current;
      this.#current = undefined;
    }
  }

  /**
   * Stops after the job in flight finishes, or interrupts it if it can be.
   *
   * A continuable job sees `#running` go false at its next checkpoint and
   * re-enqueues itself carrying its progress. Everything else is waited for,
   * because a job with no checkpoints has nowhere safe to stop.
   */
  async stop(): Promise<void> {
    this.#running = false;
    await this.#current;
  }
}
