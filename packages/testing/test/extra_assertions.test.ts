/**
 * The small assertions and the notification ones, ported from
 * `activesupport/test/test_case_test.rb` and
 * `activesupport/test/notifications/instrumenter_test.rb`.
 */

import { describe, expect, it } from "bun:test";
import { AssertionFailed, notifications } from "@altair/support";
import {
  assertNoNotifications,
  assertNotification,
  assertNotificationsCount,
} from "../src/notification_assertions.js";
import { assertInBody, assertNot, assertNotInBody, assertRaises } from "../src/plain_assertions.js";

describe("assertNot", () => {
  it("passes on a falsy value", () => {
    expect(() => {
      assertNot(false);
      assertNot(null);
      assertNot(0);
    }).not.toThrow();
  });

  it("fails on a truthy value", () => {
    expect(() => assertNot(true)).toThrow(AssertionFailed);
  });

  it("uses the message it was given", () => {
    expect(() => assertNot(true, "should not be published")).toThrow(/should not be published/);
  });
});

describe("assertRaises", () => {
  /** The handing back is the point: the assertions that matter are on the error. */
  it("gives the error back", async () => {
    const error = await assertRaises(() => {
      throw new TypeError("bad shape");
    });

    expect(error.message).toBe("bad shape");
  });

  it("fails when nothing was thrown", async () => {
    await expect(assertRaises(() => 1)).rejects.toThrow(/did not/);
  });

  it("checks the class", async () => {
    await expect(
      assertRaises(() => {
        throw new TypeError("x");
      }, TypeError),
    ).resolves.toBeInstanceOf(TypeError);
  });

  it("fails on the wrong class", async () => {
    await expect(
      assertRaises(() => {
        throw new Error("x");
      }, TypeError),
    ).rejects.toThrow(/Expected a TypeError/);
  });

  it("checks the message against a pattern", async () => {
    await expect(
      assertRaises(() => {
        throw new Error("record not found");
      }, /not found/),
    ).resolves.toBeDefined();
  });

  it("fails when the message does not match", async () => {
    await expect(
      assertRaises(() => {
        throw new Error("something else");
      }, /not found/),
    ).rejects.toThrow(/to match/);
  });

  it("catches an async rejection too", async () => {
    const error = await assertRaises(async () => {
      await Promise.reject(new Error("later"));
    });

    expect(error.message).toBe("later");
  });
});

describe("body assertions", () => {
  function page(): Response {
    return new Response("<h1>Hello</h1>", { headers: { "content-type": "text/html" } });
  }

  it("finds a substring", async () => {
    await expect(assertInBody(page(), "Hello")).resolves.toBeUndefined();
  });

  it("finds a pattern", async () => {
    await expect(assertInBody(page(), /h1/)).resolves.toBeUndefined();
  });

  it("fails when it is absent", async () => {
    await expect(assertInBody(page(), "Goodbye")).rejects.toThrow(AssertionFailed);
  });

  it("asserts absence", async () => {
    await expect(assertNotInBody(page(), "Goodbye")).resolves.toBeUndefined();
    await expect(assertNotInBody(page(), "Hello")).rejects.toThrow(AssertionFailed);
  });

  /** A Response body reads once; emptying it would break the next line. */
  it("leaves the body readable", async () => {
    const response = page();
    await assertInBody(response, "Hello");

    expect(await response.text()).toBe("<h1>Hello</h1>");
  });
});

describe("notification assertions", () => {
  it("sees an event the block published", async () => {
    const events = await assertNotification("test.event", () => {
      notifications.publish("test.event", { id: 1 });
    });

    expect(events).toHaveLength(1);
  });

  /** Returned, not just asserted: the payload is usually the part that matters. */
  it("hands the events back", async () => {
    const events = await assertNotification("test.event", () => {
      notifications.publish("test.event", { id: 7 });
    });

    expect(events[0]?.payload).toEqual({ id: 7 });
  });

  it("fails when nothing was published", async () => {
    await expect(assertNotification("test.event", () => {})).rejects.toThrow(AssertionFailed);
  });

  it("matches a family with a pattern", async () => {
    const events = await assertNotification(/^test\./, () => {
      notifications.publish("test.one", {});
      notifications.publish("test.two", {});
    });

    expect(events).toHaveLength(2);
  });

  it("counts them", async () => {
    await expect(
      assertNotificationsCount("test.event", 2, () => {
        notifications.publish("test.event", {});
        notifications.publish("test.event", {});
      }),
    ).resolves.toHaveLength(2);
  });

  it("fails on the wrong count", async () => {
    await expect(
      assertNotificationsCount("test.event", 2, () => {
        notifications.publish("test.event", {});
      }),
    ).rejects.toThrow(/Expected 2/);
  });

  it("asserts silence", async () => {
    await expect(assertNoNotifications("test.event", () => {})).resolves.toBeUndefined();
  });

  it("fails when something was published", async () => {
    await expect(
      assertNoNotifications("test.event", () => {
        notifications.publish("test.event", {});
      }),
    ).rejects.toThrow(/Expected no notification/);
  });

  it("ignores events the pattern does not match", async () => {
    await expect(
      assertNoNotifications("test.wanted", () => {
        notifications.publish("test.other", {});
      }),
    ).resolves.toBeUndefined();
  });

  /**
   * A failing block must still unsubscribe, or the listener stays on the global
   * bus and every later test in the file feeds it too. The leak is invisible
   * from the outside — the events still arrive, just to nobody — so the count
   * is what makes it observable.
   */
  it("unsubscribes even when the block throws", async () => {
    const before = notifications.listenersFor("test.event");

    await expect(
      assertNotification("test.event", () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(notifications.listenersFor("test.event")).toBe(before);
  });

  it("unsubscribes after a passing block too", async () => {
    const before = notifications.listenersFor("test.event");

    await assertNotification("test.event", () => {
      notifications.publish("test.event", {});
    });

    expect(notifications.listenersFor("test.event")).toBe(before);
  });
});
