/**
 * Structured events, ported from `ActiveSupport::EventReporter`, `TagStack`
 * and `EventContext`.
 *
 * `notifications.ts` times a block and tells whoever subscribed how long it
 * took. This is the other half of instrumentation and it answers a different
 * question: not "how long did this take" but "what happened, and in what
 * circumstances".
 *
 *     await withTags({ requestId }, async () => {
 *       events.notify("user.created", { id: user.id })
 *     })
 *
 * The circumstances are the whole point. An event that says a user was created
 * is worth very little; one that says *which request*, *which account* and
 * *which deploy* created them is what an incident is reconstructed from. Making
 * every call site pass all three is how they come to be passed inconsistently,
 * so tags and context are ambient and follow the async call chain — which is
 * also why they are held in `AsyncLocalStorage` rather than a module variable:
 * two requests in flight would otherwise stamp each other's identifiers onto
 * each other's events, and the resulting timeline is worse than none.
 *
 * Three details are load-bearing:
 *
 * - **Subscribers are matched before the payload is built.** The filter sees
 *   only the event's name, and `notify` returns before assembling anything when
 *   nobody wants it. An event nobody is listening for should cost a name
 *   comparison, not a serialised object graph — which is what makes it
 *   reasonable to emit them from a hot path.
 * - **Debug events cost nothing when debug is off.** The payload is a function
 *   for exactly that reason: a `debug` call that built its payload first would
 *   pay for the diagnosis every request, and the calls would then be deleted.
 * - **Payloads are filtered.** An event stream is written to a log and usually
 *   forwarded to somebody else's service, so a payload carrying a password or a
 *   token is a leak that no one reviews again after the call site is written.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { ParameterFilter } from "./filter.js";

export type Tags = Readonly<Record<string, unknown>>;

const EMPTY: Tags = Object.freeze({});

const tags = new AsyncLocalStorage<Tags>();
const context = new AsyncLocalStorage<Tags>();
const debugMode = new AsyncLocalStorage<boolean>();

// --- the circumstances an event carries ------------------------------------

/** Rails' `TagStack.tags` — the tags in force. */
export function tagStack(): Tags {
  return tags.getStore() ?? EMPTY;
}

/**
 * Rails' `TagStack.with_tags`.
 *
 * Merged onto the tags already in force rather than replacing them, so a block
 * inside a request can add what it knows without having to know what the
 * request already added. Frozen, so a subscriber holding one cannot alter the
 * tags of events that have not been emitted yet.
 */
export async function withTags<T>(added: Tags, body: () => Promise<T> | T): Promise<T> {
  const merged = Object.freeze({ ...tagStack(), ...added });

  return await tags.run(merged, async () => await body());
}

/** Rails' `EventContext.context` — the ambient context. */
export function eventContext(): Tags {
  return context.getStore() ?? EMPTY;
}

/**
 * Rails' `set_context`.
 *
 * Context is what stays true for a whole request — the account, the deploy, the
 * job that scheduled this — while tags are what a particular stretch of work
 * adds. Keeping them apart is what lets a subscriber report on one without the
 * other; merged into one bag, a tag added deep in a call would be indexed as a
 * request-level fact and every dashboard grouped by it would be wrong.
 */
export async function setContext<T>(added: Tags, body: () => Promise<T> | T): Promise<T> {
  const merged = Object.freeze({ ...eventContext(), ...added });

  return await context.run(merged, async () => await body());
}

// --- what a subscriber receives --------------------------------------------

export interface SourceLocation {
  file: string;
  line?: number;
}

export interface ReportedEvent {
  name: string;
  payload: Record<string, unknown>;
  tags: Tags;
  context: Tags;
  /** Milliseconds since the epoch. Wall clock, because events are correlated
   * across processes and a monotonic reading means nothing to another machine. */
  timestamp: number;
  source?: SourceLocation;
}

export interface EventSubscriber {
  emit: (event: ReportedEvent) => void;
}

/**
 * Rails' subscription filter — decides whether a subscriber wants an event.
 *
 * Given the name and nothing else, deliberately: the filter runs before the
 * payload exists, which is what lets an unwanted event cost a string
 * comparison.
 */
export type SubscriptionFilter = (event: { name: string }) => boolean;

interface Subscription {
  subscriber: EventSubscriber;
  filter?: SubscriptionFilter;
}

export class EventReporter {
  readonly #subscriptions: Subscription[] = [];
  readonly #filter: ParameterFilter;
  #alwaysDebug = false;

  constructor(filter: ParameterFilter = new ParameterFilter()) {
    this.#filter = filter;
  }

  /**
   * Rails' `subscribe`.
   *
   * Refuses a subscriber that cannot receive an event, at registration rather
   * than at the first event: a subscriber registered at boot and only exercised
   * under load is one nobody finds until the incident it was there for.
   */
  subscribe(subscriber: EventSubscriber, filter?: SubscriptionFilter): void {
    if (typeof subscriber.emit !== "function") {
      throw new TypeError("An event subscriber must have an `emit` method.");
    }

    this.#subscriptions.push(filter ? { subscriber, filter } : { subscriber });
  }

  unsubscribe(subscriber: EventSubscriber): void {
    const at = this.#subscriptions.findIndex((one) => one.subscriber === subscriber);

    if (at !== -1) this.#subscriptions.splice(at, 1);
  }

  subscriberCount(): number {
    return this.#subscriptions.length;
  }

  /** Rails' subscriber matching — by name, before anything is built. */
  subscribersFor(name: string): EventSubscriber[] {
    return this.#subscriptions
      .filter((one) => !one.filter || one.filter({ name }))
      .map((one) => one.subscriber);
  }

  /**
   * Reports an event. Rails' `notify`.
   *
   * The payload is built only once a subscriber has been matched, so an event
   * nobody listens for costs a name comparison.
   */
  notify(
    name: string,
    payload: Record<string, unknown> | (() => Record<string, unknown>) = {},
    options: { source?: SourceLocation; now?: () => number } = {},
  ): boolean {
    const subscribers = this.subscribersFor(name);

    if (subscribers.length === 0) return false;

    const resolved = typeof payload === "function" ? payload() : payload;

    return this.publishEvent(
      {
        name,
        payload: this.#filter.filter(resolved),
        tags: tagStack(),
        context: eventContext(),
        timestamp: (options.now ?? Date.now)(),
        ...(options.source === undefined ? {} : { source: options.source }),
      },
      subscribers,
    );
  }

  /**
   * Hands a built event to its subscribers. Rails' `publish_event`.
   *
   * A subscriber that throws must not break the thing it was watching, and must
   * not stop the subscribers after it: reporting is not the work, and an
   * exporter with an expired token should not take down the request that
   * happened to emit an event.
   */
  publishEvent(
    event: ReportedEvent,
    subscribers: readonly EventSubscriber[] = this.subscribersFor(event.name),
  ): boolean {
    let delivered = false;

    for (const subscriber of subscribers) {
      try {
        subscriber.emit(event);
        delivered = true;
      } catch {
        // Swallowed on purpose. See above.
      }
    }

    return delivered;
  }

  /** Whether `debug` events are being reported. Rails' `debug_mode?`. */
  isDebugMode(): boolean {
    return this.#alwaysDebug || debugMode.getStore() === true;
  }

  /** Turns debug reporting on for every request. For a development process. */
  setDebugMode(enabled: boolean): void {
    this.#alwaysDebug = enabled;
  }

  /**
   * Rails' `with_debug` — debug events for the duration of a block.
   *
   * Scoped rather than global, because the reason to turn it on is one request:
   * globally it is a firehose, and the event worth seeing arrives among
   * thousands that are not.
   */
  async withDebug<T>(body: () => Promise<T> | T): Promise<T> {
    return await debugMode.run(true, async () => await body());
  }

  /**
   * An event reported only in debug mode. Rails' `debug`.
   *
   * The payload may be a function, and that is the point: built eagerly, a
   * debug call would pay for a diagnosis nobody asked for on every request, and
   * the calls would be deleted rather than left where they are useful.
   */
  debug(
    name: string,
    payload: Record<string, unknown> | (() => Record<string, unknown>) = {},
    options: { source?: SourceLocation; now?: () => number } = {},
  ): boolean {
    if (!this.isDebugMode()) return false;

    return this.notify(name, payload, options);
  }

  /** Drops every subscriber. For tests. */
  reset(): void {
    this.#subscriptions.length = 0;
    this.#alwaysDebug = false;
  }
}

/** The reporter the framework and an application share. Rails' `Rails.event`. */
export const events = new EventReporter();
