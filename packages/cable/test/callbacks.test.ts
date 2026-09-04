/**
 * Channel lifecycle hooks, ported from
 * `actioncable/test/channel/naming_test.rb` and the callback cases in
 * `actioncable/test/channel/base_test.rb`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Channel } from "../src/channel.js";
import {
  channelHooks,
  onAfterAction,
  onAfterSubscribe,
  onAfterUnsubscribe,
  onBeforeAction,
  onBeforeSubscribe,
  onBeforeUnsubscribe,
  performAction,
  resetChannelHooks,
  runSubscribe,
  runUnsubscribe,
} from "../src/callbacks.js";
import { stubConnection } from "../src/channel-testing.js";

let order: string[] = [];

class ChatChannel extends Channel {
  static override actions = ["speak"];

  override async subscribed(): Promise<void> {
    order.push("subscribed");
    this.streamFrom("chat");
  }

  override async unsubscribed(): Promise<void> {
    order.push("unsubscribed");
  }

  async speak(): Promise<void> {
    order.push("speak");
  }
}

class RejectingChannel extends Channel {
  override async subscribed(): Promise<void> {
    this.reject();
  }
}

class ThrowingChannel extends Channel {
  override async subscribed(): Promise<void> {
    throw new Error("boom");
  }
}

beforeEach(() => {
  order = [];
  resetChannelHooks();
});

afterEach(() => {
  resetChannelHooks();
});

async function channelOf<C extends Channel>(
  klass: Parameters<typeof stubConnection<C>>[0],
): Promise<C> {
  return (await stubConnection(klass)).channel;
}

describe("subscribe hooks", () => {
  it("runs before and after around subscribed", async () => {
    onBeforeSubscribe(ChatChannel, () => {
      order.push("before");
    });
    onAfterSubscribe(ChatChannel, () => {
      order.push("after");
    });

    await runSubscribe(await channelOf(ChatChannel));

    expect(order).toEqual(["subscribed", "before", "subscribed", "after"]);
  });

  it("runs several in registration order", async () => {
    onBeforeSubscribe(ChatChannel, () => {
      order.push("one");
    });
    onBeforeSubscribe(ChatChannel, () => {
      order.push("two");
    });

    order = [];
    const channel = await channelOf(ChatChannel);
    order = [];
    await runSubscribe(channel);

    expect(order.slice(0, 2)).toEqual(["one", "two"]);
  });

  it("hands the channel to the hook", async () => {
    let seen: Channel | undefined;
    onBeforeSubscribe(ChatChannel, (channel) => {
      seen = channel;
    });

    const channel = await channelOf(ChatChannel);
    await runSubscribe(channel);

    expect(seen).toBe(channel);
  });

  /**
   * Rails runs the after hook whether or not the subscription was rejected:
   * "somebody tried to join a room they cannot see" is what an audit hook is
   * for, and a hook that only ran on success would never see it.
   */
  it("runs the after hook even when the subscription is rejected", async () => {
    onAfterSubscribe(RejectingChannel, () => {
      order.push("after");
    });

    const channel = await channelOf(RejectingChannel);
    order = [];
    await runSubscribe(channel);

    expect(order).toEqual(["after"]);
  });

  /** A failed subscription is the one most worth knowing about. */
  it("runs the after hook when subscribed throws", async () => {
    onAfterSubscribe(ThrowingChannel, () => {
      order.push("after");
    });

    const socket = { send() {}, subscribe() {}, unsubscribe() {}, close() {} };
    const channel = new ThrowingChannel({
      socket,
      connection: { request: new Request("https://example.com/cable") },
      identifier: "x",
      params: {},
      broadcaster: { publish: () => undefined },
    });

    await expect(runSubscribe(channel)).rejects.toThrow("boom");

    expect(order).toEqual(["after"]);
  });

  it("does not run another channel's hooks", async () => {
    onBeforeSubscribe(RejectingChannel, () => {
      order.push("wrong");
    });

    const channel = await channelOf(ChatChannel);
    order = [];
    await runSubscribe(channel);

    expect(order).not.toContain("wrong");
  });
});

describe("unsubscribe hooks", () => {
  it("runs before and after around unsubscribed", async () => {
    onBeforeUnsubscribe(ChatChannel, () => {
      order.push("before");
    });
    onAfterUnsubscribe(ChatChannel, () => {
      order.push("after");
    });

    const channel = await channelOf(ChatChannel);
    order = [];
    await runUnsubscribe(channel);

    expect(order).toEqual(["before", "unsubscribed", "after"]);
  });
});

describe("action hooks", () => {
  it("runs before and after around the action", async () => {
    onBeforeAction(ChatChannel, () => {
      order.push("before");
    });
    onAfterAction(ChatChannel, () => {
      order.push("after");
    });

    const channel = await channelOf(ChatChannel);
    order = [];
    await performAction(channel, "speak", {});

    expect(order).toEqual(["before", "speak", "after"]);
  });

  /**
   * The action name is given to the hook, or a timing hook would have to be
   * registered once per action to say anything useful.
   */
  it("tells the hook which action ran", async () => {
    const seen: string[] = [];
    onBeforeAction(ChatChannel, (_channel, action) => {
      seen.push(action);
    });

    await performAction(await channelOf(ChatChannel), "speak", {});

    expect(seen).toEqual(["speak"]);
  });

  it("refuses an action the channel does not expose", async () => {
    const channel = await channelOf(ChatChannel);

    await expect(performAction(channel, "reject", {})).rejects.toThrow(/does not expose an action/);
  });

  it("still runs the after hook when the action is refused", async () => {
    onAfterAction(ChatChannel, () => {
      order.push("after");
    });

    const channel = await channelOf(ChatChannel);
    order = [];

    await expect(performAction(channel, "reject", {})).rejects.toThrow();

    expect(order).toEqual(["after"]);
  });
});

describe("introspection", () => {
  it("reports what is registered", () => {
    onBeforeSubscribe(ChatChannel, () => {});
    onAfterAction(ChatChannel, () => {});

    expect(channelHooks(ChatChannel).beforeSubscribe).toHaveLength(1);
    expect(channelHooks(ChatChannel).afterAction).toHaveLength(1);
    expect(channelHooks(ChatChannel).beforeUnsubscribe).toHaveLength(0);
  });

  it("forgets everything on reset", () => {
    onBeforeSubscribe(ChatChannel, () => {});
    resetChannelHooks();

    expect(channelHooks(ChatChannel).beforeSubscribe).toEqual([]);
  });
});
