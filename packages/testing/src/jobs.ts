/**
 * Checking what a test enqueued, ported from
 * `ActiveJob::TestHelper`.
 *
 *     const enqueued = await capturingJobs(async () => {
 *       await order.place()
 *     })
 *
 *     expect(enqueued.of(ChargeCard)).toHaveLength(1)
 *     expect(enqueued.of(ChargeCard)[0]?.arguments).toEqual([order.id])
 *
 * Without something like this a test either reaches into whichever queue the
 * application happened to configure — and so knows about Redis to assert about
 * an email — or performs the job inline and stops testing that it was
 * deferred at all, which is usually the part that was worth testing.
 *
 * The queue is swapped for the duration and put back afterwards, including
 * when the block throws: a test that left the application pointed at a
 * capturing queue would make every test after it silently stop delivering.
 */

import { AssertionFailed } from "@altair/support";

interface Payload {
  id: string;
  jobClass: string;
  queue: string;
  arguments: unknown[];
  runAt: number;
}

/** What a job class looks like from here. */
interface JobLike {
  jobName?: string;
  name: string;
  adapter?: unknown;
}

/** What was enqueued, with the questions a test actually asks. */
export class EnqueuedJobs {
  constructor(readonly all: Payload[]) {}

  /** Everything enqueued for one job class. */
  of(job: JobLike | string): Payload[] {
    const name = typeof job === "string" ? job : (job.jobName ?? job.name);
    return this.all.filter((payload) => payload.jobClass === name);
  }

  /** Everything on one queue. */
  on(queue: string): Payload[] {
    return this.all.filter((payload) => payload.queue === queue);
  }

  get length(): number {
    return this.all.length;
  }

  /** So a test can iterate it as it would an array. */
  [Symbol.iterator](): Iterator<Payload> {
    return this.all[Symbol.iterator]();
  }
}

/** The slice of `Job` this needs, so the packages stay uncoupled. */
export interface JobClassLike {
  adapter: unknown;
}

/**
 * Runs a block with a queue that records rather than delivers.
 *
 * The recording queue answers `dequeue` with nothing, so a worker running
 * beside the test finds an empty queue instead of a job the test is about to
 * make assertions on.
 */
export async function capturingJobs(
  jobClass: JobClassLike,
  body: () => unknown | Promise<unknown>,
): Promise<EnqueuedJobs> {
  const captured: Payload[] = [];
  const previous = jobClass.adapter;

  jobClass.adapter = {
    async enqueue(payload: Payload) {
      captured.push(payload);
    },
    async dequeue() {
      return null;
    },
  };

  try {
    await body();
  } finally {
    // Put back whatever the block did. A test that left the application on a
    // capturing queue would make every test after it silently stop delivering.
    jobClass.adapter = previous;
  }

  return new EnqueuedJobs(captured);
}

/**
 * Rails' `assert_enqueued_jobs`: how many the block put on the queue.
 *
 * `capturingJobs` answers what was enqueued; this answers whether it was the
 * right amount, and says what it found when it was not. "Expected 1, got 2"
 * sends somebody counting call sites when the answer is usually a callback
 * enqueueing a second one they had forgotten about.
 */
export async function assertEnqueuedJobs(
  jobClass: JobClassLike,
  count: number,
  body: () => unknown | Promise<unknown>,
  filter: { only?: JobLike | string; queue?: string } = {},
): Promise<EnqueuedJobs> {
  const captured = await capturingJobs(jobClass, body);

  let matched = captured.all;
  if (filter.only !== undefined) matched = captured.of(filter.only);
  if (filter.queue !== undefined) matched = matched.filter((one) => one.queue === filter.queue);

  if (matched.length !== count) {
    const names = matched.map((one) => one.jobClass);

    throw new AssertionFailed(
      `Expected ${count} job(s) to be enqueued, got ${matched.length}.` +
        (names.length > 0 ? ` Enqueued: ${names.join(", ")}.` : ""),
    );
  }

  return new EnqueuedJobs(matched);
}

/** Rails' `assert_no_enqueued_jobs`. */
export async function assertNoEnqueuedJobs(
  jobClass: JobClassLike,
  body: () => unknown | Promise<unknown>,
  filter: { only?: JobLike | string; queue?: string } = {},
): Promise<void> {
  await assertEnqueuedJobs(jobClass, 0, body, filter);
}

/**
 * Rails' `assert_enqueued_with`: one particular job, with these arguments.
 *
 * Arguments are compared as the queue holds them — serialized — because that
 * is what the worker will hand back. A test asserting on the object it passed
 * in would pass for a job whose arguments cannot survive the trip, which is
 * the failure that only ever shows up in production.
 */
export async function assertEnqueuedWith(
  jobClass: JobClassLike,
  expected: { job: JobLike | string; args?: unknown[]; queue?: string },
  body: () => unknown | Promise<unknown>,
): Promise<void> {
  const captured = await capturingJobs(jobClass, body);
  const wanted = expected.args === undefined ? undefined : JSON.stringify(expected.args);

  const found = captured
    .of(expected.job)
    .some(
      (one) =>
        (expected.queue === undefined || one.queue === expected.queue) &&
        (wanted === undefined || JSON.stringify(one.arguments) === wanted),
    );

  if (!found) {
    const name = typeof expected.job === "string" ? expected.job : expected.job.name;
    const seen = captured.all.map((one) => `${one.jobClass}(${JSON.stringify(one.arguments)})`);

    throw new AssertionFailed(
      `No enqueued job matched ${name}${wanted === undefined ? "" : `(${wanted})`}` +
        (seen.length === 0 ? ". Nothing was enqueued." : `. Enqueued: ${seen.join(", ")}.`),
    );
  }
}

/**
 * Runs whatever the block enqueues instead of leaving it on the queue. Rails'
 * `perform_enqueued_jobs`.
 *
 * For the test that is about a job's effect rather than about it being
 * enqueued — "placing the order sends the mail", where the assertion is on the
 * mailbox rather than on the queue.
 *
 * Anything a job enqueues in turn is run too, which is what makes a chain of
 * jobs testable at all: a snapshot taken before the loop would run the first
 * and quietly drop everything it led to.
 */
export async function performEnqueuedJobs(
  jobClass: JobClassLike,
  run: (payload: Payload) => unknown | Promise<unknown>,
  body: () => unknown | Promise<unknown>,
  filter: { only?: JobLike | string; queue?: string } = {},
): Promise<Payload[]> {
  const pending: Payload[] = [];
  const previous = jobClass.adapter;

  jobClass.adapter = {
    async enqueue(payload: Payload) {
      pending.push(payload);
    },
    async dequeue() {
      return null;
    },
  };

  const performed: Payload[] = [];
  const wanted =
    filter.only === undefined
      ? undefined
      : typeof filter.only === "string"
        ? filter.only
        : (filter.only.jobName ?? filter.only.name);

  try {
    await body();

    while (pending.length > 0) {
      const payload = pending.shift() as Payload;

      if (wanted !== undefined && payload.jobClass !== wanted) continue;
      if (filter.queue !== undefined && payload.queue !== filter.queue) continue;

      performed.push(payload);
      await run(payload);
    }
  } finally {
    jobClass.adapter = previous;
  }

  return performed;
}
