/**
 * The events a controller publishes while serving a request, ported from
 * `ActionController::Instrumentation` and `ActionController::LogSubscriber`.
 *
 * `@altair/support`'s log subscriber is the thing on the receiving end. This is
 * the sending end: the payloads, the timing breakdown, and the rule about when
 * an event fires.
 *
 * The breakdown is the part worth care. `Completed 200 OK in 34ms (Views:
 * 20.1ms | ActiveRecord: 5.2ms)` is the single most useful line a Rails
 * application logs, and it is useful because those numbers *decompose* the
 * total: what is left after subtracting them is the controller's own work. Two
 * rules keep that true, and both are easy to get wrong:
 *
 * - **Time is accumulated, not measured once.** A request that renders three
 *   partials and runs eight queries has to add all of them up, or "Views" is
 *   the last render and the number is nonsense in exactly the cases somebody is
 *   investigating.
 * - **The total is the wall clock, not the sum.** Adding the parts and calling
 *   that the total hides everything the parts did not cover — which is the
 *   controller's own code, and the thing being looked for.
 */

/** What an action reports about itself. Rails' `process_action` payload. */
export interface ProcessActionPayload {
  controller: string;
  action: string;
  method: string;
  path: string;
  format?: string;
  status?: number;
  /** Milliseconds inside the view layer. Rails' `view_runtime`. */
  viewRuntime?: number;
  /** Milliseconds inside the database. Rails' `db_runtime`. */
  dbRuntime?: number;
  /** Parameters, already filtered. */
  params?: Record<string, unknown>;
  exception?: [string, string];
  [extra: string]: unknown;
}

/**
 * Adds up time spent in one layer across a whole request. Rails'
 * `view_runtime` / `db_runtime` accumulation.
 *
 * Accumulated rather than measured once, because a request renders many
 * partials and runs many queries — recording only the last leaves the number
 * meaningless in exactly the requests somebody is investigating.
 */
export class RuntimeTotals {
  #totals = new Map<string, number>();

  add(layer: string, milliseconds: number): void {
    this.#totals.set(layer, (this.#totals.get(layer) ?? 0) + milliseconds);
  }

  get(layer: string): number {
    return this.#totals.get(layer) ?? 0;
  }

  /** Everything recorded, for a payload. */
  toPayload(): Record<string, number> {
    return Object.fromEntries(this.#totals);
  }

  reset(): void {
    this.#totals.clear();
  }
}

/**
 * What is left after the measured layers. Rails leaves this implicit; naming
 * it is the point of the whole breakdown.
 *
 * Floored at zero: the parts are measured with separate clocks and can, on a
 * fast request, add to fractionally more than the total. A negative "other" is
 * a measurement artefact rather than something to print.
 */
export function otherRuntime(total: number, parts: Record<string, number>): number {
  const measured = Object.values(parts).reduce((sum, each) => sum + each, 0);

  return Math.max(0, total - measured);
}

/** Rails' `start_processing` payload. */
export function startProcessing(payload: ProcessActionPayload): ProcessActionPayload {
  return { ...payload };
}

/**
 * The completion line. Rails' `log_process_action`.
 *
 * The total is the wall clock rather than the sum of the parts, because the
 * difference between them is the controller's own work — which is the thing
 * anybody reading this line is looking for.
 */
export function logProcessAction(payload: ProcessActionPayload, totalMs: number): string {
  const parts: string[] = [];

  if (payload.viewRuntime !== undefined) parts.push(`Views: ${payload.viewRuntime.toFixed(1)}ms`);
  if (payload.dbRuntime !== undefined) parts.push(`ORM: ${payload.dbRuntime.toFixed(1)}ms`);

  const status = payload.status ?? 200;
  const breakdown = parts.length > 0 ? ` (${parts.join(" | ")})` : "";

  return `Completed ${status} in ${totalMs.toFixed(0)}ms${breakdown}`;
}

/** Rails' `request_started` / `request_completed` markers. */
export function requestStarted(payload: ProcessActionPayload): string {
  return `Started ${payload.method} ${JSON.stringify(payload.path)}`;
}

export function requestCompleted(payload: ProcessActionPayload, totalMs: number): string {
  return logProcessAction(payload, totalMs);
}

// --- events that fire only sometimes ---------------------------------------

/**
 * A filter that stopped the action. Rails' `halted_callback`.
 *
 * Worth its own event because a halted request has a *200 and no action*,
 * which reads in a log exactly like an action that ran and did nothing. The
 * filter's name is the only thing that distinguishes them.
 */
export interface HaltedCallbackPayload {
  filter: string;
  controller: string;
  action: string;
}

export function callbackHalted(
  controller: string,
  action: string,
  filter: string,
): HaltedCallbackPayload {
  return { controller, action, filter };
}

export function haltedCallback(payload: HaltedCallbackPayload): string {
  return `Filter chain halted as ${payload.filter} rendered or redirected`;
}

/** Rails' `send_file` event. */
export function fileSent(
  path: string,
  options: Record<string, unknown> = {},
): Record<string, unknown> {
  return { path, ...options };
}

/**
 * Rails' `send_data` event.
 *
 * The data itself is deliberately not in the payload — only its size. A
 * subscriber that logs payloads would otherwise write whole file contents into
 * the log, which is both enormous and, for anything a user uploaded, a
 * disclosure.
 */
export function dataSent(
  bytes: number,
  options: Record<string, unknown> = {},
): Record<string, unknown> {
  return { bytes, ...options };
}

/** Rails' `redirect_to` event. */
export function redirected(location: string, status: number): Record<string, unknown> {
  return { location, status };
}

/**
 * Rails' `unpermitted_parameters` event.
 *
 * Reported rather than silently dropped, because an unpermitted parameter is
 * usually a rename applied to a form and not to the controller — the field
 * simply stops saving, and nothing anywhere says so.
 */
export function unpermittedParameters(
  keys: readonly string[],
  controller: string,
  action: string,
): Record<string, unknown> {
  return { keys: [...keys], controller, action };
}

/** Rails' `rescue_from_handled` — which handler took an exception. */
export function rescueFromHandled(error: unknown, handler: string): Record<string, unknown> {
  return {
    handler,
    exception: error instanceof Error ? [error.name, error.message] : [typeof error, String(error)],
  };
}

// --- collecting them -------------------------------------------------------

export interface CollectedEvent {
  name: string;
  payload: Record<string, unknown>;
}

/**
 * Gathers the events one request produced. Rails' `collect_events`.
 *
 * Per request rather than globally, so a test can assert what a single action
 * published without a global reset that another test's teardown might race.
 */
export class EventCollector {
  readonly #events: CollectedEvent[] = [];
  #subscribed = false;

  /** Rails' `ensure_subscribed`. */
  ensureSubscribed(subscribe: (record: (event: CollectedEvent) => void) => void): void {
    if (this.#subscribed) return;

    this.#subscribed = true;
    subscribe((event) => this.#events.push(event));
  }

  get subscribed(): boolean {
    return this.#subscribed;
  }

  /** Rails' `collect_events`. */
  collectEvents(name?: string): CollectedEvent[] {
    return name === undefined
      ? [...this.#events]
      : this.#events.filter((each) => each.name === name);
  }

  reset(): void {
    this.#events.length = 0;
  }
}

/**
 * Wraps a body so it publishes start and finish. Rails' `build_instrumented`.
 *
 * Finishes in a `finally` and records the exception on the payload. An action
 * that raised is the one whose timing matters most, and an event that simply
 * does not fire leaves a gap in the log at the moment something went wrong.
 */
export async function buildInstrumented<T>(
  payload: ProcessActionPayload,
  publish: (name: string, payload: ProcessActionPayload, totalMs: number) => void,
  body: () => Promise<T>,
  now: () => number = () => performance.now(),
): Promise<T> {
  const started = now();
  publish("start_processing", payload, 0);

  try {
    return await body();
  } catch (error) {
    payload.exception =
      error instanceof Error ? [error.name, error.message] : [typeof error, String(error)];

    throw error;
  } finally {
    publish("process_action", payload, now() - started);
  }
}
