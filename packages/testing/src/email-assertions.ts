/**
 * Assertions about mail that was queued rather than sent, ported from
 * `ActionMailer::TestHelper` and `actionmailer/test/test_helper_test.rb`.
 *
 * These exist because of a specific way mail tests rot. A test asserts on
 * `Mailer.deliveries`; somebody later changes the code under test from
 * `deliverNow` to `deliverLater` — a good change, it takes SMTP out of the
 * request — and the test goes green while asserting nothing, because the
 * message went to the queue and `deliveries` stayed empty. Nothing failed. The
 * assertion simply stopped being about anything.
 *
 * `captureEmails` is the answer to that: it drains the queue as part of the
 * block, so the test sees the mail whichever way the code chose to send it.
 * The `assertEnqueued*` family is for the cases where the queueing itself is
 * the thing under test.
 */

import { AssertionFailed } from "@altair/support";
import {
  Mailer,
  TestDelivery,
  runObservers,
  type DeliveryQueue,
  type MessageFields,
} from "@altair/mailer";

/**
 * A queue that keeps messages so a test can look at them.
 *
 * Rails' test queue adapter, narrowed to mail. Set as `Mailer.queue` for the
 * duration of a test. The assertions below refuse to run without one rather
 * than installing it, because a test that quietly gets a fresh queue is a test
 * that passes while the application's real queue goes unexercised.
 */
export class TestDeliveryQueue implements DeliveryQueue {
  readonly enqueued: MessageFields[] = [];

  async enqueue(message: MessageFields): Promise<unknown> {
    this.enqueued.push(message);

    return await Promise.resolve(message);
  }

  clear(): void {
    this.enqueued.length = 0;
  }

  /** Takes everything queued so far, leaving the queue empty. */
  drain(): MessageFields[] {
    return this.enqueued.splice(0, this.enqueued.length);
  }
}

/** What a test says it is looking for in a queued message. */
export type EmailMatcher =
  | Partial<Pick<MessageFields, "to" | "from" | "subject" | "cc" | "bcc">>
  | ((message: MessageFields) => boolean);

function matches(message: MessageFields, matcher: EmailMatcher): boolean {
  if (typeof matcher === "function") return matcher(message);

  return Object.entries(matcher).every(([field, expected]) => {
    const actual = (message as unknown as Record<string, unknown>)[field];

    // Compared as JSON so a matcher may name `to: ["a@example.com"]` against a
    // message that holds an array, without each caller writing the compare.
    return actual === expected || JSON.stringify(actual) === JSON.stringify(expected);
  });
}

function describe(matcher: EmailMatcher): string {
  return typeof matcher === "function" ? "the given matcher" : JSON.stringify(matcher);
}

function summarize(messages: readonly MessageFields[]): string {
  if (messages.length === 0) return "none were";

  return messages.map((one) => `${JSON.stringify(one.to)} ${one.subject ?? ""}`.trim()).join("; ");
}

/** The queue a test is asserting against, or an explanation of why there isn't one. */
function testQueue(): TestDeliveryQueue {
  const queue = Mailer.queue;

  if (!(queue instanceof TestDeliveryQueue)) {
    throw new AssertionFailed(
      "Enqueued-email assertions need a TestDeliveryQueue. Set Mailer.queue = new TestDeliveryQueue() first.",
    );
  }

  return queue;
}

/** Runs a block if given, so every assertion below reads the same either way. */
async function during<T>(
  queue: TestDeliveryQueue,
  block: (() => T | Promise<T>) | undefined,
): Promise<MessageFields[]> {
  if (block === undefined) return [...queue.enqueued];

  const before = queue.enqueued.length;

  await block();

  return queue.enqueued.slice(before);
}

/**
 * Asserts how many messages a block put on the queue. Rails'
 * `assert_enqueued_emails`.
 *
 * With no block it counts everything queued so far, which is what a test that
 * sends in its setup wants.
 */
export async function assertEnqueuedEmails(
  count: number,
  block?: () => unknown | Promise<unknown>,
): Promise<void> {
  const queue = testQueue();
  const queued = await during(queue, block);

  if (queued.length !== count) {
    throw new AssertionFailed(
      `Expected ${String(count)} email(s) to be enqueued, got ${String(queued.length)}: ${summarize(queued)}`,
    );
  }
}

/** Asserts a block queued nothing. Rails' `assert_no_enqueued_emails`. */
export async function assertNoEnqueuedEmails(
  block?: () => unknown | Promise<unknown>,
): Promise<void> {
  await assertEnqueuedEmails(0, block);
}

/**
 * Asserts a particular message was queued. Rails'
 * `assert_enqueued_email_with`.
 *
 * Returns the message it matched, so a test can go on to assert about its
 * body rather than fish it back out of the queue by hand.
 */
export async function assertEnqueuedEmailWith(
  matcher: EmailMatcher,
  block?: () => unknown | Promise<unknown>,
): Promise<MessageFields> {
  const queue = testQueue();
  const queued = await during(queue, block);
  const found = queued.find((message) => matches(message, matcher));

  if (found === undefined) {
    throw new AssertionFailed(
      `No enqueued email matched ${describe(matcher)}. Enqueued: ${summarize(queued)}`,
    );
  }

  return found;
}

/**
 * Sends everything the block queued, and anything queued before it. Rails'
 * `deliver_enqueued_emails`.
 *
 * The queue is drained after the block rather than during, so a message queued
 * by a message being delivered is picked up too — a welcome mail that queues a
 * follow-up would otherwise sit there and the test would not see it.
 */
export async function deliverEnqueuedEmails(
  block?: () => unknown | Promise<unknown>,
): Promise<MessageFields[]> {
  const queue = testQueue();

  if (block !== undefined) await block();

  const sent: MessageFields[] = [];

  // A loop, not one drain: delivering can queue more.
  while (queue.enqueued.length > 0) {
    for (const message of queue.drain()) {
      await Mailer.delivery.sendMail(message);

      // Observers run here and interceptors do not, because interceptors
      // already ran when the message was queued — a rule that rewrites every
      // recipient in staging must apply once, and the message on the queue is
      // the rewritten one. Observers record what went out, and nothing went
      // out until now.
      await runObservers(message);

      sent.push(message);
    }
  }

  return sent;
}

/**
 * Everything a block sent, by whichever route. Rails' `capture_emails`.
 *
 * The one to reach for by default. A test written against this keeps working
 * when the code under test moves from `deliverNow` to `deliverLater` or back,
 * because the question it asks — what mail did this produce — is the same
 * question either way, and the delivery mechanism is not what the test is
 * about.
 */
export async function captureEmails(
  block: () => unknown | Promise<unknown>,
): Promise<MessageFields[]> {
  const delivery = Mailer.delivery;

  if (!(delivery instanceof TestDelivery)) {
    throw new AssertionFailed(
      "captureEmails needs a TestDelivery. Set Mailer.delivery = new TestDelivery() first.",
    );
  }

  const before = delivery.deliveries.length;

  await deliverEnqueuedEmails(block);

  return delivery.deliveries.slice(before);
}

/**
 * Asserts a block sent a message, by whichever route. Rails' `assert_emails`
 * over `capture_emails`.
 */
export async function assertCapturedEmails(
  count: number,
  block: () => unknown | Promise<unknown>,
): Promise<MessageFields[]> {
  const captured = await captureEmails(block);

  if (captured.length !== count) {
    throw new AssertionFailed(
      `Expected ${String(count)} email(s) to be sent, got ${String(captured.length)}: ${summarize(captured)}`,
    );
  }

  return captured;
}
