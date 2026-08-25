/**
 * A cable attached to an application, over a real socket.
 *
 * Mirrors actioncable/test/connection/*_test.rb and the parts of
 * subscription_test.rb that only mean anything with a server on the other end.
 *
 * Everything here goes through `Bun.serve` and a real `WebSocket`. That is the
 * point: the cable had a full protocol implementation and no way to be served
 * by the framework's own application, and no unit test could have said so —
 * each half worked exactly as written.
 *
 * `@altair/core` is a dev dependency here and nothing more. Core does not know
 * this package exists; it takes anything with the right shape.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createApplication, type Application } from "@altair/core";
import { Cable, Channel, identify } from "../src/index.js";

class RoomChannel extends Channel {
  static override channelName = "RoomChannel";

  override async subscribed(): Promise<void> {
    this.streamFrom("room:1");
    this.transmit({ greeted: (this.connection.currentUser as { id: number } | undefined)?.id });
  }
}

/** Collects frames so a test can wait for the one it cares about. */
class Client {
  readonly frames: Record<string, unknown>[] = [];
  #socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      this.frames.push(JSON.parse(String(event.data)) as Record<string, unknown>);
    });
  }

  static async open(url: string): Promise<Client> {
    const socket = new WebSocket(url);

    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", () => reject(new Error(`Could not open ${url}`)));
      setTimeout(() => reject(new Error(`Timed out opening ${url}`)), 3000);
    });

    return new Client(socket);
  }

  send(message: unknown): void {
    this.#socket.send(JSON.stringify(message));
  }

  subscribe(channel: string): void {
    this.send({ command: "subscribe", identifier: JSON.stringify({ channel }) });
  }

  /** Waits for a frame the test is looking for, rather than for a fixed delay. */
  async waitFor(
    matches: (frame: Record<string, unknown>) => boolean,
    what = "a frame",
  ): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const found = this.frames.find((frame) => matches(frame));
      if (found) return found;

      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    throw new Error(`Waited for ${what} and it never arrived. Saw: ${JSON.stringify(this.frames)}`);
  }

  close(): void {
    this.#socket.close();
  }
}

let app: Application;
let cable: Cable;
let port: number;
let stop: () => void;
const clients: Client[] = [];

const connect = async (query = "?token=good") => {
  const client = await Client.open(`ws://localhost:${port}/cable${query}`);
  clients.push(client);
  return client;
};

beforeEach(async () => {
  Channel.resetRegistry();

  cable = new Cable({
    channels: [RoomChannel as typeof Channel],
    authorize: (request) =>
      new URL(request.url).searchParams.get("token") === "good"
        ? { request, currentUser: { id: 7 } }
        : null,
  });

  app = createApplication({
    env: "test",
    secretKeyBase: "z".repeat(64),
    database: { url: "sqlite://:memory:" },
    log: { level: "fatal", format: "json", queries: false },
    routes: () => {},
    controllers: {},
  });

  app.useWebSocket(cable);
  await app.boot();

  ({ port, stop } = await app.listen(0));
});

afterEach(async () => {
  for (const client of clients) client.close();
  clients.length = 0;

  stop();
  await app.stop();
});

describe("an application serving a cable", () => {
  it("upgrades a request the cable claims", async () => {
    const client = await connect();

    expect((await client.waitFor((frame) => frame.type === "welcome")).type).toBe("welcome");
  });

  // A cable that upgrades and then closes is indistinguishable from a server
  // that went away, and a client told that will keep reconnecting.
  it("answers a refused connection with 401 rather than upgrading", async () => {
    const response = await fetch(`http://localhost:${port}/cable?token=bad`, {
      headers: { upgrade: "websocket", connection: "Upgrade" },
    });

    expect(response.status).toBe(401);
  });

  it("refuses to open a socket that was not authorized", () => {
    expect(connect("?token=bad")).rejects.toThrow();
  });

  it("carries whoever authorize identified into the channel", async () => {
    const client = await connect();
    client.subscribe("RoomChannel");

    const frame = await client.waitFor(
      (f) => (f.message as { greeted?: number } | undefined)?.greeted !== undefined,
      "the greeting",
    );

    expect((frame.message as { greeted: number }).greeted).toBe(7);
  });

  it("confirms a subscription", async () => {
    const client = await connect();
    client.subscribe("RoomChannel");

    await client.waitFor((f) => f.type === "confirm_subscription", "the confirmation");
  });

  it("delivers a broadcast to a subscriber", async () => {
    const client = await connect();
    client.subscribe("RoomChannel");
    await client.waitFor((f) => f.type === "confirm_subscription");

    cable.broadcastTo("room:1", { body: "hello" });

    const frame = await client.waitFor(
      (f) => (f.message as { body?: string } | undefined)?.body === "hello",
      "the broadcast",
    );

    expect(frame.message).toEqual({ body: "hello" });
  });

  it("delivers to every subscriber and to nobody else", async () => {
    const [one, two] = await Promise.all([connect(), connect()]);

    one.subscribe("RoomChannel");
    await one.waitFor((f) => f.type === "confirm_subscription");

    cable.broadcastTo("room:1", { body: "hello" });
    await one.waitFor((f) => (f.message as { body?: string } | undefined)?.body === "hello");

    expect(two.frames.some((f) => (f.message as { body?: string } | undefined)?.body)).toBe(false);
  });

  // A request that is not the cable's must still reach the controllers.
  it("leaves an ordinary request alone", async () => {
    const response = await fetch(`http://localhost:${port}/not-the-cable`);

    expect(response.status).toBe(404);
  });
});

describe("naming a record's stream", () => {
  class Room {
    constructor(readonly id: number) {}
  }

  it("names it by model and id", () => {
    expect(identify(new Room(1))).toBe("Room/1");
  });

  it("leaves a plain value as itself", () => {
    expect(identify("lobby")).toBe("lobby");
    expect(identify(42)).toBe("42");
  });

  // Two records with id 1 from different tables sharing a stream is one user
  // receiving another's messages.
  it("keeps two models with the same id apart", () => {
    class User {
      constructor(readonly id: number) {}
    }

    expect(identify(new Room(1))).not.toBe(identify(new User(1)));
  });

  // Every unsaved record would share the one stream.
  it("refuses a record with no id", () => {
    expect(() => identify(new Room(undefined as never))).toThrow(/unsaved/);
    expect(() => identify(null)).toThrow();
  });

  it("puts the channel in front, so two channels do not cross", () => {
    class OtherChannel extends Channel {
      static override channelName = "OtherChannel";
    }

    expect(RoomChannel.broadcastingFor(new Room(1))).toBe("RoomChannel:Room/1");
    expect(OtherChannel.broadcastingFor(new Room(1))).not.toBe(
      RoomChannel.broadcastingFor(new Room(1)),
    );
  });
});

describe("streaming for a record", () => {
  class Room {
    constructor(readonly id: number) {}
  }

  class ByRecordChannel extends Channel {
    static override channelName = "ByRecordChannel";

    override async subscribed(): Promise<void> {
      this.streamFor(new Room(Number(this.params.roomId ?? 1)));
    }
  }

  it("subscribes to the record's stream", async () => {
    Channel.resetRegistry();
    Channel.register(RoomChannel as typeof Channel, ByRecordChannel as typeof Channel);

    const client = await connect();
    client.send({
      command: "subscribe",
      identifier: JSON.stringify({ channel: "ByRecordChannel", roomId: 5 }),
    });

    await client.waitFor((f) => f.type === "confirm_subscription");

    cable.broadcastTo("ByRecordChannel:Room/5", { body: "for five" });

    const frame = await client.waitFor(
      (f) => (f.message as { body?: string } | undefined)?.body === "for five",
      "the record broadcast",
    );

    expect(frame.message).toEqual({ body: "for five" });
  });

  it("does not receive another record's messages", async () => {
    Channel.resetRegistry();
    Channel.register(RoomChannel as typeof Channel, ByRecordChannel as typeof Channel);

    const client = await connect();
    client.send({
      command: "subscribe",
      identifier: JSON.stringify({ channel: "ByRecordChannel", roomId: 5 }),
    });

    await client.waitFor((f) => f.type === "confirm_subscription");

    cable.broadcastTo("ByRecordChannel:Room/6", { body: "for six" });
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(client.frames.some((f) => (f.message as { body?: string } | undefined)?.body)).toBe(
      false,
    );
  });
});
