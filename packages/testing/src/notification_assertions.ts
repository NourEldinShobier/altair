/**
 * Assertions about what a block put on the instrumentation bus.
 *
 * Instrumentation is how the framework reports what it did without knowing who
 * is listening, and that indirection is exactly what makes it easy to break: a
 * refactor stops publishing an event and nothing fails, because nothing was
 * asserting on it. These are how a test says the event is part of the contract.
 */

import { AssertionFailed, notifications, type Event, type Pattern } from "@altair/support";

/** Every event matching the pattern that the block published. */
async function collect<T>(
  pattern: Pattern,
  body: () => T | Promise<T>,
): Promise<{ result: T; events: Event[] }> {
  const events: Event[] = [];
  const subscription = notifications.subscribe(pattern, (event) => {
    events.push(event as Event);
  });

  try {
    return { result: await body(), events };
  } finally {
    // In a finally, so a block that throws still unsubscribes. Without this a
    // failing test leaves a listener on the global bus and every later test in
    // the file collects its events too.
    subscription.unsubscribe();
  }
}

/**
 * Asserts the block published at least one matching event, and gives them back.
 *
 * Returned rather than only asserted, so a caller can go on to check the
 * payload — which is usually the part that matters, since the event firing at
 * all is the easy half.
 */
export async function assertNotification<T = unknown>(
  pattern: Pattern,
  body: () => T | Promise<T>,
): Promise<Event[]> {
  const { events } = await collect(pattern, body);

  if (events.length === 0) {
    throw new AssertionFailed(`Expected a notification matching ${String(pattern)}, got none`);
  }

  return events;
}

/** Asserts exactly this many matching events. Rails' `assert_notifications_count`. */
export async function assertNotificationsCount<T = unknown>(
  pattern: Pattern,
  count: number,
  body: () => T | Promise<T>,
): Promise<Event[]> {
  const { events } = await collect(pattern, body);

  if (events.length !== count) {
    throw new AssertionFailed(
      `Expected ${count} notification(s) matching ${String(pattern)}, got ${events.length}`,
    );
  }

  return events;
}

/**
 * Asserts the block published nothing matching. Rails' `assert_no_notifications`.
 *
 * The one that catches a cache that stopped hitting, or a query running where
 * a test believed nothing touched the database.
 */
export async function assertNoNotifications<T = unknown>(
  pattern: Pattern,
  body: () => T | Promise<T>,
): Promise<void> {
  const { events } = await collect(pattern, body);

  if (events.length > 0) {
    throw new AssertionFailed(
      `Expected no notification matching ${String(pattern)}, got ${events.length}: ` +
        events.map((event) => event.name).join(", "),
    );
  }
}
