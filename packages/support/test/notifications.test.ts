/**
 * Instrumentation suite.
 *
 * Mirrors activesupport/test/notifications/. Covers the failure paths hardest,
 * because a bus that drops the framework when a subscriber misbehaves is worse
 * than no bus.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Notifications, type Event } from "../src/notifications.js";

let bus: Notifications;

beforeEach(() => {
  bus = new Notifications();
});

describe("subscribing", () => {
  it("delivers events to a named subscriber", async () => {
    const events: Event[] = [];
    bus.subscribe("sql.altair", (event) => events.push(event));

    await bus.instrument("sql.altair", { sql: "SELECT 1" }, () => null);

    expect(events).toHaveLength(1);
    expect(events[0]!.name).toBe("sql.altair");
    expect(events[0]!.payload).toEqual({ sql: "SELECT 1" });
  });

  it("ignores an event nobody asked for", async () => {
    const events: Event[] = [];
    bus.subscribe("sql.altair", (event) => events.push(event));

    await bus.instrument("render.altair", {}, () => null);
    expect(events).toHaveLength(0);
  });

  it("matches a family with a regex", async () => {
    const names: string[] = [];
    bus.subscribe(/\.altair$/, (event) => names.push(event.name));

    await bus.instrument("sql.altair", {}, () => null);
    await bus.instrument("render.altair", {}, () => null);
    await bus.instrument("sql.other", {}, () => null);

    expect(names).toEqual(["sql.altair", "render.altair"]);
  });

  it("delivers to every matching subscriber", async () => {
    let calls = 0;
    bus.subscribe("event", () => (calls += 1));
    bus.subscribe("event", () => (calls += 1));
    bus.subscribe(/ev/, () => (calls += 1));

    await bus.instrument("event", {}, () => null);
    expect(calls).toBe(3);
  });

  it("stops delivering after unsubscribe", async () => {
    let calls = 0;
    const subscription = bus.subscribe("event", () => (calls += 1));

    await bus.instrument("event", {}, () => null);
    subscription.unsubscribe();
    await bus.instrument("event", {}, () => null);

    expect(calls).toBe(1);
  });

  // A caller can skip building an expensive payload when nothing is listening.
  it("reports whether anything is listening", () => {
    expect(bus.isSubscribed("sql.altair")).toBe(false);

    bus.subscribe(/altair/, () => {});
    expect(bus.isSubscribed("sql.altair")).toBe(true);
    expect(bus.isSubscribed("other")).toBe(false);
  });

  it("resets", async () => {
    bus.subscribe("event", () => {});
    bus.reset();

    expect(bus.subscriberCount).toBe(0);
  });
});

describe("timing", () => {
  it("measures how long the block took", async () => {
    const events: Event[] = [];
    bus.subscribe("slow", (event) => events.push(event));

    await bus.instrument("slow", {}, () => Bun.sleep(20));

    expect(events[0]!.duration).toBeGreaterThanOrEqual(15);
    expect(events[0]!.finishedAt).toBeGreaterThan(events[0]!.startedAt);
  });

  // performance.now() is monotonic; Date.now() can move backwards when the
  // clock is adjusted, and a negative duration in a metric is worse than none.
  it("never reports a negative duration", async () => {
    const events: Event[] = [];
    bus.subscribe("fast", (event) => events.push(event));

    for (let index = 0; index < 20; index += 1) {
      await bus.instrument("fast", {}, () => null);
    }

    expect(events.every((event) => event.duration >= 0)).toBe(true);
  });

  it("returns the block's value", async () => {
    expect(await bus.instrument("event", {}, () => 42)).toBe(42);
    expect(await bus.instrument("event", {}, async () => "async")).toBe("async");
  });
});

describe("failures", () => {
  // A failing query is exactly the one worth having in the log.
  it("publishes an event when the block throws", async () => {
    const events: Event[] = [];
    bus.subscribe("sql.altair", (event) => events.push(event));

    await expect(
      bus.instrument("sql.altair", { sql: "bad" }, () => {
        throw new Error("syntax error");
      }),
    ).rejects.toThrow("syntax error");

    expect(events).toHaveLength(1);
    expect((events[0]!.error as Error).message).toBe("syntax error");
  });

  it("rethrows the original error", async () => {
    const original = new TypeError("nope");

    await expect(
      bus.instrument("event", {}, () => {
        throw original;
      }),
    ).rejects.toBe(original);
  });

  // A broken subscriber must not break the thing it was watching.
  it("survives a subscriber that throws", async () => {
    const seen: string[] = [];

    bus.subscribe("event", () => {
      throw new Error("subscriber is broken");
    });
    bus.subscribe("event", () => seen.push("second"));

    await expect(bus.instrument("event", {}, () => "fine")).resolves.toBe("fine");
    // And must not stop the other subscribers either.
    expect(seen).toEqual(["second"]);
  });
});

describe("publishing directly", () => {
  it("publishes an event timed elsewhere", () => {
    const events: Event[] = [];
    bus.subscribe("external", (event) => events.push(event));

    bus.publish("external", { source: "elsewhere" }, 250);

    expect(events[0]!.duration).toBe(250);
    expect(events[0]!.payload).toEqual({ source: "elsewhere" });
  });

  it("defaults to no duration", () => {
    const events: Event[] = [];
    bus.subscribe("external", (event) => events.push(event));

    bus.publish("external", {});
    expect(events[0]!.duration).toBe(0);
  });
});
