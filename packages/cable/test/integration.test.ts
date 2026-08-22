/**
 * Cable integration.
 *
 * Runs a real Bun.serve with real WebSocket clients, because the unit tests use
 * a fake socket and a fake socket cannot prove the protocol survives an actual
 * connection. Everything here is what a browser would see.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Channel } from "../src/channel.js";
import { Cable, type SocketData } from "../src/server.js";

class RoomChannel extends Channel {
  static override actions = ["speak"];

  override async subscribed(): Promise<void> {
    this.streamFrom(`room:${String(this.params.id)}`);
  }

  async speak(data: Record<string, unknown>): Promise<void> {
    this.broadcast(`room:${String(this.params.id)}`, { said: data.message });
  }
}

let cable: Cable;
let server: ReturnType<typeof Bun.serve>;
const sockets: WebSocket[] = [];

/** Connects, and resolves once the welcome frame has arrived. */
async function client(): Promise<{ ws: WebSocket; frames: Record<string, unknown>[] }> {
  const frames: Record<string, unknown>[] = [];
  const ws = new WebSocket(`ws://localhost:${server.port}/cable`);
  sockets.push(ws);

  ws.addEventListener("message", (event) => {
    frames.push(JSON.parse(String(event.data)) as Record<string, unknown>);
  });

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("could not connect")));
  });

  await settle();
  return { ws, frames };
}

/** Lets the event loop deliver what is in flight. */
async function settle(ms = 40): Promise<void> {
  await Bun.sleep(ms);
}

beforeEach(() => {
  Channel.resetRegistry();
  cable = new Cable({ channels: [RoomChannel] });
  const handlers = cable.handlers();

  server = Bun.serve({
    port: 0,
    async fetch(request, srv) {
      if (!cable.handles(request)) return new Response("not found", { status: 404 });

      const data = await cable.upgradeData(request);
      if (!data) return new Response("unauthorized", { status: 401 });

      return srv.upgrade(request, { data })
        ? undefined
        : new Response("upgrade failed", { status: 400 });
    },
    websocket: handlers as never,
  });
});

afterEach(() => {
  for (const ws of sockets) ws.close();
  sockets.length = 0;
  cable.detach();
  server.stop(true);
});

describe("a real connection", () => {
  it("sends welcome on connect", async () => {
    const { frames } = await client();
    expect(frames[0]).toEqual({ type: "welcome" });
  });

  it("confirms a subscription", async () => {
    const { ws, frames } = await client();
    const identifier = JSON.stringify({ channel: "RoomChannel", id: 1 });

    ws.send(JSON.stringify({ command: "subscribe", identifier }));
    await settle();

    expect(frames.at(-1)).toEqual({ identifier, type: "confirm_subscription" });
  });

  it("rejects an unknown channel", async () => {
    const { ws, frames } = await client();
    const identifier = JSON.stringify({ channel: "GhostChannel" });

    ws.send(JSON.stringify({ command: "subscribe", identifier }));
    await settle();

    expect(frames.at(-1)).toEqual({ identifier, type: "reject_subscription" });
  });

  // The point of the whole package: a message from one client reaches the
  // others on the same stream, framed under each one's own identifier.
  it("delivers a broadcast to every subscriber", async () => {
    const identifier = JSON.stringify({ channel: "RoomChannel", id: 1 });

    const alice = await client();
    const bob = await client();

    for (const peer of [alice, bob]) {
      peer.ws.send(JSON.stringify({ command: "subscribe", identifier }));
    }
    await settle();

    alice.ws.send(
      JSON.stringify({
        command: "message",
        identifier,
        data: JSON.stringify({ action: "speak", message: "hello" }),
      }),
    );
    await settle();

    const said = (frames: Record<string, unknown>[]) =>
      frames.filter((frame) => frame.message).map((frame) => frame.message);

    expect(said(alice.frames)).toEqual([{ said: "hello" }]);
    expect(said(bob.frames)).toEqual([{ said: "hello" }]);
  });

  it("does not deliver across streams", async () => {
    const one = await client();
    const two = await client();

    one.ws.send(
      JSON.stringify({
        command: "subscribe",
        identifier: JSON.stringify({ channel: "RoomChannel", id: 1 }),
      }),
    );
    two.ws.send(
      JSON.stringify({
        command: "subscribe",
        identifier: JSON.stringify({ channel: "RoomChannel", id: 2 }),
      }),
    );
    await settle();

    one.ws.send(
      JSON.stringify({
        command: "message",
        identifier: JSON.stringify({ channel: "RoomChannel", id: 1 }),
        data: JSON.stringify({ action: "speak", message: "room one only" }),
      }),
    );
    await settle();

    expect(one.frames.some((frame) => frame.message)).toBe(true);
    expect(two.frames.some((frame) => frame.message)).toBe(false);
  });

  it("broadcasts from outside any socket", async () => {
    const identifier = JSON.stringify({ channel: "RoomChannel", id: 5 });
    const { ws, frames } = await client();

    ws.send(JSON.stringify({ command: "subscribe", identifier }));
    await settle();

    // What a controller or a job would call.
    cable.broadcastTo("room:5", { from: "a job" });
    await settle();

    expect(frames.at(-1)).toEqual({ identifier, message: { from: "a job" } });
  });

  it("stops delivering after unsubscribe", async () => {
    const identifier = JSON.stringify({ channel: "RoomChannel", id: 7 });
    const { ws, frames } = await client();

    ws.send(JSON.stringify({ command: "subscribe", identifier }));
    await settle();
    ws.send(JSON.stringify({ command: "unsubscribe", identifier }));
    await settle();

    cable.broadcastTo("room:7", { ignored: true });
    await settle();

    expect(frames.some((frame) => frame.message)).toBe(false);
  });

  // A closed socket left in the registry is a leak and, eventually, a write to
  // a dead connection.
  it("forgets a socket that disconnects", async () => {
    const identifier = JSON.stringify({ channel: "RoomChannel", id: 9 });
    const { ws } = await client();

    ws.send(JSON.stringify({ command: "subscribe", identifier }));
    await settle();
    expect(cable.streams.subscriberCount("room:9")).toBe(1);

    ws.close();
    await settle(80);

    expect(cable.streams.subscriberCount("room:9")).toBe(0);
  });

  it("survives a malformed frame", async () => {
    const { ws, frames } = await client();

    ws.send("this is not json");
    await settle();

    expect(ws.readyState).toBe(WebSocket.OPEN);

    const identifier = JSON.stringify({ channel: "RoomChannel", id: 1 });
    ws.send(JSON.stringify({ command: "subscribe", identifier }));
    await settle();

    expect(frames.at(-1)?.type).toBe("confirm_subscription");
  });

  it("pings on the configured interval", async () => {
    cable.detach();
    server.stop(true);

    const fast = new Cable({ channels: [RoomChannel], pingInterval: 0.05 });
    const handlers = fast.handlers();

    server = Bun.serve({
      port: 0,
      async fetch(request, srv) {
        const data = await fast.upgradeData(request);
        return srv.upgrade(request, { data: data as SocketData }) ? undefined : new Response("no");
      },
      websocket: handlers as never,
    });
    fast.attach(server);

    const { frames } = await client();
    await settle(160);
    fast.detach();

    const pings = frames.filter((frame) => frame.type === "ping");
    expect(pings.length).toBeGreaterThan(0);
    // Rails sends seconds, and the client measures the gap between them.
    expect(typeof pings[0]!.message).toBe("number");
  });
});
