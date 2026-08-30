/**
 * Declaring what to do about an error, ported from `ActiveSupport::Rescuable`.
 *
 *     rescueFrom(handlers, RecordNotFound, () => notFound())
 *     rescueFrom(handlers, "PaymentDeclined", (error) => retryLater(error))
 *
 * A try/catch handles the errors of one block. This handles the errors of a
 * whole class of work — every action on a controller, every job of a kind —
 * which is where most error handling actually belongs: nobody wants a
 * `RecordNotFound` rescue around each of seven actions, and the one that gets
 * forgotten is the one that 500s.
 *
 * Handlers are matched most-recently-declared first, which is Rails' rule and
 * the one that makes a subclass able to override its parent without removing
 * anything.
 */

/** What a handler is given, and what it may answer. */
export type RescueHandler<T = unknown> = (error: unknown) => T | Promise<T>;

/** A class to match on, or the name of one. */
export type RescueMatcher = (new (...args: never[]) => Error) | string;

interface Registration<T> {
  matcher: RescueMatcher;
  handler: RescueHandler<T>;
}

/** A list of declarations, held by whatever owns them. */
export class RescueHandlers<T = unknown> {
  #registrations: Registration<T>[] = [];

  /** A copy, for a subclass that must not disturb its parent's list. */
  clone(): RescueHandlers<T> {
    const copy = new RescueHandlers<T>();
    copy.#registrations = [...this.#registrations];

    return copy;
  }

  get size(): number {
    return this.#registrations.length;
  }

  add(matcher: RescueMatcher, handler: RescueHandler<T>): void {
    this.#registrations.push({ matcher, handler });
  }

  /**
   * The handler for an error, or undefined. Rails' `handler_for_rescue`.
   *
   * Searched in reverse, so the most recent declaration wins. That is what
   * lets a subclass override a handler its parent declared by simply
   * declaring its own — without a way to remove one, first-match-wins would
   * make the parent's permanent.
   */
  handlerFor(error: unknown): RescueHandler<T> | undefined {
    for (let index = this.#registrations.length - 1; index >= 0; index -= 1) {
      const registration = this.#registrations[index]!;
      if (matches(registration.matcher, error)) return registration.handler;
    }

    return undefined;
  }

  /** Whether anything would handle this error. */
  handles(error: unknown): boolean {
    return this.handlerFor(error) !== undefined;
  }
}

/**
 * Matches by name as well as by class.
 *
 * The name form is for an error a module raises that the declaring code cannot
 * import without a cycle — a controller rescuing a database error, where the
 * controller has no business depending on the adapter. Matching walks the
 * prototype chain, so a name matches a subclass too.
 */
function matches(matcher: RescueMatcher, error: unknown): boolean {
  if (typeof matcher !== "string") return error instanceof matcher;
  if (!(error instanceof Error)) return false;

  for (
    let current: object | null = error;
    current;
    current = Object.getPrototypeOf(current) as object | null
  ) {
    if (current.constructor?.name === matcher) return true;
  }

  return false;
}

/** Declares a handler. Rails' `rescue_from`. */
export function rescueFrom<T>(
  handlers: RescueHandlers<T>,
  matcher: RescueMatcher,
  handler: RescueHandler<T>,
): void {
  handlers.add(matcher, handler);
}

/**
 * Runs the handler for an error, or rethrows. Rails' `rescue_with_handler`.
 *
 * Rethrows rather than swallowing, because an error nobody declared a handler
 * for is not handled — and returning undefined for it would turn every
 * unanticipated failure into a silently empty response.
 */
export async function rescueWithHandler<T>(
  handlers: RescueHandlers<T>,
  error: unknown,
): Promise<T> {
  const handler = handlers.handlerFor(error);
  if (!handler) throw error;

  return await handler(error);
}

/** The handler for an error, or undefined. Rails' `handler_for_rescue`. */
export function handlerForRescue<T>(
  handlers: RescueHandlers<T>,
  error: unknown,
): RescueHandler<T> | undefined {
  return handlers.handlerFor(error);
}
