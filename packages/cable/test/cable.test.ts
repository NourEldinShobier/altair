/**
 * Cable suite.
 *
 * Mirrors actioncable/test/ — the wire protocol, subscriptions, streams and
 * action dispatch. The protocol cases matter most: speaking it exactly is what
 * lets Rails' own client work against this server.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Channel, topicFor, type CableSocket } from "../src/channel.js";
import {
  MESSAGE_TYPES,
  PROTOCOLS,
  confirmationFrame,
  parseData,
  parseFrame,
  parseIdentifier,
  pingFrame,
  welcomeFrame,
} from "../src/protocol.js";
import { Cable, StreamRegistry, frameFor, type SocketData } from "../src/server.js";

/** A socket that records what it was sent, standing in for a real one. */
class FakeSocket implements CableSocket {
  readonly sent: string[] = [];
  readonly topics = new Set<string>();
  closed = false;
  data!: SocketData;

  send(payload: string): void {
    this.sent.push(payload);
  }
  subscribe(topic: string): void {
    this.topics.add(topic);
  }
  unsubscribe(topic: string): void {
    this.topics.delete(topic);
  }
  close(): void {
    this.closed = true;
  }

  frames(): Record<string, unknown>[] {
    return this.sent.map((frame) => JSON.parse(frame) as Record<string, unknown>);
  }
  lastFrame(): Record<string, unknown> {
    return this.frames().at(-1)!;
  }
}

const CHAT = JSON.stringify({ channel: "ChatChannel", room: "1" });

class ChatChannel extends Channel {
  static override actions = ["speak"];
  static spoken: unknown[] = [];

  override async subscribed(): Promise<void> {
    this.streamFrom(`chat:${String(this.params.room)}`);
  }

  async speak(data: Record<string, unknown>): Promise<void> {
    ChatChannel.spoken.push(data);
    this.broadcast(`chat:${String(this.params.room)}`, { said: data.message });
  }
}

class PrivateChannel extends Channel {
  override async subscribed(): Promise<void> {
    if (!this.connection.currentUser) this.reject();
  }
}

let cable: Cable;
let socket: FakeSocket;

function connect(currentUser?: unknown): FakeSocket {
  const ws = new FakeSocket();
  ws.data = {
    connection: {
      request: new Request("http://test.host/cable", { headers: { origin: "http://test.host" } }),
      currentUser,
    },
    subscriptions: new Map(),
  };
  return ws;
}

beforeEach(() => {
  Channel.resetRegistry();
  Channel.register(ChatChannel, PrivateChannel);
  ChatChannel.spoken = [];
  cable = new Cable();
  socket = connect();
});

describe("protocol", () => {
  // These are copied from Rails' source, not invented; getting them wrong
  // means the official client silently misbehaves.
  it("uses Rails' message types", () => {
    expect(MESSAGE_TYPES).toEqual({
      welcome: "welcome",
      disconnect: "disconnect",
      ping: "ping",
      confirmation: "confirm_subscription",
      rejection: "reject_subscription",
    });
  });

  it("advertises Rails' subprotocols", () => {
    expect(PROTOCOLS).toEqual(["actioncable-v1-json", "actioncable-unsupported"]);
  });

  it("builds a welcome frame", () => {
    expect(JSON.parse(welcomeFrame())).toEqual({ type: "welcome" });
  });

  // Rails sends seconds, and the client measures gaps between them.
  it("sends the ping timestamp in seconds", () => {
    const frame = JSON.parse(pingFrame(1_700_000_000_000)) as { message: number };
    expect(frame.message).toBe(1_700_000_000);
  });

  it("parses a client frame", () => {
    expect(parseFrame(JSON.stringify({ command: "subscribe", identifier: CHAT }))).toEqual({
      command: "subscribe",
      identifier: CHAT,
      data: undefined,
    });
  });

  // A socket is untrusted input: one bad frame must not end the connection.
  it("returns null for anything malformed", () => {
    expect(parseFrame("not json")).toBeNull();
    expect(parseFrame(JSON.stringify({ command: "drop_table", identifier: "x" }))).toBeNull();
    expect(parseFrame(JSON.stringify({ identifier: "x" }))).toBeNull();
    expect(parseFrame(JSON.stringify([1, 2]))).toBeNull();
  });

  // The protocol double-encodes identifier and data; a server that forgets is
  // subtly incompatible.
  it("parses the double-encoded identifier and data", () => {
    expect(parseIdentifier(CHAT)).toEqual({ channel: "ChatChannel", room: "1" });
    expect(parseData(JSON.stringify({ action: "speak" }))).toEqual({ action: "speak" });
  });

  it("rejects an identifier naming no channel", () => {
    expect(parseIdentifier(JSON.stringify({ room: "1" }))).toBeNull();
    expect(parseIdentifier("nope")).toBeNull();
    expect(parseData(undefined)).toEqual({});
  });
});

describe("connecting", () => {
  it("sends welcome on open", () => {
    cable.handlers().open(socket as never);
    expect(socket.lastFrame()).toEqual({ type: "welcome" });
  });

  // One publish reaches every socket, rather than a timer per connection.
  it("subscribes every socket to the ping topic", () => {
    cable.handlers().open(socket as never);
    expect(socket.topics.has(topicFor("__ping__"))).toBe(true);
  });

  it("recognizes its mount path", () => {
    expect(
      cable.handles(
        new Request("http://test.host/cable", { headers: { origin: "http://test.host" } }),
      ),
    ).toBe(true);
    expect(cable.handles(new Request("http://test.host/posts"))).toBe(false);
  });

  it("takes a custom mount path", () => {
    expect(new Cable({ path: "/ws" }).handles(new Request("http://test.host/ws"))).toBe(true);
  });

  it("builds socket data for an allowed connection", async () => {
    const authorized = new Cable({
      authorize: () => ({
        request: new Request("http://test.host/cable", { headers: { origin: "http://test.host" } }),
        currentUser: "ada",
      }),
    });

    const data = await authorized.upgradeData(
      new Request("http://test.host/cable", { headers: { origin: "http://test.host" } }),
    );
    expect(data?.connection.currentUser).toBe("ada");
  });

  it("refuses a connection the authorizer rejects", async () => {
    const guarded = new Cable({ authorize: () => null });
    expect(
      await guarded.upgradeData(
        new Request("http://test.host/cable", { headers: { origin: "http://test.host" } }),
      ),
    ).toBeNull();
  });
});

describe("subscribing", () => {
  it("confirms a subscription", async () => {
    await cable
      .handlers()
      .message(socket as never, JSON.stringify({ command: "subscribe", identifier: CHAT }));

    expect(socket.lastFrame()).toEqual({ identifier: CHAT, type: "confirm_subscription" });
    expect(socket.data.subscriptions.size).toBe(1);
  });

  it("subscribes the socket to the channel's streams", async () => {
    await cable
      .handlers()
      .message(socket as never, JSON.stringify({ command: "subscribe", identifier: CHAT }));
    expect(socket.topics.has(topicFor("chat:1"))).toBe(true);
  });

  it("rejects an unknown channel", async () => {
    const identifier = JSON.stringify({ channel: "NopeChannel" });
    await cable
      .handlers()
      .message(socket as never, JSON.stringify({ command: "subscribe", identifier }));

    expect(socket.lastFrame()).toEqual({ identifier, type: "reject_subscription" });
    expect(socket.data.subscriptions.size).toBe(0);
  });

  it("rejects a subscription the channel refuses", async () => {
    const identifier = JSON.stringify({ channel: "PrivateChannel" });
    await cable
      .handlers()
      .message(socket as never, JSON.stringify({ command: "subscribe", identifier }));

    expect(socket.lastFrame()).toEqual({ identifier, type: "reject_subscription" });
  });

  it("allows a subscription the channel accepts", async () => {
    const authorized = connect("ada");
    const identifier = JSON.stringify({ channel: "PrivateChannel" });

    await cable
      .handlers()
      .message(authorized as never, JSON.stringify({ command: "subscribe", identifier }));
    expect(authorized.lastFrame().type).toBe("confirm_subscription");
  });

  it("ignores a repeated subscribe", async () => {
    const frame = JSON.stringify({ command: "subscribe", identifier: CHAT });
    await cable.handlers().message(socket as never, frame);
    await cable.handlers().message(socket as never, frame);

    expect(socket.data.subscriptions.size).toBe(1);
  });

  it("unsubscribes and stops the streams", async () => {
    await cable
      .handlers()
      .message(socket as never, JSON.stringify({ command: "subscribe", identifier: CHAT }));
    await cable
      .handlers()
      .message(socket as never, JSON.stringify({ command: "unsubscribe", identifier: CHAT }));

    expect(socket.data.subscriptions.size).toBe(0);
    expect(socket.topics.has(topicFor("chat:1"))).toBe(false);
  });

  it("stops every stream when the socket closes", async () => {
    await cable
      .handlers()
      .message(socket as never, JSON.stringify({ command: "subscribe", identifier: CHAT }));
    await cable.handlers().close(socket as never);

    expect(socket.data.subscriptions.size).toBe(0);
    expect(socket.topics.has(topicFor("chat:1"))).toBe(false);
  });
});

describe("messages", () => {
  async function subscribe(): Promise<void> {
    await cable
      .handlers()
      .message(socket as never, JSON.stringify({ command: "subscribe", identifier: CHAT }));
  }

  it("dispatches to a declared action", async () => {
    await subscribe();
    await cable.handlers().message(
      socket as never,
      JSON.stringify({
        command: "message",
        identifier: CHAT,
        data: JSON.stringify({ action: "speak", message: "hi" }),
      }),
    );

    expect(ChatChannel.spoken).toEqual([{ message: "hi" }]);
  });

  // Without an allowlist a client could call reject(), stopAllStreams(), or
  // anything else on the class.
  it("refuses an action that is not declared", async () => {
    const errors: unknown[] = [];
    const guarded = new Cable({ onError: (error) => void errors.push(error) });
    const ws = connect();

    await guarded
      .handlers()
      .message(ws as never, JSON.stringify({ command: "subscribe", identifier: CHAT }));
    await guarded.handlers().message(
      ws as never,
      JSON.stringify({
        command: "message",
        identifier: CHAT,
        data: JSON.stringify({ action: "stopAllStreams" }),
      }),
    );

    expect((errors[0] as Error).message).toContain("does not expose an action");
  });

  // A message for a subscription that was never confirmed must not reach a
  // channel the client does not hold.
  it("drops a message for an unconfirmed subscription", async () => {
    await cable.handlers().message(
      socket as never,
      JSON.stringify({
        command: "message",
        identifier: CHAT,
        data: JSON.stringify({ action: "speak", message: "hi" }),
      }),
    );

    expect(ChatChannel.spoken).toEqual([]);
  });

  it("falls back to receive when there is no action", async () => {
    const received: unknown[] = [];

    class EchoChannel extends Channel {
      override async receive(data: Record<string, unknown>): Promise<void> {
        received.push(data);
      }
    }
    Channel.register(EchoChannel);

    const identifier = JSON.stringify({ channel: "EchoChannel" });
    await cable
      .handlers()
      .message(socket as never, JSON.stringify({ command: "subscribe", identifier }));
    await cable
      .handlers()
      .message(
        socket as never,
        JSON.stringify({ command: "message", identifier, data: JSON.stringify({ note: "hi" }) }),
      );

    expect(received).toEqual([{ note: "hi" }]);
  });

  it("ignores a malformed frame without closing the socket", async () => {
    await cable.handlers().message(socket as never, "not json");
    expect(socket.closed).toBe(false);
  });
});

describe("broadcasting", () => {
  it("publishes to the stream's topic", () => {
    const broadcaster = new StreamRegistry();
    Channel.broadcastTo(broadcaster, "chat:1", { said: "hi" });

    expect(broadcaster.published[0]!.topic).toBe(topicFor("chat:1"));
    expect(JSON.parse(broadcaster.published[0]!.payload)).toEqual({
      stream: "chat:1",
      message: { said: "hi" },
    });
  });

  it("broadcasts from outside a socket", () => {
    const outside = new Cable();
    outside.broadcastTo("chat:1", { said: "from a job" });

    expect(outside.streams.published).toHaveLength(1);
  });

  // Two clients on one stream have different identifiers, so the frame cannot
  // be built once at publish time.
  it("frames a broadcast per subscriber identifier", async () => {
    await cable
      .handlers()
      .message(socket as never, JSON.stringify({ command: "subscribe", identifier: CHAT }));

    const payload = JSON.stringify({ stream: "chat:1", message: { said: "hi" } });
    const frames = frameFor(socket.data.subscriptions, payload);

    expect(frames).toHaveLength(1);
    expect(JSON.parse(frames[0]!)).toEqual({ identifier: CHAT, message: { said: "hi" } });
  });

  it("frames nothing for a stream nobody is on", () => {
    const payload = JSON.stringify({ stream: "chat:99", message: {} });
    expect(frameFor(socket.data.subscriptions, payload)).toEqual([]);
  });

  it("survives a payload it did not publish", () => {
    expect(frameFor(socket.data.subscriptions, "not json")).toEqual([]);
  });
});

describe("frames", () => {
  it("builds a confirmation naming the subscription", () => {
    expect(JSON.parse(confirmationFrame(CHAT))).toEqual({
      identifier: CHAT,
      type: "confirm_subscription",
    });
  });
});
