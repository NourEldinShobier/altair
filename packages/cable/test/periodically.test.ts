/**
 * Timers and leaving one stream, ported from
 * `actioncable/test/channel/periodic_timers_test.rb` and
 * `stream_test.rb`.
 *
 * `periodically` is for state that changes with nothing to broadcast from — a
 * count of who is online, a queue depth, a clock. The alternative is the client
 * polling over HTTP: a request, a session lookup and a connection for every
 * tick on every open tab.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { Channel, type CableSocket, type ChannelContext } from "../src/index.js";

/** A socket that records rather than sends. */
function socketDouble() {
  const sent: string[] = [];
  const subscribed: string[] = [];
  const unsubscribed: string[] = [];

  const socket: CableSocket = {
    send: (data: string) => void sent.push(data),
    subscribe: (topic: string) => void subscribed.push(topic),
    unsubscribe: (topic: string) => void unsubscribed.push(topic),
    close: () => undefined,
  };

  return { socket, sent, subscribed, unsubscribed };
}

const channelWith = <T extends Channel>(
  Klass: new (context: ChannelContext) => T,
  socket: CableSocket,
): T =>
  new Klass({
    socket,
    connection: { request: new Request("https://app.example/cable") },
    identifier: '{"channel":"Test"}',
    params: {},
    broadcaster: { publish: () => undefined },
  });

const built: Channel[] = [];

afterEach(() => {
  // Every timer stopped, or a leaked one keeps ticking through the rest of the
  // file and the failures land in whichever test happens to be running.
  for (const channel of built) channel.clearTimers();
  built.length = 0;
});

const track = <T extends Channel>(channel: T): T => {
  built.push(channel);
  return channel;
};

describe("a periodic timer", () => {
  it("runs the body more than once", async () => {
    class Dashboard extends Channel {}

    const { socket } = socketDouble();
    const channel = track(channelWith(Dashboard, socket));

    let ticks = 0;
    channel.periodically(() => void (ticks += 1), 0.01);

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(ticks).toBeGreaterThan(1);
  });

  it("can transmit to this subscriber only", async () => {
    class Dashboard extends Channel {}

    const { socket, sent } = socketDouble();
    const channel = track(channelWith(Dashboard, socket));

    channel.periodically(() => channel.transmit({ online: 3 }), 0.01);
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(sent.length).toBeGreaterThan(0);
    expect(sent[0]).toContain('"online":3');
  });

  /**
   * A timer that outlives its socket transmits into a closed connection
   * forever, and there is one per subscriber.
   */
  it("stops when the timers are cleared", async () => {
    class Dashboard extends Channel {}

    const { socket } = socketDouble();
    const channel = channelWith(Dashboard, socket);

    let ticks = 0;
    channel.periodically(() => void (ticks += 1), 0.01);

    await new Promise((resolve) => setTimeout(resolve, 40));
    channel.clearTimers();

    const after = ticks;
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(ticks).toBe(after);
  });

  /**
   * An unhandled rejection in a timer takes the process down, and one
   * subscriber's failing tick is not a reason to drop every other connection.
   */
  it("survives a body that throws", async () => {
    const seen: unknown[] = [];

    class Broken extends Channel {
      protected override onPeriodicError(error: unknown): void {
        seen.push(error);
      }
    }

    const { socket } = socketDouble();
    const channel = track(channelWith(Broken, socket));

    channel.periodically(() => {
      throw new Error("the counter is down");
    }, 0.01);

    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(seen.length).toBeGreaterThan(0);
  });

  it("survives a body whose promise rejects", async () => {
    const seen: unknown[] = [];

    class Broken extends Channel {
      protected override onPeriodicError(error: unknown): void {
        seen.push(error);
      }
    }

    const { socket } = socketDouble();
    const channel = track(channelWith(Broken, socket));

    channel.periodically(async () => {
      throw new Error("the counter is down");
    }, 0.01);

    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(seen.length).toBeGreaterThan(0);
  });

  it("refuses an interval of zero, which is a busy loop per subscriber", () => {
    class Dashboard extends Channel {}

    const { socket } = socketDouble();
    const channel = track(channelWith(Dashboard, socket));

    expect(() => channel.periodically(() => undefined, 0)).toThrow(/greater than zero/);
    expect(() => channel.periodically(() => undefined, -1)).toThrow(/greater than zero/);
  });
});

/**
 * For a channel that follows something moving — the room a person is looking
 * at, the order being watched. Without it the only way off a stream is off all
 * of them, so switching rooms means unsubscribing from the presence stream too
 * and quietly going offline.
 */
describe("leaving one stream", () => {
  it("leaves that one and keeps the rest", () => {
    class Rooms extends Channel {}

    const { socket, unsubscribed } = socketDouble();
    const channel = track(channelWith(Rooms, socket));

    channel.streamFrom("room:1");
    channel.streamFrom("presence");

    channel.stopStreamFrom("room:1");

    expect(channel.streams).toEqual(["presence"]);
    expect(unsubscribed).toHaveLength(1);
  });

  it("says nothing about a stream it was never on", () => {
    class Rooms extends Channel {}

    const { socket, unsubscribed } = socketDouble();
    const channel = track(channelWith(Rooms, socket));

    channel.streamFrom("room:1");
    channel.stopStreamFrom("room:2");

    expect(channel.streams).toEqual(["room:1"]);
    expect(unsubscribed).toHaveLength(0);
  });

  it("still leaves everything at once when asked", () => {
    class Rooms extends Channel {}

    const { socket, unsubscribed } = socketDouble();
    const channel = track(channelWith(Rooms, socket));

    channel.streamFrom("room:1");
    channel.streamFrom("presence");
    channel.stopAllStreams();

    expect(channel.streams).toEqual([]);
    expect(unsubscribed).toHaveLength(2);
  });
});
