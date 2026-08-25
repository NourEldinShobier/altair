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
