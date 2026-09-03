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

/**
 * Builds up the context every subscriber sees. Rails' context middleware.
 *
 * Returns the context to carry on with. A middleware that returns nothing is
 * taken to have changed nothing rather than to have emptied it — forgetting
 * the return is the obvious mistake, and its punishment would be every
 * subscriber losing every piece of context anybody attached.
 */
export type ErrorContextMiddleware = (
  error: unknown,
  details: ErrorContext,
) => Record<string, unknown> | undefined | void;

export class ErrorReporter {
  #subscribers: ErrorSubscriber[] = [];
  #middlewares: ErrorContextMiddleware[] = [];

  /**
   * Subscribers that are not to be told, for the length of a block.
   *
   * Scoped, not a flag on the reporter, and Rails scopes it too — per fiber,
   * in `IsolatedExecutionState`. A reporter is process-wide and errors happen
   * everywhere, so a flag would silence one integration for every request
   * running beside the block. Silencing an error tracker for somebody else's
   * request is a failure nobody will ever be told about, which is the one
   * failure mode this class exists to prevent.
   */
  readonly #disabled = new AsyncLocalStorage<readonly ErrorSubscriber[]>();

  subscribe(subscriber: ErrorSubscriber): { unsubscribe(): void } {
    this.#subscribers.push(subscriber);

    return {
      unsubscribe: () => {
        const index = this.#subscribers.indexOf(subscriber);
        if (index !== -1) this.#subscribers.splice(index, 1);
      },
    };
  }

  /**
   * Adds something to the context of every error, before it is reported.
   * Rails' `add_middleware`.
   *
   * The case this is for is the one where a per-call `context:` cannot help:
   * "every report should carry the deploy SHA and the tenant". Attaching that
   * at each call site means the reports that matter most — the ones from
   * places nobody thought about — are the ones without it.
   *
   * Run before any subscriber, so all of them see the same context. A
   * middleware that built the context per-subscriber would give the two error
   * trackers a team runs different pictures of the same failure, which is how
   * an hour goes into reconciling them.
   */
  addMiddleware(middleware: ErrorContextMiddleware): { remove(): void } {
    this.#middlewares.push(middleware);

    return {
      remove: () => {
        const index = this.#middlewares.indexOf(middleware);
        if (index !== -1) this.#middlewares.splice(index, 1);
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
  /**
   * Runs a block without telling one subscriber about anything. Rails'
   * `disable`.
   *
   * For an integration that wants to handle errors higher in the stack: the
   * library reports, the application catches, and the tracker should hear
   * about it once rather than twice. Unsubscribing and resubscribing around
   * the block does the same thing badly — it loses the subscriber's position
   * in the list, and it leaves it unsubscribed if the block throws.
   *
   * Nesting works, and there is nothing to restore: leaving the scope puts
   * back whatever surrounded it.
   */
  async disable<T>(subscriber: ErrorSubscriber, body: () => T | Promise<T>): Promise<T> {
    const already = this.#disabled.getStore() ?? [];

    return await this.#disabled.run([...already, subscriber], async () => await body());
  }

  report(error: unknown, options: ReportOptions = {}): void {
    const context: ErrorContext = {
      handled: options.handled ?? true,
      severity: options.severity ?? (options.handled === false ? "error" : "warning"),
      source: options.source ?? "application",
      context: { ...this.context, ...options.context },
    };

    for (const middleware of this.#middlewares) {
      try {
        // Each one sees what the last one produced, so a middleware can build
        // on another's work rather than each starting from the call's own
        // context and the last writer winning.
        context.context = middleware(error, context) ?? context.context;
      } catch {
        // Same rule as a subscriber that throws: this runs while something has
        // already gone wrong, and a context builder that took the original
        // error down with it would be the worst failure this class could have.
      }
    }

    const silenced = this.#disabled.getStore() ?? [];

    for (const subscriber of this.#subscribers) {
      if (silenced.includes(subscriber)) continue;

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

  /** Forgets every subscriber and every middleware. For tests. */
  reset(): void {
    this.#subscribers = [];
    this.#middlewares = [];
  }
}

/** The one the framework reports to. Rails' `Rails.error`. */
export const errors = new ErrorReporter();
