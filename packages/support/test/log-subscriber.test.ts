/**
 * Turning instrumentation into log lines, ported from
 * `activesupport/test/log_subscriber_test.rb`,
 * `activesupport/test/subscriber_test.rb` and the event cases in
 * `activesupport/test/notifications/evented_notification_test.rb`.
 *
 * The two rules worth testing are both about logging never being the thing
 * that takes an application down: a subscriber that throws is reported rather
 * than raised, and a silenced event does no work at all.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { Notifications } from "../src/notifications.js";
import {
  EventRecord,
  Instrumenter,
  LogSubscriber,
  type SubscriberLogger,
  allListenersFor,
  attachTo,
  detachAll,
  detachFrom,
  eventMatcher,
  fetchPublicMethods,
  flushAll,
  logSubscribers,
  methodFor,
  newEvent,
  nullInstrumenter,
  onSubscriberError,
  subscribedTo,
  subscribers,
} from "../src/log-subscriber.js";

class Recorder implements SubscriberLogger {
  readonly lines: string[] = [];
  flushed = 0;

  debug(message: string): void {
    this.lines.push(`debug ${message}`);
  }

  info(message: string): void {
    this.lines.push(`info ${message}`);
  }

  warn(message: string): void {
    this.lines.push(`warn ${message}`);
  }

  error(message: string): void {
    this.lines.push(`error ${message}`);
  }

  flush(): void {
    this.flushed += 1;
  }
}

class SqlSubscriber extends LogSubscriber {
  sql(event: { payload: Record<string, unknown> }): void {
    this.logger?.info(`SQL ${String(event.payload["sql"])}`);
  }

  cacheHit(): void {
    this.logger?.debug("cache hit");
  }
}

const attached = (bus = new Notifications()) => {
  const subscriber = new SqlSubscriber();
  const logger = new Recorder();
  subscriber.logger = logger;
  attachTo("orm", subscriber, bus);

  return { bus, subscriber, logger };
};

afterEach(() => {
  detachAll();
  onSubscriberError(() => undefined);
});

describe("finding the handler for an event", () => {
  it("takes the part before the namespace", () => {
    expect(methodFor("sql.orm")).toBe("sql");
  });

  it("builds the name a method listens on", () => {
    expect(eventMatcher("sql", "orm")).toBe("sql.orm");
  });

  it("finds the methods a subscriber defines", () => {
    expect(fetchPublicMethods(new SqlSubscriber()).sort()).toEqual(["cacheHit", "sql"]);
  });

  /** Subscribing `call` to an event named after it is a loop. */
  it("leaves the machinery out", () => {
    const found = fetchPublicMethods(new SqlSubscriber());

    expect(found).not.toContain("call");
    expect(found).not.toContain("flush");
  });
});

describe("attaching", () => {
  it("subscribes every handler method", () => {
    const { bus } = attached();

    expect(bus.isSubscribed("sql.orm")).toBe(true);
    expect(bus.isSubscribed("cacheHit.orm")).toBe(true);
  });

  /**
   * One subscription per method, so an event with no handler costs nothing —
   * the bus never calls us instead of calling us to find nothing to do.
   */
  it("does not subscribe to events it cannot handle", () => {
    const { bus } = attached();

    expect(bus.isSubscribed("commit.orm")).toBe(false);
  });

  it("lists what it is listening on", () => {
    attached();

    expect(allListenersFor("orm").sort()).toEqual(["cacheHit.orm", "sql.orm"]);
    expect(subscribedTo("sql.orm")).toBe(true);
  });

  it("lists the subscribers", () => {
    const { subscriber } = attached();

    expect(logSubscribers("orm")).toEqual([subscriber]);
    expect(subscribers()).toEqual([subscriber]);
  });

  it("lists none for another namespace", () => {
    attached();

    expect(logSubscribers("mailer")).toEqual([]);
  });

  it("dispatches an event to the method named after it", () => {
    const { bus, logger } = attached();

    bus.publish("sql.orm", { sql: "SELECT 1" });

    expect(logger.lines).toEqual(["info SQL SELECT 1"]);
  });

  /**
   * Unsubscribed rather than flagged: one that stays attached still holds a
   * reference to everything it closed over, which in a reloading process is a
   * leaked object graph per reload.
   */
  it("stops receiving once detached", () => {
    const { bus, logger } = attached();
    detachFrom("orm");

    bus.publish("sql.orm", { sql: "SELECT 1" });

    expect(logger.lines).toEqual([]);
    expect(bus.isSubscribed("sql.orm")).toBe(false);
  });

  it("says how many it detached", () => {
    attached();

    expect(detachFrom("orm")).toBe(1);
    expect(detachFrom("orm")).toBe(0);
  });

  it("leaves another namespace attached", () => {
    const bus = new Notifications();
    attached(bus);
    const other = new SqlSubscriber();
    attachTo("mailer", other, bus);

    detachFrom("orm");

    expect(subscribers()).toEqual([other]);
  });

  it("flushes every subscriber's logger", () => {
    const { logger } = attached();

    flushAll();

    expect(logger.flushed).toBe(1);
  });
});

/**
 * Called directly rather than through the bus. `Notifications` swallows a
 * throwing subscriber itself, so going through it would pass whether or not
 * `LogSubscriber` handled anything — the catch under test has to be the one
 * being exercised.
 */
describe("when a subscriber fails", () => {
  class Broken extends LogSubscriber {
    sql(): void {
      throw new Error("formatting blew up");
    }
  }

  const broken = () => {
    const subscriber = new Broken();
    const logger = new Recorder();
    subscriber.logger = logger;

    return { subscriber, logger };
  };

  /**
   * A logging bug must not fail the request it was describing — an exception
   * while formatting a message about a query would otherwise surface as a
   * failed checkout.
   */
  it("does not raise out of the dispatch", () => {
    const { subscriber } = broken();

    expect(() => subscriber.call({ name: "sql.orm", payload: {} } as never)).not.toThrow();
  });

  it("reports it instead", () => {
    const { subscriber } = broken();
    const reported: unknown[] = [];
    onSubscriberError((name, error) => reported.push([name, (error as Error).message]));

    subscriber.call({ name: "sql.orm", payload: {} } as never);

    expect(reported).toEqual([["sql.orm", "formatting blew up"]]);
  });

  it("says so in the log too", () => {
    const { subscriber, logger } = broken();

    subscriber.call({ name: "sql.orm", payload: {} } as never);

    expect(logger.lines[0]).toContain("Could not log sql.orm");
  });
});

describe("silencing", () => {
  /**
   * The point of checking before the call: a debug line nobody will read must
   * not serialise a query plan on every request.
   */
  it("does not call the handler for a silenced event", () => {
    const bus = new Notifications();
    const subscriber = new SqlSubscriber();
    const logger = new Recorder();
    subscriber.logger = logger;
    subscriber.level = "info";
    subscriber.subscribeLogLevel("sql.orm", "debug");
    attachTo("orm", subscriber, bus);

    bus.publish("sql.orm", { sql: "SELECT 1" });

    expect(logger.lines).toEqual([]);
  });

  it("still calls it for an event at the level", () => {
    const bus = new Notifications();
    const subscriber = new SqlSubscriber();
    const logger = new Recorder();
    subscriber.logger = logger;
    subscriber.level = "info";
    subscriber.subscribeLogLevel("sql.orm", "info");
    attachTo("orm", subscriber, bus);

    bus.publish("sql.orm", { sql: "SELECT 1" });

    expect(logger.lines).toHaveLength(1);
  });

  /** No logger is the strongest form of silenced. */
  it("is silent with no logger at all", () => {
    const subscriber = new SqlSubscriber();

    expect(subscriber.silenced("sql.orm")).toBe(true);
  });

  it("reports the level an event needs", () => {
    const subscriber = new SqlSubscriber();
    subscriber.subscribeLogLevel("sql.orm", "warn");

    expect(subscriber.eventLogLevel("sql.orm")).toBe("warn");
    expect(subscriber.eventLogLevel("other.orm")).toBe("debug");
  });

  /**
   * A no-op, not a caught error. Without the check for a handler, calling
   * `undefined` throws and the catch turns every unhandled event into a
   * reported failure — which is silent from the outside but fills the error
   * reporter with events that were never anybody's to handle.
   */
  it("does nothing at all for an event nothing handles", () => {
    const subscriber = new SqlSubscriber();
    const logger = new Recorder();
    subscriber.logger = logger;
    const reported: unknown[] = [];
    onSubscriberError((name) => reported.push(name));

    subscriber.call({ name: "nothing.orm", payload: {} } as never);

    expect(logger.lines).toEqual([]);
    expect(reported).toEqual([]);
  });
});

describe("measuring", () => {
  it("times a body", () => {
    const event = newEvent("sql.orm");
    event.start(1000, 0);
    event.finish(1030, 0);

    expect(event.duration).toBe(30);
  });

  it("has no duration before it finishes", () => {
    const event = newEvent("sql.orm");
    event.start(1000, 0);

    expect(event.duration).toBe(0);
    expect(event.finishedAt).toBeUndefined();
  });

  it("reports processor time", () => {
    const event = new EventRecord("sql.orm");
    event.start(1000, 5);
    event.finish(1030, 12);

    expect(event.cpuTime).toBe(7);
  });

  /**
   * The number that says whether a slow request was slow because of us or
   * because it was waiting on a database.
   */
  it("reports the time spent waiting", () => {
    const event = new EventRecord("sql.orm");
    event.start(1000, 5);
    event.finish(1030, 12);

    expect(event.idleTime).toBe(23);
  });

  /**
   * The clocks are sampled separately, so on a short span cpu time can read
   * above wall time — an artefact, not something to display.
   */
  it("never reports negative waiting", () => {
    const event = new EventRecord("sql.orm");
    event.start(1000, 0);
    event.finish(1001, 50);

    expect(event.idleTime).toBe(0);
  });

  it("records what a body returned", () => {
    expect(newEvent("x").record(() => 7)).toBe(7);
  });

  /**
   * A failed operation is exactly the one worth having a timing for; an event
   * that vanishes leaves a gap at the moment something went wrong.
   */
  it("still finishes when the body throws", () => {
    const event = newEvent("x");

    expect(() =>
      event.record(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(event.finishedAt).toBeDefined();
  });

  it("puts the failure on the payload", () => {
    const event = newEvent("x");

    try {
      event.record(() => {
        throw new Error("boom");
      });
    } catch {
      // asserted below
    }

    expect(event.payload["exception"]).toEqual(["Error", "boom"]);
  });

  it("measures an asynchronous body too", async () => {
    const event = newEvent("x");

    await expect(
      event.recordAsync(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(event.payload["exception"]).toEqual(["Error", "boom"]);
  });
});

describe("instrumenting", () => {
  it("publishes what it measured", () => {
    const published: EventRecord[] = [];
    const instrumenter = new Instrumenter((event) => published.push(event));

    instrumenter.instrument("sql.orm", { sql: "SELECT 1" }, () => undefined);

    expect(published).toHaveLength(1);
    expect(published[0]?.payload["sql"]).toBe("SELECT 1");
  });

  /** "This query failed after 3 seconds" is worth more than nothing. */
  it("publishes even when the body throws", () => {
    const published: EventRecord[] = [];
    const instrumenter = new Instrumenter((event) => published.push(event));

    expect(() =>
      instrumenter.instrument("sql.orm", {}, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(published[0]?.payload["exception"]).toEqual(["Error", "boom"]);
  });

  it("hands back what the body returned", () => {
    expect(new Instrumenter(() => undefined).instrument("x", {}, () => 7)).toBe(7);
  });

  it("measures an asynchronous body", async () => {
    const published: EventRecord[] = [];
    const instrumenter = new Instrumenter((event) => published.push(event));

    await instrumenter.instrumentAsync("sql.orm", {}, async () => undefined);

    expect(published).toHaveLength(1);
  });

  it("publishes a span that does not nest in a block", () => {
    const published: EventRecord[] = [];
    const instrumenter = new Instrumenter((event) => published.push(event));

    const event = instrumenter.start("render.view", { template: "index" });
    instrumenter.finishWithState(event, { status: 200 });

    expect(published).toHaveLength(1);
    expect(published[0]?.payload).toEqual({ template: "index", status: 200 });
  });

  /**
   * Not an `if` at every call site: instrumentation with nobody listening
   * should cost one virtual call, and the measured code should not know.
   */
  it("still runs the body with nobody listening", () => {
    let ran = 0;

    const returned = nullInstrumenter.instrument("x", {}, () => {
      ran += 1;

      return "value";
    });

    expect(ran).toBe(1);
    expect(returned).toBe("value");
  });
});
