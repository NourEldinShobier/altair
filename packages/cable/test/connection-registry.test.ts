/**
 * The server keeping track of who is connected, ported from
 * `actioncable/test/connection/identifier_test.rb` and
 * `actioncable/test/server/broadcasting_test.rb`.
 *
 * `identity.ts` had all of this and the server never called it, so
 * `connectedIdentifiers()` was always empty and `disconnectAll` always
 * reported nothing to disconnect. Revoking a session left the socket open,
 * still receiving every broadcast the user was subscribed to, until they
 * happened to close the tab.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Cable, type SocketData } from "../src/server.js";
import { Channel, type CableSocket } from "../src/channel.js";
import {
  connectedIdentifiers,
  connectionCount,
  disconnectAll,
  identifiedBy,
  isConnected,
  resetIdentifiers,
} from "../src/identity.js";

/** A socket that records rather than sends, so a test can read the frames. */
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

function handshake(): Request {
  return new Request("https://app.test/cable", { headers: { origin: "https://app.test" } });
}

let cable: Cable;

beforeEach(() => {
  resetIdentifiers();
  identifiedBy("currentUser", (value) => String((value as { id: number }).id));

  cable = new Cable({
    authorize: (request) => ({ request, currentUser: { id: 7 } }),
  });
});

afterEach(() => {
  // Every socket opened in a test is closed, or the registry leaks into the
  // next one — which is the same leak this file exists to catch.
  for (const identifier of connectedIdentifiers()) disconnectAll(identifier);
  resetIdentifiers();
});

async function open(): Promise<ReturnType<typeof fakeSocket>> {
  const data = await cable.upgradeData(handshake());
  const socket = fakeSocket(data as SocketData);

  cable.handlers().open(socket);

  return socket;
}

describe("a socket that opens", () => {
  /** The bug: the registry stayed empty however many sockets were open. */
  it("is recorded under its identity", async () => {
    await open();

    expect(connectedIdentifiers()).toEqual(["7"]);
    expect(isConnected("7")).toBe(true);
  });

  it("is counted, one per tab", async () => {
    await open();
    await open();

    expect(connectionCount("7")).toBe(2);
  });

  it("still gets its welcome", async () => {
    const socket = await open();

    expect(socket.sent[0]).toContain("welcome");
  });

  it("is forgotten when it closes", async () => {
    const socket = await open();

    await cable.handlers().close(socket);

    expect(isConnected("7")).toBe(false);
    expect(connectedIdentifiers()).toEqual([]);
  });

  it("leaves the other tab connected", async () => {
    const first = await open();
    await open();

    await cable.handlers().close(first);

    expect(connectionCount("7")).toBe(1);
  });

  /**
   * A real state, not an error: an anonymous visitor on a public channel
   * simply cannot be found by name later.
   */
  it("is not recorded when it identifies as nobody", async () => {
    const anonymous = new Cable({ authorize: (request) => ({ request }) });
    const data = await anonymous.upgradeData(handshake());

    anonymous.handlers().open(fakeSocket(data as SocketData));

    expect(connectedIdentifiers()).toEqual([]);
  });
});

describe("disconnecting from elsewhere", () => {
  /**
   * The point of the whole thing. Before this the socket stayed open and kept
   * receiving broadcasts after the session was revoked.
   */
  it("closes the socket", async () => {
    const socket = await open();

    expect(disconnectAll("7")).toBe(1);
    expect(socket.sent.join("")).toContain("disconnect");
  });

  /** A revoked session must not survive because a second tab was open. */
  it("closes every tab, not one", async () => {
    const first = await open();
    const second = await open();

    expect(disconnectAll("7")).toBe(2);
    expect(first.sent.join("")).toContain("disconnect");
    expect(second.sent.join("")).toContain("disconnect");
  });

  it("leaves the registry empty afterwards", async () => {
    await open();

    disconnectAll("7");

    expect(isConnected("7")).toBe(false);
  });

  it("does nothing for an identity nobody holds", async () => {
    await open();

    expect(disconnectAll("99")).toBe(0);
    expect(isConnected("7")).toBe(true);
  });
});

describe("a socket leaving its streams", () => {
  class RoomChannel extends Channel {
    static override channelName = "RoomChannel";

    override async subscribed(): Promise<void> {
      this.streamFrom("room:1");
    }
  }

  beforeEach(() => {
    Channel.resetRegistry?.();
    Channel.register(RoomChannel);
  });

  /**
   * The other leak. `removeEverywhere` deleted the stream without reporting
   * it, so a cross-process adapter was never told the last local subscriber
   * had gone — and every disconnect left the upstream subscription behind for
   * as long as the process ran.
   */
  it("reports the stream losing its last subscriber", async () => {
    const lost: string[] = [];
    const socket = await open();

    cable.streams.onInterest = (stream, interested) => {
      if (!interested) lost.push(stream);
    };

    await cable
      .handlers()
      .message(
        socket,
        JSON.stringify({ command: "subscribe", identifier: '{"channel":"RoomChannel"}' }),
      );

    await cable.handlers().close(socket);

    expect(lost).toEqual(["room:1"]);
  });

  it("stops delivering to it", async () => {
    const socket = await open();

    await cable
      .handlers()
      .message(
        socket,
        JSON.stringify({ command: "subscribe", identifier: '{"channel":"RoomChannel"}' }),
      );

    await cable.handlers().close(socket);
    socket.sent.length = 0;

    cable.broadcastTo("room:1", { hello: true });

    expect(socket.sent).toEqual([]);
  });

  it("leaves another socket's interest alone", async () => {
    const lost: string[] = [];
    const first = await open();
    const second = await open();

    for (const socket of [first, second]) {
      await cable
        .handlers()
        .message(
          socket,
          JSON.stringify({ command: "subscribe", identifier: '{"channel":"RoomChannel"}' }),
        );
    }

    cable.streams.onInterest = (stream, interested) => {
      if (!interested) lost.push(stream);
    };

    await cable.handlers().close(first);

    expect(lost).toEqual([]);
    expect(cable.streams.subscriberCount("room:1")).toBe(1);
  });
});
