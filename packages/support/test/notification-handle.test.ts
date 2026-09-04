/**
 * Instrumenting work whose start and finish are in different places, ported
 * from `activesupport/test/notifications/instrumenter_test.rb` — the handle
 * cases.
 *
 * The block form covers work that fits in a block. These are the cases it
 * cannot cover, which are the ones worth measuring.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  type Event,
  Notifications,
  notifications,
  notifier,
  resetNotifier,
  setNotifier,
} from "../src/notifications.js";

afterEach(() => {
  resetNotifier();
  notifications.reset();
});

function bus(): { events: Event[]; on: Notifications } {
  const on = new Notifications();
  const events: Event[] = [];
  on.subscribe("work", (event) => events.push(event));

  return { events, on };
}

describe("a handle", () => {
  it("publishes when it is finished, not when it is started", () => {
    const { events, on } = bus();
    const handle = on.buildHandle("work", { id: 1 });

    handle.start();

    expect(events).toEqual([]);

    handle.finish();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ name: "work", payload: { id: 1 } });
  });

  it("measures the span between them", () => {
    const { events, on } = bus();
    let clock = 100;
    const handle = on.buildHandle("work", {}, () => clock);
    handle.start();
    clock = 350;
    handle.finish();

    expect(events[0]).toMatchObject({ startedAt: 100, finishedAt: 350, duration: 250 });
  });

  /**
   * What the payload holds is usually only known at the end — the row count,
   * the status, the error. Requiring it up front means guessing, or mutating an
   * object a subscriber may already have read.
   */
  it("can be finished with a payload it did not start with", () => {
    const { events, on } = bus();
    const handle = on.buildHandle("work", { id: 1 });
    handle.start();
    handle.finishWithValues("work", { id: 1, rows: 42 });

    expect(events[0]?.payload).toEqual({ id: 1, rows: 42 });
  });

  it("can be finished under a different name", () => {
    const on = new Notifications();
    const seen: string[] = [];
    on.subscribe(/^work/, (event) => seen.push(event.name));

    const handle = on.buildHandle("work", {});
    handle.start();
    handle.finishWithValues("work.failed", {});

    expect(seen).toEqual(["work.failed"]);
  });

  /** Finishing what never started would publish a span measured from nothing. */
  it("refuses to finish before it started", () => {
    const { on } = bus();

    expect(() => on.buildHandle("work", {}).finish()).toThrow("was not started");
  });

  /** Double-counting in every metric built on the event. */
  it("refuses to finish twice", () => {
    const { events, on } = bus();
    const handle = on.buildHandle("work", {});
    handle.start();
    handle.finish();

    expect(() => handle.finish()).toThrow("was not started");
    expect(events).toHaveLength(1);
  });

  it("refuses to start twice", () => {
    const { on } = bus();
    const handle = on.buildHandle("work", {});
    handle.start();

    expect(() => handle.start()).toThrow("already started");
  });

  /**
   * An object rather than nothing, so a caller never writes `handle?.finish()`
   * — the one place that forgets the `?` is a crash on the path that was
   * supposed to be free.
   */
  it("is still a handle when nobody is listening", () => {
    const handle = new Notifications().buildHandle("work", {});

    expect(() => {
      handle.start();
      handle.finish();
      handle.finishWithValues("other", {});
    }).not.toThrow();
  });

  it("reaches the subscribers that match its name", () => {
    const on = new Notifications();
    const seen: string[] = [];
    on.subscribe("other", (event) => seen.push(event.name));

    const handle = on.buildHandle("work", {});
    handle.start();
    handle.finish();

    expect(seen).toEqual([]);
  });
});

describe("the bus the framework reports through", () => {
  it("is the shared one by default", () => {
    expect(notifier()).toBe(notifications);
  });

  /**
   * Substitutable so a suite can isolate itself: a test that subscribed to the
   * shared bus and forgot to unsubscribe reports one test's queries against
   * another's assertions, and the failure names the wrong test.
   */
  it("can be replaced and put back", () => {
    const replacement = new Notifications();
    setNotifier(replacement);

    expect(notifier()).toBe(replacement);

    resetNotifier();

    expect(notifier()).toBe(notifications);
  });
});
