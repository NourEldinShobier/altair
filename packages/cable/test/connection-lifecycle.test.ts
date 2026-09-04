/**
 * A socket's life from open to close, ported from
 * `actioncable/test/connection/base_test.rb`,
 * `connection/subscriptions_test.rb` and `connection/client_socket_test.rb`.
 *
 * The heartbeat is the part worth testing hardest. TCP does not report that
 * the other end went away — a closed laptop, a phone leaving a tunnel, a NAT
 * box forgetting a mapping all leave a socket that reads and writes without
 * error and delivers nothing, and the process holds it forever.
 */

import { describe, expect, it } from "bun:test";
import type { CommandCallbacks } from "../src/connection-lifecycle.js";
import {
  BEAT_INTERVAL_MS,
  Halted,
  Heartbeat,
  HeartbeatMonitor,
  InvalidCommand,
  STALE_AFTER_MS,
  WriteBuffer,
  dispatchWebsocketMessage,
  afterCommand,
  aroundCommand,
  beforeCommand,
  executeCommand,
  halt,
  newCommandCallbacks,
  handleChannelCommand,
  handleClose,
  handleOpen,
  invokeCallback,
  secureRequest,
} from "../src/connection-lifecycle.js";
import type { CommandHandlers, IncomingFrame } from "../src/connection-lifecycle.js";

function recorder(): CommandHandlers & { calls: string[] } {
  const calls: string[] = [];

  return {
    calls,
    subscribe: (identifier) => void calls.push(`subscribe ${identifier}`),
    unsubscribe: (identifier) => void calls.push(`unsubscribe ${identifier}`),
    message: (identifier, data) => void calls.push(`message ${identifier} ${data}`),
  };
}

const subscribing: IncomingFrame = { command: "subscribe", identifier: '{"channel":"Chat"}' };

describe("reading a frame", () => {
  it("reads a subscribe", () => {
    expect(
      dispatchWebsocketMessage('{"command":"subscribe","identifier":"{\\"channel\\":\\"Chat\\"}"}'),
    ).toMatchObject({ command: "subscribe" });
  });

  /**
   * A socket is an untrusted input, and one bad frame must not take down a
   * connection carrying a hundred subscriptions.
   */
  it("gives nothing for something that is not JSON", () => {
    expect(dispatchWebsocketMessage("not json at all")).toBeNull();
  });

  it("gives nothing for a command it does not know", () => {
    expect(dispatchWebsocketMessage('{"command":"drop_table","identifier":"x"}')).toBeNull();
  });

  it("gives nothing when the identifier is not a string", () => {
    expect(dispatchWebsocketMessage('{"command":"subscribe","identifier":{"a":1}}')).toBeNull();
  });
});

describe("routing a command", () => {
  it("subscribes", async () => {
    const handlers = recorder();

    await handleChannelCommand(subscribing, handlers);

    expect(handlers.calls).toEqual(['subscribe {"channel":"Chat"}']);
  });

  it("unsubscribes", async () => {
    const handlers = recorder();

    await handleChannelCommand({ command: "unsubscribe", identifier: "id" }, handlers);

    expect(handlers.calls).toEqual(["unsubscribe id"]);
  });

  it("passes a message through", async () => {
    const handlers = recorder();

    await handleChannelCommand({ command: "message", identifier: "id", data: "{}" }, handlers);

    expect(handlers.calls).toEqual(["message id {}"]);
  });

  /** Passing "" on would have the channel act on nothing. */
  it("refuses a message with no data", async () => {
    await expect(
      handleChannelCommand({ command: "message", identifier: "id" }, recorder()),
    ).rejects.toThrow(InvalidCommand);
  });
});

describe("hooks around a command", () => {
  it("runs the command", async () => {
    const handlers = recorder();

    await executeCommand(subscribing, handlers);

    expect(handlers.calls).toHaveLength(1);
  });

  it("runs a before hook first", async () => {
    const order: string[] = [];
    const handlers = recorder();

    await executeCommand(
      subscribing,
      {
        ...handlers,
        subscribe: () => void order.push("command"),
      },
      { before: [() => void order.push("before")] },
    );

    expect(order).toEqual(["before", "command"]);
  });

  it("runs an after hook last", async () => {
    const order: string[] = [];

    await executeCommand(
      subscribing,
      { ...recorder(), subscribe: () => void order.push("command") },
      { after: [() => void order.push("after")] },
    );

    expect(order).toEqual(["command", "after"]);
  });

  /** A hook that could not stop anything would be a log line. */
  it("lets a before hook stop the command", async () => {
    const handlers = recorder();

    await expect(
      executeCommand(subscribing, handlers, {
        before: [
          () => {
            throw new Error("not allowed");
          },
        ],
      }),
    ).rejects.toThrow("not allowed");

    expect(handlers.calls).toEqual([]);
  });

  it("reports a halt rather than letting it escape", async () => {
    expect(await invokeCallback(() => halt("no"), subscribing)).toBe(false);
  });

  it("reports an ordinary run", async () => {
    expect(await invokeCallback(() => undefined, subscribing)).toBe(true);
  });

  /** Only a halt is swallowed — a real failure still has to reach somebody. */
  it("lets a real error through", async () => {
    await expect(
      invokeCallback(() => {
        throw new Error("boom");
      }, subscribing),
    ).rejects.toThrow("boom");
  });

  it("throws the right type", () => {
    expect(() => halt()).toThrow(Halted);
  });
});

describe("a heartbeat", () => {
  it("is alive when it has just been heard from", () => {
    expect(new Heartbeat(1000).alive(1000)).toBe(true);
  });

  it("is alive within the window", () => {
    expect(new Heartbeat(1000).alive(1000 + STALE_AFTER_MS - 1)).toBe(true);
  });

  /**
   * The decision comes from a timestamp, not from the socket, because the
   * socket is the thing that lies.
   */
  it("is gone once the window passes", () => {
    const beat = new Heartbeat(1000);

    expect(beat.alive(1000 + STALE_AFTER_MS)).toBe(false);
    expect(beat.clientGone(1000 + STALE_AFTER_MS)).toBe(true);
  });

  it("comes back when something arrives", () => {
    const beat = new Heartbeat(1000);

    beat.beat(1000 + STALE_AFTER_MS);

    expect(beat.alive(1000 + STALE_AFTER_MS)).toBe(true);
  });

  it("records when it was last heard from", () => {
    const beat = new Heartbeat(1000);
    beat.beat(5000);

    expect(beat.lastSeen).toBe(5000);
  });

  /** So a test does not have to sleep for six seconds to check this. */
  it("can have its clock moved", () => {
    const beat = new Heartbeat(1000);

    beat.advanceTime(STALE_AFTER_MS);

    expect(beat.clientGone(1000)).toBe(true);
  });

  it("expects a beat more often than it gives up", () => {
    expect(BEAT_INTERVAL_MS).toBeLessThan(STALE_AFTER_MS);
  });
});

describe("watching every connection", () => {
  it("tracks one", () => {
    const monitor = new HeartbeatMonitor<string>();
    monitor.add("a", 1000);

    expect(monitor.size).toBe(1);
    expect(monitor.alive("a", 1000)).toBe(true);
  });

  it("reports one it does not know as not alive", () => {
    expect(new HeartbeatMonitor<string>().alive("nobody")).toBe(false);
  });

  it("stops tracking one", () => {
    const monitor = new HeartbeatMonitor<string>();
    monitor.add("a");

    expect(monitor.remove("a")).toBe(true);
    expect(monitor.size).toBe(0);
  });

  it("says when there was nothing to stop tracking", () => {
    expect(new HeartbeatMonitor<string>().remove("nobody")).toBe(false);
  });

  it("names the ones that stopped answering", () => {
    const monitor = new HeartbeatMonitor<string>();
    monitor.add("quiet", 1000);
    monitor.add("chatty", 1000);
    monitor.beat("chatty", 1000 + STALE_AFTER_MS);

    expect(monitor.clientsGone(1000 + STALE_AFTER_MS)).toEqual(["quiet"]);
  });

  /** Reported rather than closed, because a server wants to unsubscribe first. */
  it("does not drop them just for reporting them", () => {
    const monitor = new HeartbeatMonitor<string>();
    monitor.add("quiet", 1000);

    monitor.clientsGone(1000 + STALE_AFTER_MS);

    expect(monitor.size).toBe(1);
  });

  it("drops them when reaped", () => {
    const monitor = new HeartbeatMonitor<string>();
    monitor.add("quiet", 1000);
    monitor.add("chatty", 1000);
    monitor.beat("chatty", 1000 + STALE_AFTER_MS);

    expect(monitor.reap(1000 + STALE_AFTER_MS)).toEqual(["quiet"]);
    expect(monitor.size).toBe(1);
  });

  it("takes a window of its own", () => {
    const monitor = new HeartbeatMonitor<string>(100);
    monitor.add("a", 1000);

    expect(monitor.alive("a", 1150)).toBe(false);
  });
});

describe("the write buffer", () => {
  it("says whether anything is waiting", () => {
    const buffer = new WriteBuffer();

    expect(buffer.writesPending()).toBe(false);

    buffer.push("frame");

    expect(buffer.writesPending()).toBe(true);
    expect(buffer.size).toBe(1);
  });

  it("hands everything over in order", () => {
    const buffer = new WriteBuffer();
    const written: string[] = [];
    buffer.push("one");
    buffer.push("two");

    expect(buffer.flushWriteBuffer((frame) => written.push(frame))).toBe(2);
    expect(written).toEqual(["one", "two"]);
  });

  it("empties as it goes", () => {
    const buffer = new WriteBuffer();
    buffer.push("one");

    buffer.flushWriteBuffer(() => undefined);

    expect(buffer.writesPending()).toBe(false);
  });

  /** A duplicate frame is worse than a dropped one, because a client acts on it. */
  it("does not leave frames queued when the writer throws", () => {
    const buffer = new WriteBuffer();
    buffer.push("one");

    expect(() =>
      buffer.flushWriteBuffer(() => {
        throw new Error("socket gone");
      }),
    ).toThrow("socket gone");

    expect(buffer.writesPending()).toBe(false);
  });
});

describe("opening and closing", () => {
  it("opens", async () => {
    let opened = false;

    expect(await handleOpen({ onOpen: () => void (opened = true) }, () => undefined)).toBe(true);
    expect(opened).toBe(true);
  });

  /**
   * A connection that opened and then failed its own setup is subscribed to
   * nothing and answers nothing, and the client cannot tell that from a quiet
   * channel.
   */
  it("closes when opening fails", async () => {
    let reason = "";

    const opened = await handleOpen(
      {
        onOpen: () => {
          throw new Error("no session");
        },
      },
      (why) => {
        reason = why;
      },
    );

    expect(opened).toBe(false);
    expect(reason).toBe("no session");
  });

  it("runs the close callback", async () => {
    let closed = false;

    await handleClose({ onClose: () => void (closed = true) });

    expect(closed).toBe(true);
  });

  /**
   * It runs while the connection is going away — there is nothing left to tell
   * and nothing to retry, and letting it escape would take down whatever was
   * closing the socket.
   */
  it("swallows a failure while closing", async () => {
    await expect(
      handleClose({
        onClose: () => {
          throw new Error("already gone");
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("survives a connection with no callbacks", async () => {
    expect(await handleOpen({}, () => undefined)).toBe(true);
    await expect(handleClose({})).resolves.toBeUndefined();
  });
});

describe("whether the socket came over TLS", () => {
  it("is true for wss", () => {
    expect(secureRequest(new Request("wss://app.test/cable"))).toBe(true);
  });

  it("is true for https", () => {
    expect(secureRequest(new Request("https://app.test/cable"))).toBe(true);
  });

  it("is false for ws", () => {
    expect(secureRequest(new Request("ws://app.test/cable"))).toBe(false);
  });

  it("trusts a proxy that says so", () => {
    const request = new Request("http://app.test/cable", {
      headers: { "x-forwarded-proto": "https" },
    });

    expect(secureRequest(request)).toBe(true);
  });

  /** The leftmost entry is the one the outermost proxy saw. */
  it("reads the first entry of a chain", () => {
    const request = new Request("http://app.test/cable", {
      headers: { "x-forwarded-proto": "https, http" },
    });

    expect(secureRequest(request)).toBe(true);
  });

  it("is false when the proxy says otherwise", () => {
    const request = new Request("http://app.test/cable", {
      headers: { "x-forwarded-proto": "http" },
    });

    expect(secureRequest(request)).toBe(false);
  });
});

const frame: IncomingFrame = { command: "subscribe", identifier: "ch" };

function handlers(body: () => void): CommandHandlers {
  return {
    subscribe: body,
    unsubscribe: () => undefined,
    message: () => undefined,
  };
}

describe("the callbacks around one command", () => {
  function record(order: string[]): CommandCallbacks {
    const callbacks = newCommandCallbacks();
    beforeCommand(callbacks, () => {
      order.push("before");
    });
    afterCommand(callbacks, () => {
      order.push("after");
    });

    return callbacks;
  }

  it("runs before and after around the body", async () => {
    const order: string[] = [];

    await executeCommand(
      frame,
      handlers(() => order.push("body")),
      record(order),
    );

    expect(order).toEqual(["before", "body", "after"]);
  });

  /**
   * A connection lasts for hours, so a database connection leaked by one
   * failing command is leaked for the rest of the session — the tenth failure
   * exhausts the pool rather than the first.
   */
  it("runs after even when the body throws", async () => {
    const order: string[] = [];

    await expect(
      executeCommand(
        frame,
        handlers(() => {
          throw new Error("boom");
        }),
        record(order),
      ),
    ).rejects.toThrow("boom");

    expect(order).toEqual(["before", "after"]);
  });

  it("hands each hook the payload", async () => {
    const seen: unknown[] = [];
    const callbacks = newCommandCallbacks();
    beforeCommand(callbacks, (command) => {
      seen.push(command);
    });

    await executeCommand(
      frame,
      handlers(() => undefined),
      callbacks,
    );

    expect(seen).toEqual([frame]);
  });

  it("waits for an async hook", async () => {
    const order: string[] = [];
    const callbacks = newCommandCallbacks();
    beforeCommand(callbacks, async () => {
      await Promise.resolve();
      order.push("before");
    });

    await executeCommand(
      frame,
      handlers(() => order.push("body")),
      callbacks,
    );

    expect(order).toEqual(["before", "body"]);
  });

  it("wraps with an around hook", async () => {
    const order: string[] = [];
    const callbacks = newCommandCallbacks();
    aroundCommand(callbacks, async (_command: IncomingFrame, next: () => Promise<void>) => {
      order.push("in");
      await next();
      order.push("out");
    });

    await executeCommand(
      frame,
      handlers(() => order.push("body")),
      callbacks,
    );

    expect(order).toEqual(["in", "body", "out"]);
  });

  /** The order somebody reading the class top to bottom would expect. */
  it("lets the first-declared around hook wrap the rest", async () => {
    const order: string[] = [];
    const callbacks = newCommandCallbacks();
    aroundCommand(callbacks, async (_command: IncomingFrame, next: () => Promise<void>) => {
      order.push("outer in");
      await next();
      order.push("outer out");
    });
    aroundCommand(callbacks, async (_command: IncomingFrame, next: () => Promise<void>) => {
      order.push("inner in");
      await next();
      order.push("inner out");
    });

    await executeCommand(
      frame,
      handlers(() => order.push("body")),
      callbacks,
    );

    expect(order).toEqual(["outer in", "inner in", "body", "inner out", "outer out"]);
  });

  /** An around hook that does not call next stops the command. */
  it("lets an around hook refuse to continue", async () => {
    const order: string[] = [];
    const callbacks = newCommandCallbacks();
    aroundCommand(callbacks, () => {
      order.push("refused");
    });

    await executeCommand(
      frame,
      handlers(() => order.push("body")),
      callbacks,
    );

    expect(order).toEqual(["refused"]);
  });

  it("runs the body with no callbacks at all", async () => {
    const order: string[] = [];

    await executeCommand(
      frame,
      handlers(() => order.push("body")),
      newCommandCallbacks(),
    );

    expect(order).toEqual(["body"]);
  });
});
