/**
 * What a queue announces about itself, ported from
 * `ActiveJob::LogSubscriber` and the `ActiveSupport::Notifications` events
 * ActiveJob publishes.
 *
 * The worker knew everything worth knowing and told nobody. It returned a
 * status to whoever called it, which serves the loop and nothing else — so
 * there was no way to count retries, alert on a job that gave up, or notice
 * that a queue's latency had grown, short of parsing logs that were not being
 * written either.
 *
 * The one that matters most is `discarded`. A job that exhausts its retries
 * has failed permanently and silently: the work will never happen, nothing
 * remains in the queue to notice, and the only record is a line in a log
 * nobody reads. That is precisely the thing an application wants to be woken
 * for, and it needs an event to hang the alert on.
 */

import { componentLogger, setComponentLogger, type Logger } from "@altair/support";
import { notifications } from "@altair/support";
import type { JobPayload } from "./job.js";

/** The names published. Rails suffixes with the framework; this uses ours. */
export const JOB_EVENTS = {
  enqueue: "enqueue.altair",
  enqueueAt: "enqueue_at.altair",
  bulkEnqueued: "enqueue_all.altair",
  performStart: "perform_start.altair",
  perform: "perform.altair",
  retryScheduled: "enqueue_retry.altair",
  retryStopped: "retry_stopped.altair",
  discarded: "discard.altair",
  interrupt: "interrupt.altair",
} as const;

/** What every job event carries. */
export interface JobEvent {
  jobClass: string;
  jobId: string;
  queue: string;
  /** How many times it has been tried, including this one. */
  attempts: number;
  error?: unknown;
  /** When a retry is scheduled for, as epoch milliseconds. */
  runAt?: number;
}

function eventFor(payload: JobPayload, extra: Partial<JobEvent> = {}): JobEvent {
  return {
    jobClass: payload.jobClass,
    jobId: payload.id,
    queue: payload.queue,
    attempts: payload.attempts,
    ...extra,
  };
}

/** A job was put on the queue. */
export function successfullyEnqueued(payload: JobPayload): void {
  notifications.publish(
    JOB_EVENTS.enqueue,
    eventFor(payload) as unknown as Record<string, unknown>,
  );
}

/**
 * A job was scheduled for later. Rails' `enqueue_at`.
 *
 * Separate from `enqueue` because the two answer different questions: how much
 * work is arriving, and how much work is waiting. A dashboard that adds them
 * together reports a backlog that is not one.
 */
export function enqueueAt(payload: JobPayload, runAt: number): void {
  notifications.publish(
    JOB_EVENTS.enqueueAt,
    eventFor(payload, { runAt }) as unknown as Record<string, unknown>,
  );
}

/** Several jobs were enqueued together. Rails' `enqueue_all`. */
export function bulkEnqueued(payloads: readonly JobPayload[]): void {
  notifications.publish(JOB_EVENTS.bulkEnqueued, {
    count: payloads.length,
    // The classes rather than every payload: a bulk enqueue can be thousands,
    // and an event carrying all of them is an event that costs more than the
    // work it describes.
    jobClasses: [...new Set(payloads.map((one) => one.jobClass))],
  });
}

/** A worker picked a job up. Rails' `perform_start`. */
export function performStart(payload: JobPayload): void {
  notifications.publish(
    JOB_EVENTS.performStart,
    eventFor(payload) as unknown as Record<string, unknown>,
  );
}

/**
 * A job failed and will be tried again. Rails' `enqueue_retry`.
 *
 * Carries when, because "it will be retried" and "it will be retried in four
 * hours" call for different reactions and only one of them is visible from a
 * queue depth.
 */
export function retryScheduled(payload: JobPayload, error: unknown, runAt: number): void {
  notifications.publish(
    JOB_EVENTS.retryScheduled,
    eventFor(payload, { error, runAt }) as unknown as Record<string, unknown>,
  );
}

/**
 * A job used its last attempt. Rails' `retry_stopped`.
 *
 * Distinct from `discarded`: this one ran out of tries, and a rule decided
 * that one was never going to work. An application usually wants to hear about
 * both and usually wants to do different things about them.
 */
export function retryStopped(payload: JobPayload, error: unknown): void {
  notifications.publish(
    JOB_EVENTS.retryStopped,
    eventFor(payload, { error }) as unknown as Record<string, unknown>,
  );
}

/**
 * A job was thrown away. Rails' `discard`.
 *
 * The event worth alerting on. The work will never happen, nothing remains in
 * the queue to notice, and without this the only record is a log line.
 */
export function discarded(payload: JobPayload, error: unknown): void {
  notifications.publish(
    JOB_EVENTS.discarded,
    eventFor(payload, { error }) as unknown as Record<string, unknown>,
  );
}

/** Runs a job, publishing start and finish around it. Rails' `perform`. */
export async function instrumentPerform<T>(
  payload: JobPayload,
  body: () => Promise<T>,
): Promise<T> {
  performStart(payload);

  return await notifications.instrument(
    JOB_EVENTS.perform,
    eventFor(payload) as unknown as Record<string, unknown>,
    body,
  );
}

/** Callbacks run when a job is discarded, beside the event. */
export type DiscardCallback = (payload: JobPayload, error: unknown) => void | Promise<void>;

const discardCallbacks: DiscardCallback[] = [];

/**
 * Runs something when any job is discarded. Rails' `after_discard`.
 *
 * Beside the notification rather than instead of it: an event is for something
 * watching from outside — a metric, a log, an alert — and this is for the
 * application's own reaction, which usually wants to write a row somewhere or
 * tell a person. Making one do both means an application that wants to react
 * has to subscribe to its own bus.
 */
export function afterDiscard(callback: DiscardCallback): () => void {
  discardCallbacks.push(callback);

  return () => {
    const at = discardCallbacks.indexOf(callback);

    if (at !== -1) discardCallbacks.splice(at, 1);
  };
}

/** Forgets the discard callbacks. For a test, and for a reload. */
export function resetDiscardCallbacks(): void {
  discardCallbacks.length = 0;
}

/**
 * Announces a discard, to the bus and to the callbacks.
 *
 * A callback that throws must not stop the others or turn the discard into a
 * second failure: the job is already lost, and losing the notification too
 * makes it lost and silent.
 */
export async function announceDiscard(payload: JobPayload, error: unknown): Promise<void> {
  discarded(payload, error);

  // Written as well as published, because a queue's own log is where somebody
  // looks first and an event only reaches whatever was subscribed. Through the
  // package's logger rather than the shared one, so an application that expects
  // its jobs to fail — a suite exercising a discard rule — can quieten this
  // alone.
  defaultLogger().error("Job discarded", {
    jobClass: payload.jobClass,
    jobId: payload.id,
    queue: payload.queue,
    attempts: payload.attempts,
    error,
  });

  // A copy, so a callback that registers another does not change what this
  // run visits.
  const running = Array.from(discardCallbacks);

  for (const callback of running) {
    try {
      await callback(payload, error);
    } catch {
      // Deliberately swallowed. Reporting it would need an error reporter that
      // may itself be what failed, and the discard event has already gone out.
    }
  }
}

/**
 * The logger this package writes through. Rails' `logger` on each base class.
 *
 * Its own rather than the shared one so an application can quieten the queue
 * without quietening itself — which with a single logger means turning
 * everything down and then not being able to see its own lines either.
 */
export function defaultLogger(): Logger {
  return componentLogger("jobs");
}

/** Gives this package a logger of its own. Undefined puts the shared one back. */
export function setDefaultLogger(logger: Logger | undefined): void {
  setComponentLogger("jobs", logger);
}
