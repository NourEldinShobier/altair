/**
 * What the server knows about its own connections, ported from
 * `actioncable/test/server/base_test.rb` and the `open_connections_statistics`
 * cases in `actioncable/test/connection/`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Cable, type SocketData } from "../src/server.js";
import { Channel, type CableSocket } from "../src/channel.js";
import { connectedIdentifiers, disconnectAll, resetIdentifiers } from "../src/identity.js";

function fakeSocket(
  data: SocketData,
): CableSocket & { data: SocketData; sent: string[]; closed: boolean } {
  const sent: string[] = [];
  const socket = {
    data,
    sent,
    closed: false,
    send: (frame: string) => sent.push(frame),
    subscribe: () => undefined,
    unsubscribe: () => undefined,
    close: () => {
      socket.closed = true;
    },
  };

  return socket as unknown as CableSocket & { data: SocketData; sent: string[]; closed: boolean };
}

class RoomChannel extends Channel {
  static override channelName = "RoomChannel";

  override async subscribed(): Promise<void> {
    this.streamFrom(`room:${String(this.params.id ?? 1)}`);
  }
}

let cable: Cable;

beforeEach(() => {
  resetIdentifiers();
  Channel.resetRegistry();
  Channel.register(RoomChannel);
  cable = new Cable();
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

async function subscribe(socket: CableSocket & { data: SocketData }, id = 1): Promise<void> {
  await cable.handlers().message(
    socket,
    JSON.stringify({
      command: "subscribe",
      identifier: JSON.stringify({ channel: "RoomChannel", id }),
    }),
  );
}

describe("counting connections", () => {
  it("starts with none", () => {
    expect(cable.connectionCount).toBe(0);
  });

  it("counts a socket that opened", async () => {
    await open();
    await open();

    expect(cable.connectionCount).toBe(2);
  });

  it("forgets one that closed", async () => {
    const socket = await open();
    await open();

    await cable.handlers().close(socket);

    expect(cable.connectionCount).toBe(1);
  });
});

describe("eachConnection", () => {
  it("visits every open socket", async () => {
    await open();
    await open();

    let visited = 0;
    cable.eachConnection(() => {
      visited += 1;
    });

    expect(visited).toBe(2);
  });

  /** Disconnecting what it is handed is the ordinary use. */
  it("survives a body that closes what it is given", async () => {
    await open();
    await open();

    expect(() => {
      cable.eachConnection((ws) => {
        cable.removeConnection(ws);
      });
    }).not.toThrow();

    expect(cable.connectionCount).toBe(0);
  });

  /** Iterating the live set would visit what the body had just added. */
  it("does not visit a socket the body opened", async () => {
    await open();

    let visited = 0;
    let opened = false;

    cable.eachConnection(() => {
      visited += 1;

      if (!opened) {
        opened = true;
        cable.addConnection({ data: { subscriptions: new Map() } } as never);
      }
    });

    expect(visited).toBe(1);
  });
});

describe("statistics", () => {
  it("is empty on a server nobody has reached", () => {
    expect(cable.statistics()).toEqual({ connections: 0, subscriptions: 0, streams: 0 });
  });

  /**
   * The two numbers come apart, and it is the second that says whether the
   * process is near its limit: one tab holding twelve channel subscriptions is
   * one connection and twelve subscriptions.
   */
  it("counts subscriptions separately from sockets", async () => {
    const socket = await open();

    await subscribe(socket, 1);
    await subscribe(socket, 2);

    expect(cable.statistics()).toMatchObject({ connections: 1, subscriptions: 2 });
  });

  it("counts the streams with a local subscriber", async () => {
    const socket = await open();

    await subscribe(socket, 1);
    await subscribe(socket, 2);

    expect(cable.statistics().streams).toBe(2);
  });

  it("counts a shared stream once", async () => {
    const first = await open();
    const second = await open();

    await subscribe(first, 1);
    await subscribe(second, 1);

    expect(cable.statistics()).toMatchObject({ connections: 2, subscriptions: 2, streams: 1 });
  });

  it("comes back down when a socket closes", async () => {
    const socket = await open();

    await subscribe(socket, 1);
    await cable.handlers().close(socket);

    expect(cable.statistics()).toEqual({ connections: 0, subscriptions: 0, streams: 0 });
  });
});

describe("shutdown", () => {
  /**
   * The reason the frame matters. Dropped without it, a client waits out its
   * heartbeat before deciding the connection is gone — so a rolling restart
   * leaves every user disconnected for that long, staggered, which reads as
   * the application being flaky rather than as a deploy.
   */
  it("tells every client to reconnect", async () => {
    const first = await open();
    const second = await open();

    cable.shutdown();

    for (const socket of [first, second]) {
      const frame = socket.sent.map((one) => JSON.parse(one) as Record<string, unknown>);
      const disconnect = frame.find((one) => one.type === "disconnect");

      expect(disconnect?.reconnect).toBe(true);
      expect(disconnect?.reason).toBe("server_restart");
    }
  });

  it("closes them", async () => {
    const socket = await open();

    cable.shutdown();

    expect(socket.closed).toBe(true);
  });

  it("says how many it closed", async () => {
    await open();
    await open();

    expect(cable.shutdown()).toBe(2);
  });

  it("leaves the server holding nothing", async () => {
    await open();

    cable.shutdown();

    expect(cable.connectionCount).toBe(0);
  });

  it("takes a reason of its own", async () => {
    const socket = await open();

    cable.shutdown("maintenance");

    const disconnect = socket.sent
      .map((one) => JSON.parse(one) as Record<string, unknown>)
      .find((one) => one.type === "disconnect");

    expect(disconnect?.reason).toBe("maintenance");
  });

  it("does nothing to a server with no connections", () => {
    expect(cable.shutdown()).toBe(0);
  });
});

describe("an ordinary disconnect", () => {
  /** Not a restart, so the client should not come straight back. */
  it("does not ask the client to reconnect", async () => {
    const socket = await open();

    cable.disconnect(socket);

    const disconnect = socket.sent
      .map((one) => JSON.parse(one) as Record<string, unknown>)
      .find((one) => one.type === "disconnect");

    expect(disconnect?.reconnect).toBe(false);
  });
});
