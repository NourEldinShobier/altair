/**
 * Stopping a job partway through, on purpose, ported from
 * `ActiveJob::Continuation::TestHelper`.
 *
 * `continuable.ts` has the predicates — `interruptDuringStep`,
 * `interruptAfterStep` — which answer "is this the moment to stop?". This is
 * the layer a test actually uses: it installs one of those for the length of a
 * block, filtered to a job class, so `performEnqueuedJobs` inside the block
 * stops where the test said and the same call outside it runs to completion.
 *
 * The reason to have it at all is that the resume path is otherwise only
 * reachable by racing a real shutdown. A test that cannot stop a job at a
 * chosen point either does not test resumption, or tests it with a sleep and a
 * signal — which is slow, flaky, and passes for the wrong reason often enough
 * that nobody trusts the failure.
 *
 * Scoped to a block rather than set and cleared, because a stopping predicate
 * left installed makes every later job in the process stop partway. That
 * failure appears in an unrelated test, which is the worst place for it: the
 * test that caused it passed.
 */

import type { Continuation } from "@altair/jobs";

/** What a stopping predicate sees. */
export interface InterruptibleJob {
  constructor: unknown;
  continuation?: Continuation;
}

export type StoppingPredicate = (job: InterruptibleJob) => string | false;

let stopping: StoppingPredicate | undefined;

/** Whether the job running now should stop. Consulted by the continuation. */
export function stoppingReason(job: InterruptibleJob): string | false {
  return stopping?.(job) ?? false;
}

/**
 * Installs a stopping predicate for the length of a block.
 *
 * Restored rather than cleared in the `finally`, so nesting works — and
 * restored at all because a predicate left behind stops every later job in the
 * process, producing a failure in an unrelated test while the test that caused
 * it passes.
 */
export async function withStopping<T>(
  predicate: StoppingPredicate,
  body: () => Promise<T> | T,
): Promise<T> {
  const held = stopping;
  stopping = predicate;

  try {
    return await body();
  } finally {
    stopping = held;
  }
}

function isInstanceOf(job: InterruptibleJob, jobClass: unknown): boolean {
  // The class rather than the name: two jobs can share a name across
  // namespaces, and interrupting the wrong one produces a test that passes
  // while proving nothing.
  return job.constructor === jobClass;
}

/**
 * Rails' `interrupt_job_during_step`.
 *
 * Stops the job the moment it reaches `step` — at `cursor`, if one is given.
 * Without a cursor it stops at the first checkpoint inside the step, which is
 * what a test asking "does this resume mid-step at all?" wants.
 */
export function interruptJobDuringStep<T>(
  jobClass: unknown,
  step: string,
  { cursor, reason = "stopping" }: { cursor?: unknown; reason?: string } = {},
  body: () => Promise<T> | T = () => undefined as T,
): Promise<T> {
  return withStopping((job) => {
    if (!isInstanceOf(job, jobClass)) return false;

    const current = job.continuation?.toH().current;

    if (current === undefined || current[0] !== step) return false;
    if (cursor !== undefined && !sameCursor(current[1], cursor)) return false;

    return reason;
  }, body);
}

/**
 * Rails' `interrupt_job_after_step`.
 *
 * There is no checkpoint after the final step, so the final step cannot be
 * interrupted after — the job simply finishes. Worth knowing before writing a
 * test that waits for an interruption that never comes.
 */
export function interruptJobAfterStep<T>(
  jobClass: unknown,
  step: string,
  { reason = "stopping" }: { reason?: string } = {},
  body: () => Promise<T> | T = () => undefined as T,
): Promise<T> {
  return withStopping((job) => {
    if (!isInstanceOf(job, jobClass)) return false;

    const state = job.continuation?.toH();

    if (state === undefined || state.current !== undefined) return false;

    return state.completed.at(-1) === step ? reason : false;
  }, body);
}

/** Cursors are compared by value, since an array cursor is the normal case. */
function sameCursor(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}
