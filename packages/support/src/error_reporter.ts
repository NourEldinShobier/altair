/**
 * Error reporting, ported from `ActiveSupport::ErrorReporter`.
 *
 * The problem it solves: an application wants every unexpected error to reach
 * whatever it uses to watch for them, and the framework cannot know what that
 * is. Without a seam, every library invents its own hook, and half of them
 * swallow the error instead.
 *
 *     errors.subscribe((error, context) => Sentry.captureException(error, context))
 *
 *     // Swallowed, reported, and a value comes back:
 *     const rate = await errors.handle(() => fetchRate(), { fallback: 1 })
 *
 *     // Reported and re-thrown:
 *     await errors.record(() => chargeCard(order))
 *
 * The distinction is the whole design. `handle` is for work whose failure the
 * request can survive; `record` is for work whose failure it cannot. Having
 * one method that does both is how errors end up silently ignored.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export type Severity = "error" | "warning" | "info";

export interface ErrorContext {
  /** Whether the error was swallowed. Rails records this too. */
  handled: boolean;
  severity: Severity;
  /** Who reported it — `application`, or a library's own name. */
  source: string;
  /** Anything the application attached, plus the ambient context. */
  context: Record<string, unknown>;
}

/** Whatever it returns is ignored, so a one-expression subscriber type-checks. */
export type ErrorSubscriber = (error: unknown, context: ErrorContext) => unknown;

export interface ReportOptions {
  handled?: boolean;
  severity?: Severity;
  source?: string;
  context?: Record<string, unknown>;
}

const contextStore = new AsyncLocalStorage<Record<string, unknown>>();

export class ErrorReporter {
  #subscribers: ErrorSubscriber[] = [];

  subscribe(subscriber: ErrorSubscriber): { unsubscribe(): void } {
    this.#subscribers.push(subscriber);

    return {
      unsubscribe: () => {
        const index = this.#subscribers.indexOf(subscriber);
        if (index !== -1) this.#subscribers.splice(index, 1);
      },
    };
  }

  /** Context attached to everything reported inside the block. */
  get context(): Record<string, unknown> {
    return contextStore.getStore() ?? {};
  }

  /** Rails' `set_context`, scoped to a block rather than to a thread. */
  withContext<T>(context: Record<string, unknown>, body: () => T): T {
    return contextStore.run({ ...this.context, ...context }, body);
  }

  /**
   * Hands an error to every subscriber.
   *
   * A subscriber that throws is caught and ignored. Reporting is what happens
   * when something has already gone wrong; a broken reporter must not replace
   * the original error with its own.
   */
  report(error: unknown, options: ReportOptions = {}): void {
    const context: ErrorContext = {
      handled: options.handled ?? true,
      severity: options.severity ?? (options.handled === false ? "error" : "warning"),
      source: options.source ?? "application",
      context: { ...this.context, ...options.context },
    };

    for (const subscriber of this.#subscribers) {
      try {
        const result = subscriber(error, context);

        // An async subscriber — a call out to whatever watches for errors — is
        // the likeliest one to fail, and its rejection lands nowhere near this
        // try. Left alone it would be an unhandled rejection, which is to say
        // the error reporter would take the process down.
        if (result instanceof Promise) result.catch(() => undefined);
      } catch {
        // Deliberately silent: see above.
      }
    }
  }

  /**
   * Runs a block, reports anything it throws, and returns a fallback.
   *
   * For work whose failure the request can survive — a cache that is down, a
   * recommendation service that timed out.
   */
  async handle<T, F = undefined>(
    body: () => T | Promise<T>,
    options: ReportOptions & { fallback?: F } = {},
  ): Promise<T | F> {
    try {
      return await body();
    } catch (error) {
      this.report(error, { ...options, handled: true });
      return options.fallback as F;
    }
  }

  /**
   * Runs a block, reports anything it throws, and throws it on.
   *
   * For work whose failure the request cannot survive. Separate from `handle`
   * on purpose: one method that both swallows and reports is how an error ends
   * up silently ignored by a caller who thought it was being raised.
   */
  async record<T>(body: () => T | Promise<T>, options: ReportOptions = {}): Promise<T> {
    try {
      return await body();
    } catch (error) {
      this.report(error, { ...options, handled: false, severity: options.severity ?? "error" });
      throw error;
    }
  }

  /** Forgets every subscriber. For tests. */
  reset(): void {
    this.#subscribers = [];
  }
}

/** The one the framework reports to. Rails' `Rails.error`. */
export const errors = new ErrorReporter();
