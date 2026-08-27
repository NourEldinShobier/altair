/**
 * Testing what a channel broadcasts, ported from
 * `ActionCable::TestHelper`.
 *
 *     await assertBroadcasts(cable, "chat:1", 1, async () => {
 *       await session.post("/messages", { params: { body: "hi" } })
 *     })
 *
 * The hand-written version means standing up a socket, subscribing it and
 * waiting for a frame — which tests the transport rather than the thing the
 * test is about, and is slow and flaky besides.
 *
 * The recorder wraps the configured broadcaster rather than replacing it, so
 * anything actually subscribed still receives during the block. Rails' test
 * adapter swaps delivery out entirely; there is no reason to, and a test that
 * asserts a broadcast *and* its receipt should not have to choose.
 */

import { AssertionFailed } from "@altair/support";
import type { Broadcaster } from "./channel.js";
import type { Cable } from "./server.js";

/** One broadcast, as it went out. */
export interface RecordedBroadcast {
  stream: string;
  message: unknown;
}

/** A broadcaster that remembers what went through it, and passes it along. */
export class RecordingBroadcaster implements Broadcaster {
  readonly broadcasts: RecordedBroadcast[] = [];

  constructor(private readonly inner?: Broadcaster) {}

  publish(topic: string, payload: string): unknown {
    try {
      const parsed = JSON.parse(payload) as RecordedBroadcast;
      this.broadcasts.push({ stream: parsed.stream, message: parsed.message });
    } catch {
      // A payload this cannot read is still a broadcast, and swallowing it
      // would make the count wrong rather than the message unreadable.
      this.broadcasts.push({ stream: topic, message: payload });
    }

    return this.inner?.publish(topic, payload);
  }
}

/** Everything broadcast during the block, in order. Rails' `capture_broadcasts`. */
export async function captureBroadcasts<T>(
  server: Cable,
  streamOrBody: string | (() => T | Promise<T>),
  maybeBody?: () => T | Promise<T>,
): Promise<RecordedBroadcast[]> {
  const stream = typeof streamOrBody === "string" ? streamOrBody : undefined;
  const body = typeof streamOrBody === "string" ? maybeBody! : streamOrBody;

  const previous = server.broadcaster;
  const recorder = new RecordingBroadcaster(previous);
  server.useBroadcaster(recorder);

  try {
    await body();
  } finally {
    // In a finally, or a block that throws leaves the recorder in place and
    // every later test in the file quietly counts its broadcasts too.
    server.useBroadcaster(previous);
  }

  return stream === undefined
    ? recorder.broadcasts
    : recorder.broadcasts.filter((one) => one.stream === stream);
}

/** Rails' `assert_broadcasts`. */
export async function assertBroadcasts<T>(
  server: Cable,
  stream: string,
  count: number,
  body: () => T | Promise<T>,
): Promise<RecordedBroadcast[]> {
  const seen = await captureBroadcasts(server, stream, body);

  if (seen.length !== count) {
    throw new AssertionFailed(
      `Expected ${count} broadcast(s) on "${stream}", got ${seen.length}.` +
        (seen.length > 0 ? ` Sent: ${JSON.stringify(seen.map((one) => one.message))}` : ""),
    );
  }

  return seen;
}

/** Rails' `assert_no_broadcasts`. */
export async function assertNoBroadcasts<T>(
  server: Cable,
  stream: string,
  body: () => T | Promise<T>,
): Promise<void> {
  await assertBroadcasts(server, stream, 0, body);
}

/**
 * Rails' `assert_broadcast_on`: one particular message went out.
 *
 * Compared by value rather than identity, and the failure says what did go out
 * — "no broadcast matched" sends you looking for a missing call when the real
 * answer is usually one field spelled differently.
 */
export async function assertBroadcastOn<T>(
  server: Cable,
  stream: string,
  expected: unknown,
  body: () => T | Promise<T>,
): Promise<void> {
  const seen = await captureBroadcasts(server, stream, body);
  const wanted = JSON.stringify(expected);

  if (!seen.some((one) => JSON.stringify(one.message) === wanted)) {
    throw new AssertionFailed(
      `No broadcast on "${stream}" matched ${wanted}.` +
        (seen.length === 0
          ? " Nothing was broadcast on that stream."
          : ` Sent: ${JSON.stringify(seen.map((one) => one.message))}`),
    );
  }
}
