/**
 * Getting from an HTTP request to a live socket, ported from
 * `actioncable/test/connection/client_socket_test.rb` and
 * `actioncable/test/server/broadcasting_test.rb`.
 *
 * The cases worth having are about the handshake, where writing anything at
 * all after the upgrade corrupts the first frame.
 */

import { describe, expect, it } from "bun:test";
import {
  BEAT_INTERVAL_SECONDS,
  HIJACKED_STATUS,
  determineUrl,
  eventLoop,
  hijackRackSocket,
  rackResponse,
  redisConnectionForSubscriptions,
  setupHeartbeatTimer,
  startDriver,
} from "../src/server_socket.js";

describe("taking the socket", () => {
  it("uses what the server returns", () => {
    const io = {};

    expect(hijackRackSocket({ hijack: () => io })).toBe(io);
  });

  /** Both are in the Rack spec, and a server doing the second is not a failure. */
  it("falls back to the one the server set", () => {
    const io = {};

    expect(hijackRackSocket({ hijack: () => undefined, hijackIo: io })).toBe(io);
  });

  /** A deployment fact rather than a bug — the caller has a fallback. */
  it("finds nothing on a server that cannot", () => {
    expect(hijackRackSocket({})).toBeUndefined();
  });
});

describe("starting to speak WebSocket", () => {
  it("takes the socket and marks itself started", () => {
    const io = {};
    const driver = { started: false, stream: undefined as unknown };

    expect(startDriver(driver, { hijack: () => io })).toBe(true);
    expect(driver.stream).toBe(io);
    expect(driver.started).toBe(true);
  });

  /**
   * The handshake and the first read can both reach it, and starting twice
   * installs two frame parsers on one socket — a stream of protocol errors
   * rather than a clean failure.
   */
  it("starts only once", () => {
    const driver = { started: false, stream: undefined as unknown };
    startDriver(driver, { hijack: () => ({}) });

    expect(startDriver(driver, { hijack: () => ({}) })).toBe(false);
  });

  it("does nothing without a driver", () => {
    expect(startDriver(undefined, { hijack: () => ({}) })).toBe(false);
  });

  it("tells a server that uses the async callback", () => {
    const seen: unknown[] = [];

    startDriver(
      { started: false, stream: undefined },
      {
        hijack: () => ({}),
        asyncCallback: (response) => seen.push(response[0]),
      },
    );

    expect(seen).toEqual([101]);
  });
});

describe("what the request handler returns", () => {
  /**
   * A real status line, a body, or a Content-Length would be written after the
   * handshake, where the next bytes are supposed to be a WebSocket frame.
   */
  it("is the hijacked status and nothing else", () => {
    expect(rackResponse({ started: false, stream: undefined }, { hijack: () => ({}) })).toEqual([
      HIJACKED_STATUS,
      {},
      [],
    ]);
  });

  it("is negative, which is what servers read as a takeover", () => {
    expect(HIJACKED_STATUS).toBeLessThan(0);
  });

  it("starts the driver on the way", () => {
    const driver = { started: false, stream: undefined as unknown };

    rackResponse(driver, { hijack: () => ({}) });

    expect(driver.started).toBe(true);
  });
});

describe("the server's shared machinery", () => {
  /**
   * One loop, so ten thousand idle connections cost ten thousand descriptors
   * rather than ten thousand threads.
   */
  it("builds the event loop once", () => {
    const server: { eventLoop?: object } = {};
    let built = 0;
    const build = () => {
      built += 1;

      return {};
    };

    const first = eventLoop(server, build);

    expect(eventLoop(server, build)).toBe(first);
    expect(built).toBe(1);
  });

  /**
   * One timer walking every connection, not one per connection: at ten
   * thousand connections the second arrangement is ten thousand timers doing
   * identical work.
   */
  it("sets one heartbeat timer for the whole server", () => {
    const server: { heartbeatTimer?: { cancel(): void } } = {};
    let timers = 0;
    const every = (seconds: number) => {
      timers += 1;

      expect(seconds).toBe(BEAT_INTERVAL_SECONDS);

      return { cancel: () => undefined };
    };

    const first = setupHeartbeatTimer(server, every, () => undefined);

    expect(setupHeartbeatTimer(server, every, () => undefined)).toBe(first);
    expect(timers).toBe(1);
  });

  it("beats every connection on a tick", () => {
    let beats = 0;

    setupHeartbeatTimer(
      {},
      (_seconds, tick) => {
        tick();

        return { cancel: () => undefined };
      },
      () => {
        beats += 1;
      },
    );

    expect(beats).toBe(1);
  });

  /**
   * A Redis client in subscribe mode accepts only subscribe and unsubscribe
   * until it leaves, so sharing the application's client makes every unrelated
   * Redis call fail for as long as the server is listening.
   */
  it("keeps a client of its own for subscriptions", () => {
    const server: { subscriptionsClient?: object } = {};
    let built = 0;
    const build = () => {
      built += 1;

      return {};
    };

    const first = redisConnectionForSubscriptions(server, build);

    expect(redisConnectionForSubscriptions(server, build)).toBe(first);
    expect(built).toBe(1);
  });
});

describe("the URL clients connect to", () => {
  /**
   * A browser refuses a `ws` connection from an `https` page, and the refusal
   * is a console message rather than an error the application sees.
   */
  it("matches the page's scheme", () => {
    expect(determineUrl("/cable", { host: "example.com", secure: true })).toBe(
      "wss://example.com/cable",
    );
    expect(determineUrl("/cable", { host: "example.com" })).toBe("ws://example.com/cable");
  });

  it("leaves an absolute URL alone", () => {
    expect(determineUrl("wss://cable.example.com", { host: "example.com" })).toBe(
      "wss://cable.example.com",
    );
  });

  it("leaves a path alone with no host to build from", () => {
    expect(determineUrl("/cable")).toBe("/cable");
  });

  it("adds the separator a relative mount point is missing", () => {
    expect(determineUrl("cable", { host: "example.com" })).toBe("ws://example.com/cable");
  });
});
