/**
 * Testing a channel's subscription, ported from
 * `ActionCable::Channel::TestCase`.
 *
 *     const subscription = await stubConnection(ChatChannel, { room: "1" })
 *     assertHasStream(subscription, "chat:1")
 *
 * The neighbouring [testing.ts](./testing.ts) answers "what went out on the
 * wire". This answers the question before it: whether subscribing put the
 * socket on the streams it should have, and whether it was accepted at all.
 *
 * A channel's `subscribed` is where the authorisation lives — the line that
 * rejects a subscriber who should not see a room — and testing it through a
 * real socket means standing up a server to assert one boolean.
 */

import { AssertionFailed } from "@altair/support";
import { Channel, type Broadcaster, type CableSocket, type ConnectionContext } from "./channel.js";

/** A socket that records rather than sends. */
class RecordingSocket implements CableSocket {
  readonly sent: unknown[] = [];
  readonly subscribed: string[] = [];
  readonly unsubscribed: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  subscribe(topic: string): void {
    this.subscribed.push(topic);
  }

  unsubscribe(topic: string): void {
    this.unsubscribed.push(topic);
  }

  close(): void {}
}

/** A channel that was subscribed without a server, and what it did. */
export interface StubbedSubscription<C extends Channel = Channel> {
  channel: C;
  /** Whether `subscribed` called `reject`. */
  rejected: boolean;
  /** Whether it was accepted, which is the more common thing to assert. */
  confirmed: boolean;
  /** The streams it asked for. */
  streamNames: readonly string[];
  /** Everything it transmitted during the subscribe. */
  transmissions: unknown[];
}

/**
 * Subscribes a channel with no server behind it. Rails' `subscribe`.
 *
 * The connection context is whatever the channel reads off it — usually the
 * current user — so a test supplies just that rather than a whole session.
 */
export async function stubConnection<C extends Channel>(
  channelClass: new (context: {
    socket: CableSocket;
    connection: ConnectionContext;
    identifier: string;
    params: Record<string, unknown>;
    broadcaster: Broadcaster;
  }) => C,
  params: Record<string, unknown> = {},
  connection: ConnectionContext = {} as ConnectionContext,
): Promise<StubbedSubscription<C>> {
  const socket = new RecordingSocket();
  const broadcaster: Broadcaster = { publish: () => undefined };

  const channel = new channelClass({
    socket,
    connection,
    identifier: JSON.stringify({ channel: channelClass.name, ...params }),
    params,
    broadcaster,
  });

  await channel.subscribed();

  const rejected = channel.isRejected;

  return {
    channel,
    rejected,
    confirmed: !rejected,
    streamNames: channel.streams,
    transmissions: socket.sent.map((one) => JSON.parse(one as string) as unknown),
  };
}

/** Asserts the subscription streams from this name. Rails' `assert_has_stream`. */
export function assertHasStream(subscription: StubbedSubscription, stream: string): void {
  if (!subscription.streamNames.includes(stream)) {
    throw new AssertionFailed(
      `Expected a stream from "${stream}", got: ${subscription.streamNames.join(", ") || "none"}`,
    );
  }
}

/** The other way round. Rails' `assert_has_no_stream`. */
export function assertHasNoStream(subscription: StubbedSubscription, stream: string): void {
  if (subscription.streamNames.includes(stream)) {
    throw new AssertionFailed(`Expected no stream from "${stream}", but there was one`);
  }
}

/**
 * Asserts it streams for a record. Rails' `assert_has_stream_for`.
 *
 * Goes through the same `broadcastingFor` the channel used, so a test does not
 * restate the naming scheme — and does not keep passing when the scheme changes
 * under it.
 */
export function assertHasStreamFor(
  subscription: StubbedSubscription,
  channelClass: typeof Channel,
  model: unknown,
): void {
  assertHasStream(subscription, channelClass.broadcastingFor(model));
}

/** The other way round. Rails' `assert_has_no_stream_for`. */
export function assertHasNoStreamFor(
  subscription: StubbedSubscription,
  channelClass: typeof Channel,
  model: unknown,
): void {
  assertHasNoStream(subscription, channelClass.broadcastingFor(model));
}

/** Asserts it subscribed to nothing at all. Rails' `assert_no_streams`. */
export function assertNoStreams(subscription: StubbedSubscription): void {
  if (subscription.streamNames.length > 0) {
    throw new AssertionFailed(`Expected no streams, got: ${subscription.streamNames.join(", ")}`);
  }
}

/**
 * Asserts the subscription was refused. Rails' `assert_reject_connection`.
 *
 * The one worth writing for every channel that has a `reject` in it: an
 * authorisation branch nobody asserts on is an authorisation branch that can be
 * deleted without a single test noticing.
 */
export function assertRejectConnection(subscription: StubbedSubscription): void {
  if (!subscription.rejected) {
    throw new AssertionFailed("Expected the subscription to be rejected, and it was accepted");
  }
}

/** Asserts it was accepted. */
export function assertConfirmedConnection(subscription: StubbedSubscription): void {
  if (!subscription.confirmed) {
    throw new AssertionFailed("Expected the subscription to be accepted, and it was rejected");
  }
}
