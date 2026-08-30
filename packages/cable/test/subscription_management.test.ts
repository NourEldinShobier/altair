/**
 * Dropping subscriptions without closing the socket, ported from the
 * `unsubscribe_from_all` and `remove_subscription` cases in
 * `actioncable/test/connection/subscriptions_test.rb`.
 *
 * A permissions change means the connection is still valid — the person is
 * still signed in — and only what they may listen to has changed. Closing the
 * socket instead logs them out of a chat to tell them they have left a room.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Cable, type SocketData } from "../src/server.js";
import { Channel, type CableSocket } from "../src/channel.js";
import { connectedIdentifiers, disconnectAll, resetIdentifiers } from "../src/identity.js";

function fakeSocket(data: SocketData): CableSocket & { data: SocketData; sent: string[] } {
  const sent: string[] = [];

  return {
    data,
    sent,
    send: (frame: string) => sent.push(frame),
    subscribe: () => undefined,
    unsubscribe: () => undefined,
    close: () => undefined,
  } as unknown as CableSocket & { data: SocketData; sent: string[] };
}

let left: string[] = [];

class RoomChannel extends Channel {
  static override channelName = "RoomChannel";

  override async subscribed(): Promise<void> {
    this.streamFrom(`room:${String(this.params.id ?? 1)}`);
  }

  override async unsubscribed(): Promise<void> {
    left.push(`room:${String(this.params.id ?? 1)}`);
  }
}

let cable: Cable;

beforeEach(() => {
  resetIdentifiers();
  Channel.resetRegistry();
  Channel.register(RoomChannel);
  cable = new Cable();
  left = [];
});

afterEach(() => {
  for (const identifier of connectedIdentifiers()) disconnectAll(identifier);
  resetIdentifiers();
});

async function open(): Promise<ReturnType<typeof fakeSocket>> {
  const data = await cable.upgradeData(
    new Request("https://app.test/cable", { headers: { origin: "https://app.test" } }),
  );
  const socket = fakeSocket(data as SocketData);

  cable.handlers().open(socket);

  return socket;
}

function identifierFor(id: number): string {
  return JSON.stringify({ channel: "RoomChannel", id });
}

async function subscribe(socket: CableSocket & { data: SocketData }, id: number): Promise<void> {
  await cable
    .handlers()
    .message(socket, JSON.stringify({ command: "subscribe", identifier: identifierFor(id) }));
}

describe("removeSubscription", () => {
  it("drops the one named", async () => {
    const socket = await open();

    await subscribe(socket, 1);
    await subscribe(socket, 2);

    await cable.removeSubscription(socket, identifierFor(1));

    expect(cable.subscriptionsOn(socket)).toEqual([identifierFor(2)]);
  });

  it("stops delivering to it", async () => {
    const socket = await open();

    await subscribe(socket, 1);
    await cable.removeSubscription(socket, identifierFor(1));
    socket.sent.length = 0;

    cable.broadcastTo("room:1", { hello: true });

    expect(socket.sent).toEqual([]);
  });

  it("leaves the other stream delivering", async () => {
    const socket = await open();

    await subscribe(socket, 1);
    await subscribe(socket, 2);
    await cable.removeSubscription(socket, identifierFor(1));
    socket.sent.length = 0;

    cable.broadcastTo("room:2", { hello: true });

    expect(socket.sent).not.toEqual([]);
  });

  it("tells the channel it was unsubscribed", async () => {
    const socket = await open();

    await subscribe(socket, 1);
    await cable.removeSubscription(socket, identifierFor(1));

    expect(left).toEqual(["room:1"]);
  });

  it("is quiet about one that is not there", async () => {
    const socket = await open();

    expect(await cable.removeSubscription(socket, identifierFor(9))).toBeUndefined();
  });

  /** The whole point: the socket stays up. */
  it("leaves the connection open", async () => {
    const socket = await open();

    await subscribe(socket, 1);
    await cable.removeSubscription(socket, identifierFor(1));

    expect(cable.connectionCount).toBe(1);
  });
});

describe("unsubscribeFromAll", () => {
  it("drops every subscription", async () => {
    const socket = await open();

    await subscribe(socket, 1);
    await subscribe(socket, 2);

    await cable.unsubscribeFromAll(socket);

    expect(cable.subscriptionsOn(socket)).toEqual([]);
  });

  it("says how many it dropped", async () => {
    const socket = await open();

    await subscribe(socket, 1);
    await subscribe(socket, 2);

    expect(await cable.unsubscribeFromAll(socket)).toBe(2);
  });

  it("tells each channel it was unsubscribed", async () => {
    const socket = await open();

    await subscribe(socket, 1);
    await subscribe(socket, 2);
    await cable.unsubscribeFromAll(socket);

    expect(left.sort()).toEqual(["room:1", "room:2"]);
  });

  it("stops delivering on every stream", async () => {
    const socket = await open();

    await subscribe(socket, 1);
    await subscribe(socket, 2);
    await cable.unsubscribeFromAll(socket);
    socket.sent.length = 0;

    cable.broadcastTo("room:1", { hello: true });
    cable.broadcastTo("room:2", { hello: true });

    expect(socket.sent).toEqual([]);
  });

  /** Closing the socket instead would log them out to say they left a room. */
  it("leaves the connection open", async () => {
    const socket = await open();

    await subscribe(socket, 1);
    await cable.unsubscribeFromAll(socket);

    expect(cable.connectionCount).toBe(1);
  });

  it("lets the socket subscribe again afterwards", async () => {
    const socket = await open();

    await subscribe(socket, 1);
    await cable.unsubscribeFromAll(socket);
    await subscribe(socket, 1);

    expect(cable.subscriptionsOn(socket)).toEqual([identifierFor(1)]);
  });

  it("says nothing for a socket with no subscriptions", async () => {
    const socket = await open();

    expect(await cable.unsubscribeFromAll(socket)).toBe(0);
  });

  it("leaves another socket's subscriptions alone", async () => {
    const first = await open();
    const second = await open();

    await subscribe(first, 1);
    await subscribe(second, 1);

    await cable.unsubscribeFromAll(first);

    expect(cable.subscriptionsOn(second)).toEqual([identifierFor(1)]);
    expect(cable.streams.subscriberCount("room:1")).toBe(1);
  });
});
