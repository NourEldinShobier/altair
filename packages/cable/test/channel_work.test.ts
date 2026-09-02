/**
 * Channel work running through the pool, ported from
 * `actioncable/test/worker_test.rb` and the connection-management cases in
 * `actioncable/test/channel/base_test.rb`.
 *
 * The pool existed and the server never used it, so a channel action ran with
 * no connection management at all and every log line was anonymous. These are
 * about the joint, and about the thing that only became visible once something
 * called it: two sockets working at once.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  aroundWork,
  beforeWork,
  afterWork,
  clearWorkHooks,
  currentWork,
  performWork,
} from "../src/worker_pool.js";
import { Cable, type SocketData } from "../src/server.js";
import { Channel, type CableSocket } from "../src/channel.js";
import {
  connectedIdentifiers,
  disconnectAll,
  identifiedBy,
  resetIdentifiers,
} from "../src/identity.js";

afterEach(clearWorkHooks);

function context(connectionId = "user:1", tags: string[] = []) {
  return { connectionId, tags };
}

describe("who the work belongs to", () => {
  it("is known while it runs", async () => {
    let seen: string | undefined;

    await performWork(context("user:7"), async () => {
      seen = currentWork()?.connectionId;
    });

    expect(seen).toBe("user:7");
  });

  it("is nobody outside it", async () => {
    await performWork(context(), async () => undefined);

    expect(currentWork()).toBeUndefined();
  });

  it("is nobody after the work throws", async () => {
    await expect(
      performWork(context(), async () => {
        throw new Error("the action failed");
      }),
    ).rejects.toThrow("the action failed");

    expect(currentWork()).toBeUndefined();
  });

  /**
   * The failure that appeared the moment the server started calling this. A
   * module-level variable cannot survive two sockets working at once: the
   * first to finish puts back what it found before the second started, and
   * from then on every line is tagged with somebody else's connection.
   */
  it("is right when two connections work at once", async () => {
    const seen: (string | undefined)[] = [];
    const step = () => new Promise((resolve) => setTimeout(resolve, 1));

    await Promise.all([
      performWork(context("user:1"), async () => {
        await step();
        seen.push(currentWork()?.connectionId);
      }),
      performWork(context("user:2"), async () => {
        seen.push(currentWork()?.connectionId);
        await step();
        seen.push(currentWork()?.connectionId);
      }),
    ]);

    expect(seen.filter((one) => one === "user:1")).toHaveLength(1);
    expect(seen.filter((one) => one === "user:2")).toHaveLength(2);
  });

  it("is nobody once both are done", async () => {
    await Promise.all([
      performWork(context("user:1"), async () => undefined),
      performWork(context("user:2"), async () => undefined),
    ]);

    expect(currentWork()).toBeUndefined();
  });

  /** Work inside work sees the inner one, and the outer one gets itself back. */
  it("nests", async () => {
    const seen: (string | undefined)[] = [];

    await performWork(context("outer"), async () => {
      await performWork(context("inner"), async () => {
        seen.push(currentWork()?.connectionId);
      });

      seen.push(currentWork()?.connectionId);
    });

    expect(seen).toEqual(["inner", "outer"]);
  });
});

describe("the hooks around it", () => {
  it("run before and after", async () => {
    const order: string[] = [];

    beforeWork(() => void order.push("before"));
    afterWork(() => void order.push("after"));

    await performWork(context(), async () => void order.push("body"));

    expect(order).toEqual(["before", "body", "after"]);
  });

  /**
   * Where a database connection goes back. A cable server holds one for as
   * long as a client is connected, and one leaked per failed action exhausts
   * the pool in an afternoon.
   */
  it("finish even when the body throws", async () => {
    const order: string[] = [];

    afterWork(() => void order.push("after"));

    await expect(
      performWork(context(), async () => {
        throw new Error("no");
      }),
    ).rejects.toThrow("no");

    expect(order).toEqual(["after"]);
  });

  /**
   * A before hook that throws has still taken whatever the matching after
   * hook returns, and skipping it leaks exactly the resource the failure was
   * about.
   */
  it("finish even when a before hook throws", async () => {
    const order: string[] = [];

    beforeWork(() => {
      throw new Error("could not check out a connection");
    });
    afterWork(() => void order.push("after"));

    await expect(performWork(context(), async () => undefined)).rejects.toThrow(
      "could not check out a connection",
    );

    expect(order).toEqual(["after"]);
  });

  it("wrap the body when they are around hooks", async () => {
    const order: string[] = [];

    aroundWork(async (_context, proceed) => {
      order.push("in");
      await proceed();
      order.push("out");
    });

    await performWork(context(), async () => void order.push("body"));

    expect(order).toEqual(["in", "body", "out"]);
  });
});

// --- through the real server ------------------------------------------------

class RoomChannel extends Channel {
  static override channelName = "RoomChannel";

  override async subscribed(): Promise<void> {
    this.streamFrom("room:1");
  }

  async speak(): Promise<void> {
    // Nothing: the point is that it ran, and what was true while it did.
  }
}

function fakeSocket(data: SocketData): CableSocket & { data: SocketData } {
  return {
    data,
    send: () => undefined,
    subscribe: () => undefined,
    unsubscribe: () => undefined,
    close: () => undefined,
  } as unknown as CableSocket & { data: SocketData };
}

const IDENTIFIER = JSON.stringify({ channel: "RoomChannel" });

describe("what the server runs through the pool", () => {
  let cable: Cable;
  let seen: { connectionId: string; tags: string[] }[];

  beforeEach(() => {
    resetIdentifiers();
    identifiedBy("currentUser");
    Channel.resetRegistry();
    Channel.register(RoomChannel);

    cable = new Cable();
    seen = [];

    beforeWork((work) => void seen.push({ connectionId: work.connectionId, tags: [...work.tags] }));
  });

  afterEach(() => {
    for (const identifier of connectedIdentifiers()) disconnectAll(identifier);
    resetIdentifiers();
  });

  async function open(): Promise<CableSocket & { data: SocketData }> {
    const data = (await cable.upgradeData(
      new Request("https://app.test/cable", { headers: { origin: "https://app.test" } }),
    )) as SocketData;

    data.connection.currentUser = "user:7";

    const socket = fakeSocket(data);
    cable.handlers().open(socket);

    return socket;
  }

  async function send(socket: CableSocket & { data: SocketData }, frame: object): Promise<void> {
    await cable.handlers().message(socket, JSON.stringify(frame));
  }

  it("runs a subscription through it", async () => {
    const socket = await open();

    await send(socket, { command: "subscribe", identifier: IDENTIFIER });

    expect(seen).toHaveLength(1);
  });

  it("runs an action through it", async () => {
    const socket = await open();

    await send(socket, { command: "subscribe", identifier: IDENTIFIER });
    await send(socket, {
      command: "message",
      identifier: IDENTIFIER,
      data: JSON.stringify({ action: "speak" }),
    });

    expect(seen).toHaveLength(2);
  });

  it("runs an unsubscribe through it", async () => {
    const socket = await open();

    await send(socket, { command: "subscribe", identifier: IDENTIFIER });
    await send(socket, { command: "unsubscribe", identifier: IDENTIFIER });

    expect(seen).toHaveLength(2);
  });

  /** Without it every line in a cable log is anonymous. */
  it("says whose connection the work belongs to", async () => {
    const socket = await open();

    await send(socket, { command: "subscribe", identifier: IDENTIFIER });

    expect(seen[0]?.connectionId).toContain("user:7");
  });

  /** And which of that connection's subscriptions it was. */
  it("tags the work with the subscription", async () => {
    const socket = await open();

    await send(socket, { command: "subscribe", identifier: IDENTIFIER });

    expect(seen[0]?.tags).toEqual([IDENTIFIER]);
  });

  /**
   * The reason all of this matters: `withDatabaseConnections` is registered as
   * an around hook, and an action that ran outside the pool would hold no
   * connection and return none.
   */
  it("wraps the action in the around hooks", async () => {
    const order: string[] = [];

    aroundWork(async (_work, proceed) => {
      order.push("checked out");
      await proceed();
      order.push("returned");
    });

    const socket = await open();

    await send(socket, { command: "subscribe", identifier: IDENTIFIER });

    expect(order).toEqual(["checked out", "returned"]);
  });
});
