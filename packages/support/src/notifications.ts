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

/** Work whose start and finish are in different places. Rails' `Fanout::Handle`. */
export interface EventHandle {
  start: () => void;
  finish: () => void;
  finishWithValues: (name: string, payload: Record<string, unknown>) => void;
}

/**
 * The handle for an event nobody is listening for. Rails' `NullHandle`.
 *
 * An object rather than `undefined`, so a caller never writes `handle?.finish()`
 * — and the one place that forgets the `?` is a crash in production on the path
 * that was supposed to be free.
 */
const nullHandle: EventHandle = {
  start: () => undefined,
  finish: () => undefined,
  finishWithValues: () => undefined,
};

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

  /**
   * The subscribers that would receive this event name. Rails'
   * `listeners_for`.
   *
   * The per-name counterpart to `subscriberCount`, and what a test needs to
   * show that a scoped subscription really went away: a listener that outlives
   * its block is invisible from the outside, since the events still arrive —
   * just to somebody nobody is reading.
   */
  listenersFor(name: string): number {
    return this.#registrations.filter((one) => matches(one.pattern, name)).length;
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

  /**
   * A started event, to be finished later. Rails' `build_handle`.
   *
   * `instrument` covers work that fits in a block, which is most of it. The
   * cases it cannot cover are the ones worth measuring: a request that begins
   * in one middleware and ends in another, a streaming response whose end is a
   * callback, a job that suspends. Timed with a block, those either measure the
   * wrong span — everything up to the first `await` — or are not measured at
   * all, which is why the slow part of a request is so often the part with no
   * instrumentation around it.
   *
   * A handle rather than a pair of loose calls, because the pair has to agree
   * on the name, the payload and the clock, and two call sites that each hold
   * half of that eventually disagree.
   */
  buildHandle<P extends Record<string, unknown>>(
    name: string,
    payload: P,
    // The clock is a parameter so a test can measure a span it chose rather
    // than one it hopes will be long enough, which is how a timing test comes
    // to pass on a laptop and fail in CI.
    now: () => number = () => performance.now(),
  ): EventHandle {
    // Nothing is listening: the handle still exists, so a caller never has to
    // branch, and it does no work and allocates no timestamps.
    if (!this.isSubscribed(name)) return nullHandle;

    let startedAt: number | undefined;
    const publish = this.#publish.bind(this);

    return {
      start() {
        if (startedAt !== undefined) {
          throw new Error(`This ${name} handle was already started.`);
        }

        startedAt = now();
      },

      finish() {
        this.finishWithValues(name, payload);
      },

      /**
       * Rails' `finish_with_values` — finish under a different name or payload.
       *
       * What the payload holds is usually only known at the end: the row count,
       * the status, the error. Requiring it up front means either guessing or
       * mutating the object the handle is holding, and a mutated payload is one
       * a subscriber may already have read.
       */
      finishWithValues(finishedName: string, finishedPayload: Record<string, unknown>) {
        if (startedAt === undefined) {
          throw new Error(`This ${name} handle was not started.`);
        }

        const began = startedAt;
        // Cleared first, so a double finish is refused rather than publishing
        // the same event twice — which double-counts in every metric built on
        // it.
        startedAt = undefined;

        publish({
          name: finishedName,
          payload: finishedPayload,
          startedAt: began,
          finishedAt: now(),
        });
      },
    };
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
 * Rails' `Notifications.notifier` — the bus, as a function.
 *
 * A function rather than the constant alone so a test can substitute one: a
 * suite that subscribed to the shared bus and forgot to unsubscribe reports
 * one test's queries against another's assertions, and the failure names the
 * wrong test.
 */
let current = notifications;

export function notifier(): Notifications {
  return current;
}

export function setNotifier(replacement: Notifications): void {
  current = replacement;
}

export function resetNotifier(): void {
  current = notifications;
}

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
