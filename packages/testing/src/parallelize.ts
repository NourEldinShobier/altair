/**
 * Running a suite across several worker processes, ported from
 * `ActiveSupport::Testing::Parallelization` and `Parallelization::Server`.
 *
 * The ORM suite is the reason: it is almost entirely waiting on a database, so
 * one process spends most of a run idle. Splitting it across workers is nearly
 * free wall-clock time — provided two things hold, and both of them fail
 * quietly rather than loudly when they do not:
 *
 * **Each worker needs its own database.** Two workers sharing one truncate each
 * other's fixtures mid-test. The symptom is a test that fails perhaps one run
 * in five, in a different place each time, and passes the moment anyone runs it
 * alone to investigate. So the worker id is part of the database name, and a
 * worker with no id is refused rather than quietly sharing.
 *
 * **Work is pulled, not partitioned.** Dealing the tests out up front assumes
 * they take the same time; they do not, and the run then takes as long as
 * whichever worker was handed the slow ones. A shared queue costs a message per
 * test and makes the run take as long as the slowest *test*.
 *
 * The third rule is about failure: a worker that dies takes its in-flight test
 * with it. Requeueing that test is the difference between a crash being
 * reported and a test silently never having run — and a suite that reports
 * green having skipped something is worse than one that fails.
 */

/** What a worker is given. */
export interface WorkItem {
  /** Enough to identify the test: a file, or a file and a name. */
  file: string;
  name?: string;
}

export interface WorkerHandle {
  id: number;
  pid?: number;
  /** What it is running right now, for requeueing if it dies. */
  current?: WorkItem;
  alive: boolean;
}

export type ForkHook = (worker: WorkerHandle) => void | Promise<void>;

const beforeForkHooks: ForkHook[] = [];
const afterForkHooks: ForkHook[] = [];
const cleanupHooks: ForkHook[] = [];

/**
 * Rails' `before_fork_hook` — runs once in the parent, before any worker.
 *
 * The place to do anything expensive that a fork can share: loading the
 * application, compiling, reading fixtures off disk. Doing it after the fork
 * does it once per worker.
 */
export function beforeForkHook(hook: ForkHook): void {
  beforeForkHooks.push(hook);
}

/**
 * Rails' `after_fork_hook` — runs in each worker, with its own id.
 *
 * Where the database name gets its suffix. Anything holding a connection has
 * to be reopened here: a connection opened before the fork is a file
 * descriptor two processes now share, and two processes reading one socket get
 * each other's results.
 */
export function afterForkHook(hook: ForkHook): void {
  afterForkHooks.push(hook);
}

/** Rails' `run_cleanup_hook`. */
export function cleanupHook(hook: ForkHook): void {
  cleanupHooks.push(hook);
}

export function clearForkHooks(): void {
  beforeForkHooks.length = 0;
  afterForkHooks.length = 0;
  cleanupHooks.length = 0;
}

export async function runBeforeFork(worker: WorkerHandle): Promise<void> {
  for (const hook of beforeForkHooks) await hook(worker);
}

export async function runAfterFork(worker: WorkerHandle): Promise<void> {
  for (const hook of afterForkHooks) await hook(worker);
}

export async function runCleanup(worker: WorkerHandle): Promise<void> {
  for (const hook of cleanupHooks) await hook(worker);
}

// --- the worker's own database ---------------------------------------------

export class MissingWorkerId extends Error {
  constructor() {
    super(
      `A parallel worker has no id, so it cannot be given a database of its own. Sharing one ` +
        `would let two workers truncate each other's fixtures mid-test, which fails about one ` +
        `run in five, somewhere different each time, and passes when run alone.`,
    );
    this.name = "MissingWorkerId";
  }
}

/**
 * The database name for one worker. Rails' `parallel_worker_id` suffix.
 *
 * Refuses rather than defaulting. A default is what makes two workers share a
 * database, and the failure that produces is the least debuggable kind there
 * is.
 */
export function workerDatabaseName(base: string, workerId: number | undefined): string {
  if (workerId === undefined || !Number.isInteger(workerId) || workerId < 0) {
    throw new MissingWorkerId();
  }

  // Worker 0 gets a suffix too. Leaving it bare would mean a parallel run and a
  // serial run share a database, so running both at once corrupts the serial
  // one — and "it only breaks in CI" is how that gets found.
  return `${base}-${workerId}`;
}

/** Rails' `parallel_worker_id`, from the environment a worker was started with. */
export function parallelWorkerId(env: Record<string, string | undefined>): number | undefined {
  return env["TEST_ENV_NUMBER"] === undefined
    ? undefined
    : Number.parseInt(env["TEST_ENV_NUMBER"], 10);
}

/**
 * Whether to fork at all. Rails' `forking_env?`.
 *
 * Forking needs a platform that has it and a worker count above one. Below
 * that, running in-process is not merely equivalent — it is better, because a
 * stack trace from the process that failed is the one you want.
 */
export function forkingEnv(workers: number, platform: string = process.platform): boolean {
  return workers > 1 && platform !== "win32";
}

/**
 * Rails' `run_in_isolation` — how many workers to actually use.
 *
 * Capped at the number of tests, because a worker with nothing to do still
 * pays the whole fork-and-boot cost.
 */
export function workerCount(requested: number, tests: number): number {
  return Math.max(1, Math.min(requested, tests));
}

// --- the queue -------------------------------------------------------------

export interface QueueStats {
  queued: number;
  running: number;
  completed: number;
  failed: number;
}

export type StepReport = (item: WorkItem, outcome: "pass" | "fail", workerId: number) => void;

/**
 * Hands work out and takes results back. Rails' `Parallelization::Server`.
 */
export class WorkQueue {
  readonly #queued: WorkItem[] = [];
  readonly #workers = new Map<number, WorkerHandle>();
  #completed = 0;
  #failed = 0;
  #running = false;
  #failFast = false;
  #report: StepReport = () => undefined;

  constructor({ failFast = false }: { failFast?: boolean } = {}) {
    this.#failFast = failFast;
  }

  /** Rails' `report_step`. */
  onStep(report: StepReport): void {
    this.#report = report;
  }

  /** Rails' `<<`. */
  addTest(item: WorkItem): void {
    this.#queued.push(item);
  }

  get size(): number {
    return this.#queued.length;
  }

  /** Rails' `start`. */
  startRunning(): void {
    this.#running = true;
  }

  /** Rails' `done_running?`. */
  doneRunning(): boolean {
    if (!this.#running) return false;

    return this.#queued.length === 0 && this.activeWorkers().every((each) => !each.current);
  }

  /** Rails' `failing_fast?`. */
  failingFast(): boolean {
    return this.#failFast && this.#failed > 0;
  }

  /** Rails' `start_worker`. */
  startWorker(id: number, pid?: number): WorkerHandle {
    const worker: WorkerHandle = { id, alive: true, ...(pid === undefined ? {} : { pid }) };
    this.#workers.set(id, worker);

    return worker;
  }

  /** Rails' `active_workers`. */
  activeWorkers(): WorkerHandle[] {
    return [...this.#workers.values()].filter((each) => each.alive);
  }

  /**
   * The next test for a worker. Rails' `pop`.
   *
   * Pulled rather than dealt out: dealing assumes the tests take the same time,
   * and the run then lasts as long as whichever worker got the slow ones.
   */
  workFromQueue(workerId: number): WorkItem | undefined {
    if (this.failingFast()) return undefined;

    const worker = this.#workers.get(workerId);

    if (!worker?.alive) return undefined;

    const next = this.#queued.shift();
    worker.current = next;

    return next;
  }

  /** Rails' `record`. */
  finish(workerId: number, outcome: "pass" | "fail"): void {
    const worker = this.#workers.get(workerId);
    const item = worker?.current;

    if (worker) worker.current = undefined;
    if (outcome === "fail") this.#failed += 1;

    this.#completed += 1;

    if (item) this.#report(item, outcome, workerId);
  }

  /**
   * Rails' `stop_worker`.
   *
   * Whatever it was running goes back on the queue. Losing it would mean a
   * suite that reports green having silently skipped a test, which is worse
   * than one that fails.
   */
  stopWorker(workerId: number): WorkItem | undefined {
    const worker = this.#workers.get(workerId);

    if (!worker) return undefined;

    worker.alive = false;
    const orphaned = worker.current;
    worker.current = undefined;

    if (orphaned) this.#queued.unshift(orphaned);

    return orphaned;
  }

  /** Rails' `remove_dead_workers`. */
  removeDeadWorkers(deadIds: readonly number[]): WorkItem[] {
    return deadIds.map((id) => this.stopWorker(id)).filter((each): each is WorkItem => !!each);
  }

  /** Rails' `shutdown`. */
  shutdown(): void {
    this.#running = false;

    for (const worker of this.activeWorkers()) this.stopWorker(worker.id);
  }

  stats(): QueueStats {
    return {
      queued: this.#queued.length,
      running: this.activeWorkers().filter((each) => !!each.current).length,
      completed: this.#completed,
      failed: this.#failed,
    };
  }
}

// --- the run ---------------------------------------------------------------

export interface ParallelizeOptions {
  workers: number;
  failFast?: boolean;
  /** Runs one item. In a real runner this is the worker process. */
  run: (item: WorkItem, worker: WorkerHandle) => Promise<"pass" | "fail">;
}

/**
 * Runs a whole suite across workers. Rails' `parallelize`.
 *
 * The hooks fire in Rails' order — `before_fork` once in the parent, then
 * `after_fork` per worker, then the work, then cleanup per worker — because
 * anything that opens a connection has to do it after the fork, and anything
 * expensive that can be shared has to do it before.
 */
export async function parallelize(
  items: readonly WorkItem[],
  { workers, failFast = false, run }: ParallelizeOptions,
): Promise<QueueStats> {
  const queue = new WorkQueue({ failFast });

  for (const item of items) queue.addTest(item);

  const count = workerCount(workers, items.length);
  queue.startRunning();

  const started = Array.from({ length: count }, (_, id) => queue.startWorker(id));

  for (const worker of started) await runBeforeFork(worker);

  await Promise.all(
    started.map(async (worker) => {
      try {
        // Inside the `try`, so a hook that fails — one that could not create
        // this worker's database, say — still reaches cleanup. Outside it, the
        // worker that failed to set itself up is exactly the one that leaks.
        await runAfterFork(worker);

        for (;;) {
          const item = queue.workFromQueue(worker.id);

          if (!item) break;

          let outcome: "pass" | "fail" = "fail";

          try {
            outcome = await run(item, worker);
          } catch {
            // A test that threw outside its own assertions is a failure, not a
            // reason to abandon the worker — the remaining tests still have to
            // run, or one crash hides everything after it.
            outcome = "fail";
          }

          queue.finish(worker.id, outcome);
        }
      } finally {
        // In a `finally`, so a worker that dies still releases its database and
        // its connection rather than leaving both for the next run to trip on.
        await runCleanup(worker);
      }
    }),
  );

  queue.shutdown();

  return queue.stats();
}
