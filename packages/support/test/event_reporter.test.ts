/**
 * Structured events, ported from `activesupport/test/event_reporter_test.rb`
 * and `event_reporter/tag_stack_test.rb`.
 *
 * The thing under test is not that an event is delivered — it is that the
 * circumstances travel with it, that an event nobody wants costs nothing, and
 * that reporting cannot break the work being reported on.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  EventReporter,
  type ReportedEvent,
  eventContext,
  events,
  setContext,
  tagStack,
  withTags,
} from "../src/event_reporter.js";
import { ParameterFilter } from "../src/filter.js";

afterEach(() => {
  events.reset();
});

function collector(): { events: ReportedEvent[]; emit: (event: ReportedEvent) => void } {
  const collected: ReportedEvent[] = [];

  return {
    events: collected,
    emit: (event) => collected.push(event),
  };
}

describe("the tags an event carries", () => {
  it("is nothing outside a block", () => {
    expect(tagStack()).toEqual({});
  });

  it("is what the block added", async () => {
    await withTags({ requestId: "abc" }, () => {
      expect(tagStack()).toEqual({ requestId: "abc" });
    });
  });

  /**
   * Merged, so a block inside a request can add what it knows without knowing
   * what the request already added.
   */
  it("keeps what an outer block added", async () => {
    await withTags({ requestId: "abc" }, async () => {
      await withTags({ step: "billing" }, () => {
        expect(tagStack()).toEqual({ requestId: "abc", step: "billing" });
      });
    });
  });

  it("lets an inner block replace a tag", async () => {
    await withTags({ step: "a" }, async () => {
      await withTags({ step: "b" }, () => {
        expect(tagStack()["step"]).toBe("b");
      });
    });
  });

  it("does not outlive its block", async () => {
    await withTags({ requestId: "abc" }, () => undefined);

    expect(tagStack()).toEqual({});
  });

  /**
   * The reason these live in async storage: two requests in flight would
   * otherwise stamp each other's identifiers onto each other's events.
   */
  it("does not leak between concurrent blocks", async () => {
    const seen: string[] = [];

    await Promise.all([
      withTags({ requestId: "one" }, async () => {
        await Promise.resolve();
        seen.push(String(tagStack()["requestId"]));
      }),
      withTags({ requestId: "two" }, async () => {
        await Promise.resolve();
        seen.push(String(tagStack()["requestId"]));
      }),
    ]);

    expect(seen.sort()).toEqual(["one", "two"]);
  });

  /** A subscriber holding one must not alter events not yet emitted. */
  it("cannot be edited by whoever reads it", async () => {
    await withTags({ requestId: "abc" }, () => {
      expect(Object.isFrozen(tagStack())).toBe(true);
    });
  });
});

describe("the context an event carries", () => {
  /**
   * Kept apart from tags: merged into one bag, a tag added deep in a call would
   * be indexed as a request-level fact and every dashboard grouped by it would
   * be wrong.
   */
  it("is separate from the tags", async () => {
    await setContext({ account: 7 }, async () => {
      await withTags({ step: "billing" }, () => {
        expect(eventContext()).toEqual({ account: 7 });
        expect(tagStack()).toEqual({ step: "billing" });
      });
    });
  });

  it("merges, and does not outlive its block", async () => {
    await setContext({ account: 7 }, async () => {
      await setContext({ deploy: "abc" }, () => {
        expect(eventContext()).toEqual({ account: 7, deploy: "abc" });
      });
    });

    expect(eventContext()).toEqual({});
  });
});

describe("reporting an event", () => {
  it("reaches a subscriber", () => {
    const reporter = new EventReporter();
    const seen = collector();
    reporter.subscribe(seen);

    expect(reporter.notify("user.created", { id: 1 }, { now: () => 1_000 })).toBe(true);
    expect(seen.events).toHaveLength(1);
    expect(seen.events[0]).toMatchObject({
      name: "user.created",
      payload: { id: 1 },
      timestamp: 1_000,
    });
  });

  it("carries the tags and context in force", async () => {
    const reporter = new EventReporter();
    const seen = collector();
    reporter.subscribe(seen);

    await setContext({ account: 7 }, async () => {
      await withTags({ requestId: "abc" }, () => {
        reporter.notify("user.created");
      });
    });

    expect(seen.events[0]?.tags).toEqual({ requestId: "abc" });
    expect(seen.events[0]?.context).toEqual({ account: 7 });
  });

  it("carries a source location when it is given one", () => {
    const reporter = new EventReporter();
    const seen = collector();
    reporter.subscribe(seen);
    reporter.notify("a", {}, { source: { file: "app/a.ts", line: 3 } });

    expect(seen.events[0]?.source).toEqual({ file: "app/a.ts", line: 3 });
  });

  it("leaves the source out when there is none", () => {
    const reporter = new EventReporter();
    const seen = collector();
    reporter.subscribe(seen);
    reporter.notify("a");

    expect(seen.events[0]).not.toHaveProperty("source");
  });

  it("reports nothing when nobody subscribed", () => {
    expect(new EventReporter().notify("a")).toBe(false);
  });

  /**
   * An event stream is written to a log and usually forwarded to somebody
   * else's service, so an unfiltered payload is a leak nobody reviews again.
   */
  it("filters a payload that carries a secret", () => {
    const reporter = new EventReporter();
    const seen = collector();
    reporter.subscribe(seen);
    reporter.notify("user.created", { id: 1, password: "hunter2" });

    expect(seen.events[0]?.payload).toEqual({ id: 1, password: "[FILTERED]" });
  });

  it("takes a filter of its own", () => {
    const reporter = new EventReporter(new ParameterFilter(["account"]));
    const seen = collector();
    reporter.subscribe(seen);
    reporter.notify("a", { account: 7, password: "hunter2" });

    expect(seen.events[0]?.payload).toEqual({ account: "[FILTERED]", password: "hunter2" });
  });
});

describe("who receives an event", () => {
  it("is everyone without a filter", () => {
    const reporter = new EventReporter();
    reporter.subscribe(collector());
    reporter.subscribe(collector());

    expect(reporter.subscribersFor("anything")).toHaveLength(2);
    expect(reporter.subscriberCount()).toBe(2);
  });

  it("is whoever the filter accepts", () => {
    const reporter = new EventReporter();
    const users = collector();
    reporter.subscribe(users, (event) => event.name.startsWith("user."));
    reporter.notify("sql.query");
    reporter.notify("user.created");

    expect(users.events.map((each) => each.name)).toEqual(["user.created"]);
  });

  /**
   * The whole reason a filter sees only the name: an event nobody listens for
   * should cost a comparison, not a serialised object graph.
   */
  it("does not build a payload nobody asked for", () => {
    const reporter = new EventReporter();
    let built = 0;
    reporter.subscribe(collector(), (event) => event.name === "wanted");

    reporter.notify("unwanted", () => {
      built += 1;

      return {};
    });

    expect(built).toBe(0);

    reporter.notify("wanted", () => {
      built += 1;

      return {};
    });

    expect(built).toBe(1);
  });

  it("stops sending to one that unsubscribed", () => {
    const reporter = new EventReporter();
    const seen = collector();
    reporter.subscribe(seen);
    reporter.unsubscribe(seen);
    reporter.notify("a");

    expect(seen.events).toEqual([]);
    expect(reporter.subscriberCount()).toBe(0);
  });

  it("ignores unsubscribing something that never subscribed", () => {
    const reporter = new EventReporter();
    reporter.subscribe(collector());
    reporter.unsubscribe(collector());

    expect(reporter.subscriberCount()).toBe(1);
  });

  /**
   * At registration, not at the first event: a subscriber registered at boot
   * and first exercised under load is one nobody finds until the incident it
   * was there for.
   */
  it("refuses one that cannot receive an event", () => {
    expect(() => new EventReporter().subscribe({} as never)).toThrow("`emit` method");
  });

  /**
   * Reporting is not the work: an exporter with an expired token must not take
   * down the request that happened to emit an event, nor stop the subscribers
   * after it.
   */
  it("keeps going when a subscriber throws", () => {
    const reporter = new EventReporter();
    const after = collector();
    reporter.subscribe({
      emit: () => {
        throw new Error("boom");
      },
    });
    reporter.subscribe(after);

    expect(() => reporter.notify("a")).not.toThrow();
    expect(after.events).toHaveLength(1);
  });

  it("says nothing was delivered when every subscriber threw", () => {
    const reporter = new EventReporter();
    reporter.subscribe({
      emit: () => {
        throw new Error("boom");
      },
    });

    expect(reporter.notify("a")).toBe(false);
  });
});

describe("a debug event", () => {
  const event = (reporter: EventReporter, seen: ReturnType<typeof collector>) => {
    reporter.subscribe(seen);

    return reporter;
  };

  it("is not reported by default", () => {
    const seen = collector();
    const reporter = event(new EventReporter(), seen);

    expect(reporter.debug("sql.query")).toBe(false);
    expect(seen.events).toEqual([]);
  });

  it("is reported inside a debug block", async () => {
    const seen = collector();
    const reporter = event(new EventReporter(), seen);

    await reporter.withDebug(() => {
      reporter.debug("sql.query", { sql: "SELECT 1" });
    });

    expect(seen.events.map((each) => each.name)).toEqual(["sql.query"]);
  });

  /**
   * Scoped rather than global: globally it is a firehose, and the event worth
   * seeing arrives among thousands that are not.
   */
  it("is not reported after the block", async () => {
    const seen = collector();
    const reporter = event(new EventReporter(), seen);

    await reporter.withDebug(() => undefined);
    reporter.debug("sql.query");

    expect(seen.events).toEqual([]);
  });

  it("can be turned on for the whole process", () => {
    const seen = collector();
    const reporter = event(new EventReporter(), seen);
    reporter.setDebugMode(true);

    expect(reporter.isDebugMode()).toBe(true);
    expect(reporter.debug("sql.query")).toBe(true);
  });

  /**
   * Built eagerly, a debug call would pay for a diagnosis nobody asked for on
   * every request, and the calls would be deleted rather than left where they
   * are useful.
   */
  it("does not build its payload when debug is off", () => {
    const reporter = new EventReporter();
    let built = 0;
    reporter.subscribe(collector());

    reporter.debug("sql.query", () => {
      built += 1;

      return {};
    });

    expect(built).toBe(0);
  });
});

describe("the reporter the framework shares", () => {
  it("is one everybody can reach", () => {
    const seen = collector();
    events.subscribe(seen);
    events.notify("user.created");

    expect(seen.events).toHaveLength(1);
  });

  /**
   * Debug mode included: a test that turned it on and a reporter that kept it
   * would make every later test report its debug events, which is a suite that
   * passes and a log nobody can read.
   */
  it("can be emptied", () => {
    events.subscribe(collector());
    events.setDebugMode(true);
    events.reset();

    expect(events.subscriberCount()).toBe(0);
    expect(events.isDebugMode()).toBe(false);
  });
});
