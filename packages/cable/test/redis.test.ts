/**
 * Broadcasting across processes, ported from
 * `actioncable/test/subscription_adapter/redis_test.rb`.
 *
 * Against a fake Redis rather than a real one: what matters here is the
 * routing — that a broadcast leaves this process, comes back, and is delivered
 * exactly once — and a real server would test Redis rather than this.
 *
 * The gap this closes is the one that has no symptom. Without it a broadcast
 * reaches the sockets held by the process that made it and no others, so an
 * application behind two workers delivers to half its users. Nothing fails.
 */

import { describe, expect, it } from "bun:test";
import { RedisBroadcaster } from "../src/redis.js";
import type { Broadcaster } from "../src/channel.js";

/** A Redis that is really two maps and a list. */
function fakeRedis() {
  const listeners = new Map<string, ((message: string, channel: string) => void)[]>();
  const published: [string, string][] = [];
  let closed = 0;

  const client = {
    publish(channel: string, message: string) {
      published.push([channel, message]);

      // A real Redis delivers to every subscriber, including the one that
      // published — which is what makes the round trip work.
      for (const listener of listeners.get(channel) ?? []) listener(message, channel);

      return 1;
    },
    subscribe(channel: string, listener: (message: string, channel: string) => void) {
      listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
    },
    unsubscribe(channel: string) {
      listeners.delete(channel);
    },
    close() {
      closed += 1;
    },
  };

  return { client, published, listeners, closed: () => closed };
}

/** Records what was delivered to the sockets in this process. */
function localBroadcaster(): Broadcaster & { delivered: [string, string][] } {
  const delivered: [string, string][] = [];

  return {
    delivered,
    publish(topic: string, payload: string) {
      delivered.push([topic, payload]);
    },
  };
}

describe("a broadcast", () => {
  it("goes to Redis rather than straight to the sockets", () => {
    const redis = fakeRedis();
    const local = localBroadcaster();
    const broadcaster = new RedisBroadcaster(redis.client, redis.client, local);

    broadcaster.publish("room:1", "hello");

    expect(redis.published).toEqual([["altair:room:1", "hello"]]);
  });

  /**
   * Delivered on the way back rather than on the way out. Publishing locally
   * as well would deliver it twice to whoever was connected to this process,
   * which is the bug a naive implementation ships with.
   */
  it("arrives exactly once in the process that sent it", () => {
    const redis = fakeRedis();
    const local = localBroadcaster();
    const broadcaster = new RedisBroadcaster(redis.client, redis.client, local);

    broadcaster.publish("room:1", "hello");

    expect(local.delivered).toEqual([["room:1", "hello"]]);
  });

  it("reaches another process listening on the same stream", () => {
    const redis = fakeRedis();

    const here = localBroadcaster();
    const there = localBroadcaster();

    const first = new RedisBroadcaster(redis.client, redis.client, here);
    const second = new RedisBroadcaster(redis.client, redis.client, there);

    // Each process says it is interested because a socket here joined the
    // stream — which is what `useRedis` hooks up to the stream registry. A
    // process that only receives never publishes, so publishing cannot be
    // what makes it subscribe.
    first.listenTo("room:1");
    second.listenTo("room:1");

    second.publish("room:1", "from-second");
    first.publish("room:1", "from-first");

    expect(here.delivered.map(([, payload]) => payload)).toEqual(["from-second", "from-first"]);
    expect(there.delivered.map(([, payload]) => payload)).toEqual(["from-second", "from-first"]);
  });

  it("keeps one stream out of another", () => {
    const redis = fakeRedis();
    const local = localBroadcaster();
    const broadcaster = new RedisBroadcaster(redis.client, redis.client, local);

    broadcaster.publish("room:1", "one");
    broadcaster.publish("room:2", "two");

    expect(local.delivered).toEqual([
      ["room:1", "one"],
      ["room:2", "two"],
    ]);
  });

  // A process that never broadcasts to a stream has no reason to hear about
  // it, and subscribing to everything is how one Redis serves one application.
  it("subscribes to a stream once, on first use", () => {
    const redis = fakeRedis();
    const broadcaster = new RedisBroadcaster(redis.client, redis.client, localBroadcaster());

    broadcaster.publish("room:1", "a");
    broadcaster.publish("room:1", "b");
    broadcaster.publish("room:1", "c");

    expect(redis.listeners.get("altair:room:1")).toHaveLength(1);
  });
});

/**
 * Two applications sharing a Redis is the ordinary case — a review app beside
 * production, two services on one plan — and without a prefix they deliver
 * each other's messages.
 */
describe("the prefix", () => {
  it("keeps two applications apart", () => {
    const redis = fakeRedis();

    const production = localBroadcaster();
    const review = localBroadcaster();

    new RedisBroadcaster(redis.client, redis.client, production, { prefix: "prod" }).publish(
      "room:1",
      "for-production",
    );

    new RedisBroadcaster(redis.client, redis.client, review, { prefix: "review" }).publish(
      "room:1",
      "for-review",
    );

    expect(production.delivered.map(([, one]) => one)).toEqual(["for-production"]);
    expect(review.delivered.map(([, one]) => one)).toEqual(["for-review"]);
  });
});

describe("shutting down", () => {
  it("stops listening and closes both connections", async () => {
    const redis = fakeRedis();
    const broadcaster = new RedisBroadcaster(redis.client, redis.client, localBroadcaster());

    broadcaster.publish("room:1", "a");
    await broadcaster.close();

    expect(redis.listeners.size).toBe(0);
    expect(redis.closed()).toBe(2);
  });
});

/**
 * The bug the cross-process case caught: subscribing on first publish means a
 * process that only listens never subscribes, and so never receives anything.
 * Interest is the trigger, and the stream registry is what reports it.
 */
describe("a process that only listens", () => {
  it("receives without ever publishing", () => {
    const redis = fakeRedis();

    const listener = localBroadcaster();
    const sender = localBroadcaster();

    const listening = new RedisBroadcaster(redis.client, redis.client, listener);
    const sending = new RedisBroadcaster(redis.client, redis.client, sender);

    listening.listenTo("room:1");
    sending.publish("room:1", "hello");

    expect(listener.delivered).toEqual([["room:1", "hello"]]);
  });

  it("stops when its last socket goes", () => {
    const redis = fakeRedis();
    const listener = localBroadcaster();
    const listening = new RedisBroadcaster(redis.client, redis.client, listener);

    listening.listenTo("room:1");
    listening.stopListeningTo("room:1");

    new RedisBroadcaster(redis.client, redis.client, localBroadcaster()).publish("room:1", "hello");

    expect(listener.delivered).toEqual([]);
  });
});
