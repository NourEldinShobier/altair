/**
 * Queue adapters and the worker loop.
 *
 * The worker is the part that has to be careful: a job that fails must be
 * retried with a growing wait, a job that keeps failing must stop and be kept
 * for inspection, and a worker asked to stop must finish what it is holding
 * rather than dropping it.
 */

import { DEFAULT_RETRY, Job, type JobPayload, type QueueAdapter } from "./job.js";

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
  status: "completed" | "retried" | "failed";
  payload: JobPayload;
  error?: unknown;
}

/**
 * Runs one job.
 *
 * Exposed separately from the loop so a test can drive a single job without
 * starting a worker, and so a caller can build a different loop.
 */
export async function runJob(payload: JobPayload, adapter: QueueAdapter): Promise<RunResult> {
  const klass = Job.lookup(payload.jobClass);

  try {
    await (klass as unknown as { performNow: (...args: unknown[]) => Promise<unknown> }).performNow(
      ...payload.arguments,
    );
    return { status: "completed", payload };
  } catch (error) {
    const policy = klass.retryPolicy ?? DEFAULT_RETRY;
    const attempts = payload.attempts + 1;

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

      const result = await this.#run(payload);
      results.push(result);
    }
  }

  async #run(payload: JobPayload): Promise<RunResult> {
    const result = await runJob(payload, this.options.adapter);

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

      // Held so stop() can wait for it rather than dropping it.
      this.#current = this.#run(payload);
      await this.#current;
      this.#current = undefined;
    }
  }

  /** Stops after the job in flight finishes. */
  async stop(): Promise<void> {
    this.#running = false;
    await this.#current;
  }
}
