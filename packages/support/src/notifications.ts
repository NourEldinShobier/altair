/**
 * Instrumentation, ported from `ActiveSupport::Notifications`.
 *
 * The bus every other part of the framework reports through, and the one an
 * application hooks to see what its own request actually did:
 *
 *     notifications.subscribe("sql.altair", (event) => {
 *       if (event.duration > 100) log.warn("slow query", event.payload)
 *     })
 *
 *     await notifications.instrument("sql.altair", { sql }, () => connection.query(sql))
 *
 * Timing uses `performance.now()`, which is monotonic. `Date.now()` can move
 * backwards when the clock is adjusted, and a negative duration in a metric is
 * worse than no metric.
 */

export interface Event<P = Record<string, unknown>> {
  name: string;
  payload: P;
  /** Milliseconds, from a monotonic clock. */
  duration: number;
  startedAt: number;
  finishedAt: number;
  /** Set when the instrumented block threw. The event still fires. */
  error?: unknown;
}

export type Subscriber<P = Record<string, unknown>> = (event: Event<P>) => void;

/** Matches event names: a string for exact, a regex for a family. */
export type Pattern = string | RegExp;

export interface Subscription {
  unsubscribe(): void;
}

interface Registration {
  pattern: Pattern;
  subscriber: Subscriber<never>;
}

export class Notifications {
  #registrations: Registration[] = [];

  /** Subscribes to an event name, or to every name a regex matches. */
  subscribe<P = Record<string, unknown>>(
    pattern: Pattern,
    subscriber: Subscriber<P>,
  ): Subscription {
    const registration: Registration = {
      pattern,
      subscriber: subscriber as unknown as Subscriber<never>,
    };
    this.#registrations.push(registration);

    return {
      unsubscribe: () => {
        const index = this.#registrations.indexOf(registration);
        if (index !== -1) this.#registrations.splice(index, 1);
      },
    };
  }

  /** Whether anything is listening, so a caller can skip building a payload. */
  isSubscribed(name: string): boolean {
    return this.#registrations.some((registration) => matches(registration.pattern, name));
  }

  get subscriberCount(): number {
    return this.#registrations.length;
  }

  /** Drops every subscriber. Used by tests. */
  reset(): void {
    this.#registrations = [];
  }

  /**
   * Times a block and publishes an event.
   *
   * The event fires whether the block returns or throws, because a failing
   * query is exactly the one you want in the log. The error travels on the
   * event and is then rethrown.
   */
  async instrument<T, P extends Record<string, unknown> = Record<string, unknown>>(
    name: string,
    payload: P,
    body: () => T | Promise<T>,
  ): Promise<T> {
    const startedAt = performance.now();

    try {
      const result = await body();
      this.#publish({ name, payload, startedAt, finishedAt: performance.now() });
      return result;
    } catch (error) {
      this.#publish({ name, payload, startedAt, finishedAt: performance.now(), error });
      throw error;
    }
  }

  /** Publishes an event that was timed elsewhere. */
  publish<P extends Record<string, unknown>>(name: string, payload: P, duration = 0): void {
    const finishedAt = performance.now();
    this.#publish({ name, payload, startedAt: finishedAt - duration, finishedAt });
  }

  #publish(event: Omit<Event, "duration">): void {
    const full: Event = { ...event, duration: event.finishedAt - event.startedAt };

    for (const registration of this.#registrations) {
      if (!matches(registration.pattern, full.name)) continue;

      try {
        (registration.subscriber as Subscriber)(full);
      } catch {
        // A broken subscriber must not break the thing it was watching, and
        // must not stop the other subscribers either.
      }
    }
  }
}

function matches(pattern: Pattern, name: string): boolean {
  return typeof pattern === "string" ? pattern === name : pattern.test(name);
}

/** The bus the framework reports through. */
export const notifications = new Notifications();

/**
 * Collects every event a block emits. Rails' `capture_notifications`.
 *
 * What a test uses to say "this ran two queries" or "this sent one email"
 * without the subscribe-and-unsubscribe bookkeeping around every case — and
 * the bookkeeping is where a leaked subscriber comes from, which then reports
 * events from every test after it.
 */
export async function captureNotifications<T>(
  pattern: string | RegExp,
  body: () => T | Promise<T>,
): Promise<[T, Event[]]> {
  const seen: Event[] = [];
  // `subscribe` already takes a name or a pattern, so the filtering is its
  // job rather than this one's.
  const subscription = notifications.subscribe(pattern, (event) => {
    seen.push(event as Event);
  });

  try {
    return [await body(), seen];
  } finally {
    // In a finally, because a block that throws still has to take its
    // subscriber with it.
    subscription.unsubscribe();
  }
}

/** How many of an event a block emitted. */
export async function countNotifications(
  pattern: string | RegExp,
  body: () => unknown,
): Promise<number> {
  const [, seen] = await captureNotifications(pattern, body);

  return seen.length;
}
