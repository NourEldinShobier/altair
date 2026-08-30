/**
 * Channel subscription assertions, ported from
 * `actioncable/test/channel/test_case_test.rb`.
 */

import { describe, expect, it } from "bun:test";
import { AssertionFailed } from "@altair/support";
import { Channel } from "../src/channel.js";
import {
  assertConfirmedConnection,
  assertHasNoStream,
  assertHasNoStreamFor,
  assertHasStream,
  assertHasStreamFor,
  assertNoStreams,
  assertRejectConnection,
  stubConnection,
} from "../src/channel_testing.js";

class ChatChannel extends Channel {
  override async subscribed(): Promise<void> {
    this.streamFrom(`chat:${String(this.params.room)}`);
  }
}

class QuietChannel extends Channel {
  override async subscribed(): Promise<void> {}
}

class GuardedChannel extends Channel {
  override async subscribed(): Promise<void> {
    if (!this.params.allowed) return this.reject();
    this.streamFrom("guarded");
  }
}

class GreetingChannel extends Channel {
  override async subscribed(): Promise<void> {
    this.transmit({ hello: "there" });
  }
}

class RoomChannel extends Channel {
  override async subscribed(): Promise<void> {
    this.streamFor({ id: 7 });
  }
}

describe("stubConnection", () => {
  it("runs subscribed and reports the streams", async () => {
    const subscription = await stubConnection(ChatChannel, { room: "1" });

    expect(subscription.streamNames).toEqual(["chat:1"]);
  });

  it("reports acceptance", async () => {
    const subscription = await stubConnection(ChatChannel, { room: "1" });

    expect(subscription.confirmed).toBe(true);
    expect(subscription.rejected).toBe(false);
  });

  it("reports rejection", async () => {
    const subscription = await stubConnection(GuardedChannel, { allowed: false });

    expect(subscription.rejected).toBe(true);
    expect(subscription.confirmed).toBe(false);
  });

  it("gives the channel back", async () => {
    const subscription = await stubConnection(ChatChannel, { room: "1" });

    expect(subscription.channel).toBeInstanceOf(ChatChannel);
  });

  it("collects what was transmitted", async () => {
    const subscription = await stubConnection(GreetingChannel);

    expect(subscription.transmissions).toHaveLength(1);
  });

  /** The connection context is what an authorisation branch actually reads. */
  it("passes the connection context through", async () => {
    class MineChannel extends Channel {
      override async subscribed(): Promise<void> {
        this.streamFrom(`user:${String((this.connection as { userId?: number }).userId)}`);
      }
    }

    const subscription = await stubConnection(MineChannel, {}, { userId: 3 } as never);

    expect(subscription.streamNames).toEqual(["user:3"]);
  });
});

describe("stream assertions", () => {
  it("passes when the stream is there", async () => {
    const subscription = await stubConnection(ChatChannel, { room: "1" });

    expect(() => assertHasStream(subscription, "chat:1")).not.toThrow();
  });

  it("fails when it is not", async () => {
    const subscription = await stubConnection(ChatChannel, { room: "1" });

    expect(() => assertHasStream(subscription, "chat:2")).toThrow(AssertionFailed);
  });

  it("names what was there instead", async () => {
    const subscription = await stubConnection(ChatChannel, { room: "1" });

    expect(() => assertHasStream(subscription, "chat:2")).toThrow(/chat:1/);
  });

  it("asserts absence", async () => {
    const subscription = await stubConnection(ChatChannel, { room: "1" });

    expect(() => assertHasNoStream(subscription, "chat:2")).not.toThrow();
    expect(() => assertHasNoStream(subscription, "chat:1")).toThrow(AssertionFailed);
  });

  it("asserts no streams at all", async () => {
    const subscription = await stubConnection(QuietChannel);

    expect(() => assertNoStreams(subscription)).not.toThrow();
  });

  it("fails no-streams when there is one", async () => {
    const subscription = await stubConnection(ChatChannel, { room: "1" });

    expect(() => assertNoStreams(subscription)).toThrow(AssertionFailed);
  });

  /** Through broadcastingFor, so the test does not restate the naming scheme. */
  it("asserts a stream for a record", async () => {
    const subscription = await stubConnection(RoomChannel);

    expect(() => assertHasStreamFor(subscription, RoomChannel, { id: 7 })).not.toThrow();
  });

  it("fails for the wrong record", async () => {
    const subscription = await stubConnection(RoomChannel);

    expect(() => assertHasStreamFor(subscription, RoomChannel, { id: 8 })).toThrow(AssertionFailed);
    expect(() => assertHasNoStreamFor(subscription, RoomChannel, { id: 8 })).not.toThrow();
  });
});

describe("connection assertions", () => {
  /** An authorisation branch nobody asserts on can be deleted unnoticed. */
  it("asserts rejection", async () => {
    const rejected = await stubConnection(GuardedChannel, { allowed: false });

    expect(() => assertRejectConnection(rejected)).not.toThrow();
  });

  it("fails rejection when it was accepted", async () => {
    const accepted = await stubConnection(GuardedChannel, { allowed: true });

    expect(() => assertRejectConnection(accepted)).toThrow(AssertionFailed);
  });

  it("asserts acceptance", async () => {
    const accepted = await stubConnection(GuardedChannel, { allowed: true });

    expect(() => assertConfirmedConnection(accepted)).not.toThrow();
  });

  it("fails acceptance when it was rejected", async () => {
    const rejected = await stubConnection(GuardedChannel, { allowed: false });

    expect(() => assertConfirmedConnection(rejected)).toThrow(AssertionFailed);
  });

  it("does not stream when it rejected", async () => {
    const rejected = await stubConnection(GuardedChannel, { allowed: false });

    expect(() => assertNoStreams(rejected)).not.toThrow();
  });
});
