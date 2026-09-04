/**
 * Turning instrumentation into log lines, ported from
 * `ActiveSupport::Subscriber`, `ActiveSupport::LogSubscriber` and
 * `Notifications::Instrumenter`.
 *
 * `notifications.ts` has the bus. What is missing is the thing on the other end
 * of it: an object whose method names *are* the events it handles, so the ORM
 * publishes `sql.orm` and a subscriber's `sql` method receives it. That
 * indirection is the whole point of the design — the code being measured never
 * mentions logging, so measuring it costs nothing when nobody is listening, and
 * turning logging on is a subscription rather than an edit.
 *
 * Two rules here exist because logging must never be the thing that takes an
 * application down:
 *
 * **A subscriber that throws is reported, not raised.** A logging bug would
 * otherwise fail the request it was describing — an exception in the code that
 * formats a message about a query, surfacing as a failed checkout.
 *
 * **A silenced event does no work at all.** Not "formats the message and
 * discards it": the point of a level check before the call is that a debug line
 * nobody will read does not serialise a query plan on every request.
 */

import type { Event } from "./notifications.js";

/** Where a subscriber writes. Deliberately the smallest surface that works. */
export interface SubscriberLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  flush?(): void;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * An object whose methods are the events it handles. Rails'
 * `ActiveSupport::Subscriber`.
 *
 * The methods are found by reflection rather than declared in a list, because
 * a list is a second place to update and the failure when it drifts is a
 * silent one: the method exists, the event fires, and nothing happens.
 */
export abstract class LogSubscriber {
  logger?: SubscriberLogger;

  /** Per-event minimum level, so one noisy event can be quietened alone. */
  eventLevels: Record<string, LogLevel> = {};

  /** The logger's threshold: anything tagged below this is not written. */
  level: LogLevel = "debug";

  /**
   * Rails' `silenced?`.
   *
   * An event is silenced when the level it is *tagged* with sits below the
   * logger's threshold — a `debug` event under an `info` logger. Comparing the
   * other way round silences exactly the events that should be written and
   * writes the ones that should not, which is a difference no assertion on the
   * happy path can see.
   */
  silenced(eventName: string): boolean {
    if (!this.logger) return true;

    const tagged = this.eventLevels[eventName] ?? this.level;

    return LEVEL_ORDER[tagged] < LEVEL_ORDER[this.level];
  }

  /** Rails' `event_log_level`. */
  eventLogLevel(eventName: string): LogLevel {
    return this.eventLevels[eventName] ?? this.level;
  }

  /** Quietens one event without touching the rest. */
  subscribeLogLevel(eventName: string, level: LogLevel): void {
    this.eventLevels[eventName] = level;
  }

  /**
   * Dispatches one event to the method named after it. Rails' `call`.
   *
   * Every failure path here swallows rather than raises. A logging bug must
   * not fail the request it was describing.
   */
  call(event: Event): void {
    if (this.silenced(event.name)) return;

    const method = (this as unknown as Record<string, unknown>)[methodFor(event.name)];

    if (typeof method !== "function") return;

    try {
      (method as (event: Event) => void).call(this, event);
    } catch (error) {
      this.logException(event.name, error);
    }
  }

  /** Rails' `log_exception`. */
  logException(name: string, error: unknown): void {
    reportSubscriberError(name, error);
    this.logger?.error(`Could not log ${name}: ${String(error)}`);
  }

  flush(): void {
    this.logger?.flush?.();
  }
}

/** The method an event name dispatches to: `sql.orm` -> `sql`. */
export function methodFor(eventName: string): string {
  return eventName.split(".")[0] as string;
}

/** Rails' `prepare_pattern` — the event name a method subscribes to. */
export function eventMatcher(method: string, namespace: string): string {
  return `${method}.${namespace}`;
}

/**
 * Whether a name could be an event handler. Rails' `invalid_event?`.
 *
 * Anything inherited from the base class is machinery, not a handler.
 * Subscribing `call` or `flush` to an event named after them is a loop.
 */
const RESERVED = new Set([
  "call",
  "flush",
  "silenced",
  "logException",
  "eventLogLevel",
  "subscribeLogLevel",
  "constructor",
]);

export function fetchPublicMethods(subscriber: object): string[] {
  const found = new Set<string>();

  for (
    let proto = Object.getPrototypeOf(subscriber);
    proto && proto !== Object.prototype && proto !== LogSubscriber.prototype;
    proto = Object.getPrototypeOf(proto)
  ) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (RESERVED.has(name) || name.startsWith("_")) continue;
      if (typeof (subscriber as Record<string, unknown>)[name] !== "function") continue;

      found.add(name);
    }
  }

  return [...found];
}

// --- attaching -------------------------------------------------------------

/** What a bus has to offer for a subscriber to attach to it. */
export interface SubscribableBus {
  subscribe(pattern: string, handler: (event: Event) => void): { unsubscribe(): void };
}

interface Attachment {
  namespace: string;
  subscriber: LogSubscriber;
  subscriptions: { unsubscribe(): void }[];
  patterns: string[];
}

const attachments: Attachment[] = [];

/**
 * Subscribes every handler method a subscriber has. Rails' `attach_to`.
 *
 * One subscription per method rather than one for the namespace, so an event
 * with no handler costs nothing: the bus never calls us, instead of calling us
 * to find out there is nothing to do.
 */
export function attachTo(
  namespace: string,
  subscriber: LogSubscriber,
  bus: SubscribableBus,
): string[] {
  const patterns = fetchPublicMethods(subscriber).map((method) => eventMatcher(method, namespace));

  const subscriptions = patterns.map((pattern) =>
    bus.subscribe(pattern, (event) => {
      subscriber.call(event);
    }),
  );

  attachments.push({ namespace, subscriber, subscriptions, patterns });

  return patterns;
}

/**
 * Rails' `detach_from`.
 *
 * Unsubscribes rather than setting a flag. A subscriber that stays attached
 * and returns early still holds a reference to everything it closed over, and
 * in a reloading development process that is one leaked object graph per
 * reload.
 */
export function detachFrom(namespace: string, subscriber?: LogSubscriber): number {
  let removed = 0;

  for (let index = attachments.length - 1; index >= 0; index -= 1) {
    const attachment = attachments[index] as Attachment;

    if (attachment.namespace !== namespace) continue;
    if (subscriber && attachment.subscriber !== subscriber) continue;

    for (const subscription of attachment.subscriptions) subscription.unsubscribe();

    attachments.splice(index, 1);
    removed += 1;
  }

  return removed;
}

/** Rails' `log_subscribers`. */
export function logSubscribers(namespace?: string): LogSubscriber[] {
  return attachments
    .filter((each) => namespace === undefined || each.namespace === namespace)
    .map((each) => each.subscriber);
}

/** Rails' `subscribers` — every attached one, whatever the namespace. */
export function subscribers(): LogSubscriber[] {
  return attachments.map((each) => each.subscriber);
}

/** The patterns something is listening on. Rails' `all_listeners_for`. */
export function allListenersFor(namespace: string): string[] {
  return attachments
    .filter((each) => each.namespace === namespace)
    .flatMap((each) => each.patterns);
}

/** Rails' `subscribed_to?`. */
export function subscribedTo(pattern: string): boolean {
  return attachments.some((each) => each.patterns.includes(pattern));
}

export function detachAll(): void {
  for (const attachment of attachments) {
    for (const subscription of attachment.subscriptions) subscription.unsubscribe();
  }

  attachments.length = 0;
}

/** Rails' `flush_all!`. */
export function flushAll(): void {
  for (const attachment of attachments) attachment.subscriber.flush();
}

/** Where a subscriber's own failures go, so they are neither raised nor lost. */
let reportError: (name: string, error: unknown) => void = () => undefined;

export function onSubscriberError(report: (name: string, error: unknown) => void): void {
  reportError = report;
}

function reportSubscriberError(name: string, error: unknown): void {
  reportError(name, error);
}

// --- measuring -------------------------------------------------------------

/** A measurement in progress. Rails' `Notifications::Event`. */
export class EventRecord {
  readonly name: string;
  payload: Record<string, unknown>;

  #startedAt = 0;
  #finishedAt: number | undefined;
  #cpuStart = 0;
  #cpuFinish = 0;

  constructor(name: string, payload: Record<string, unknown> = {}) {
    this.name = name;
    this.payload = payload;
  }

  /** Rails' `start!`. */
  start(now = performance.now(), cpu = cpuNow()): void {
    this.#startedAt = now;
    this.#cpuStart = cpu;
    this.#finishedAt = undefined;
  }

  /** Rails' `finish!`. */
  finish(now = performance.now(), cpu = cpuNow()): void {
    this.#finishedAt = now;
    this.#cpuFinish = cpu;
  }

  get startedAt(): number {
    return this.#startedAt;
  }

  get finishedAt(): number | undefined {
    return this.#finishedAt;
  }

  /** Milliseconds of wall clock. Rails' `duration`. */
  get duration(): number {
    return (this.#finishedAt ?? this.#startedAt) - this.#startedAt;
  }

  /** Rails' `cpu_time`. */
  get cpuTime(): number {
    return this.#cpuFinish - this.#cpuStart;
  }

  /**
   * Wall clock minus processor time. Rails' `idle_time`.
   *
   * Which is the number that says whether a slow request was slow because of
   * *us* or because it was waiting on a database — the first question anyone
   * asks, and the one a bare duration cannot answer.
   *
   * Floored at zero: the two clocks are sampled separately, so on a short span
   * cpu time can read fractionally above wall time, and a negative idle time is
   * a measurement artefact rather than something to display.
   */
  get idleTime(): number {
    return Math.max(0, this.duration - this.cpuTime);
  }

  /**
   * Runs a body, measuring it. Rails' `record`.
   *
   * The finish is in a `finally` and the exception is recorded on the payload
   * before it is rethrown, because a failed operation is exactly the one worth
   * having a timing for — and an event that simply vanishes when its body
   * raises leaves a gap in the log at the moment something went wrong.
   */
  record<T>(body: () => T): T {
    this.start();

    try {
      return body();
    } catch (error) {
      this.payload["exception"] = [errorName(error), errorMessage(error)];
      this.payload["exceptionObject"] = error;

      throw error;
    } finally {
      this.finish();
    }
  }

  async recordAsync<T>(body: () => Promise<T>): Promise<T> {
    this.start();

    try {
      return await body();
    } catch (error) {
      this.payload["exception"] = [errorName(error), errorMessage(error)];
      this.payload["exceptionObject"] = error;

      throw error;
    } finally {
      this.finish();
    }
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Processor time in milliseconds, where the runtime offers it. */
export function cpuNow(): number {
  const usage = (process as unknown as { cpuUsage?: () => { user: number; system: number } })
    .cpuUsage;

  if (typeof usage !== "function") return 0;

  const { user, system } = usage.call(process);

  return (user + system) / 1000;
}

/** Rails' `new_event`. */
export function newEvent(name: string, payload: Record<string, unknown> = {}): EventRecord {
  return new EventRecord(name, payload);
}

/** What an instrumenter does with a measured event. */
export type Publisher = (event: EventRecord) => void;

/**
 * Measures a block and publishes the result. Rails' `Instrumenter#instrument`.
 *
 * Publishing happens after the body in a `finally`, so a raising body is still
 * reported — with the exception on its payload, which is what lets a log
 * subscriber say "this query failed after 3 seconds" rather than nothing.
 */
export class Instrumenter {
  constructor(private readonly publish: Publisher) {}

  instrument<T>(name: string, payload: Record<string, unknown>, body: () => T): T {
    const event = newEvent(name, payload);

    try {
      return event.record(body);
    } finally {
      this.publish(event);
    }
  }

  async instrumentAsync<T>(
    name: string,
    payload: Record<string, unknown>,
    body: () => Promise<T>,
  ): Promise<T> {
    const event = newEvent(name, payload);

    try {
      return await event.recordAsync(body);
    } finally {
      this.publish(event);
    }
  }

  /** Rails' `start`/`finish` pair, for a span that does not nest in a block. */
  start(name: string, payload: Record<string, unknown> = {}): EventRecord {
    const event = newEvent(name, payload);
    event.start();

    return event;
  }

  /** Rails' `finish_with_state`. */
  finishWithState(event: EventRecord, payload: Record<string, unknown> = {}): EventRecord {
    event.finish();
    event.payload = { ...event.payload, ...payload };
    this.publish(event);

    return event;
  }
}

/**
 * An instrumenter that measures nothing. Rails' `NullInstrumenter`.
 *
 * Not an `if` at every call site. The cost of instrumentation with nobody
 * listening should be one virtual call, and the code being measured should not
 * have to know whether anything is.
 */
export const nullInstrumenter = new Instrumenter(() => undefined);
