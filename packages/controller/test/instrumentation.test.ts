/**
 * The events a controller publishes while serving a request, ported from
 * `actionpack/test/controller/log_subscriber_test.rb` and the instrumentation
 * cases in `actionpack/test/controller/base_test.rb`.
 *
 * The timing breakdown is what most of these are about: the log line is useful
 * only because the parts decompose the total, and what is left over is the
 * controller's own work.
 */

import { describe, expect, it } from "bun:test";
import {
  EventCollector,
  type ProcessActionPayload,
  RuntimeTotals,
  buildInstrumented,
  callbackHalted,
  dataSent,
  fileSent,
  haltedCallback,
  logProcessAction,
  otherRuntime,
  redirected,
  requestCompleted,
  requestStarted,
  rescueFromHandled,
  startProcessing,
  unpermittedParameters,
} from "../src/instrumentation.js";

const payload = (extra: Partial<ProcessActionPayload> = {}): ProcessActionPayload => ({
  controller: "PostsController",
  action: "show",
  method: "GET",
  path: "/posts/7",
  status: 200,
  ...extra,
});

describe("adding up time in a layer", () => {
  /**
   * A request renders many partials and runs many queries. Recording only the
   * last leaves the number meaningless in exactly the requests somebody is
   * investigating.
   */
  it("accumulates across a request", () => {
    const totals = new RuntimeTotals();
    totals.add("view", 10);
    totals.add("view", 5);

    expect(totals.get("view")).toBe(15);
  });

  it("keeps layers apart", () => {
    const totals = new RuntimeTotals();
    totals.add("view", 10);
    totals.add("db", 3);

    expect(totals.toPayload()).toEqual({ view: 10, db: 3 });
  });

  it("reports nothing for a layer never used", () => {
    expect(new RuntimeTotals().get("view")).toBe(0);
  });

  it("forgets everything when reset", () => {
    const totals = new RuntimeTotals();
    totals.add("view", 10);
    totals.reset();

    expect(totals.get("view")).toBe(0);
  });
});

describe("what is left after the measured layers", () => {
  /** The difference is the controller's own work — the thing being looked for. */
  it("subtracts the parts from the total", () => {
    expect(otherRuntime(34, { view: 20, db: 5 })).toBe(9);
  });

  it("is the whole total when nothing was measured", () => {
    expect(otherRuntime(34, {})).toBe(34);
  });

  /**
   * The parts come from separate clocks and can add to fractionally more than
   * the total on a fast request; a negative figure is an artefact, not
   * something to print.
   */
  it("never goes below zero", () => {
    expect(otherRuntime(10, { view: 8, db: 5 })).toBe(0);
  });
});

describe("the completion line", () => {
  it("reports the status and the total", () => {
    expect(logProcessAction(payload(), 34)).toBe("Completed 200 in 34ms");
  });

  it("breaks the total down", () => {
    expect(logProcessAction(payload({ viewRuntime: 20.14, dbRuntime: 5.2 }), 34)).toBe(
      "Completed 200 in 34ms (Views: 20.1ms | ORM: 5.2ms)",
    );
  });

  it("reports only the layers that were measured", () => {
    expect(logProcessAction(payload({ dbRuntime: 5 }), 34)).toBe(
      "Completed 200 in 34ms (ORM: 5.0ms)",
    );
  });

  it("assumes success when nothing said otherwise", () => {
    expect(logProcessAction(payload({ status: undefined }), 10)).toContain("Completed 200");
  });

  it("names the request at the start", () => {
    expect(requestStarted(payload())).toBe('Started GET "/posts/7"');
  });

  it("reports the same line at the end", () => {
    expect(requestCompleted(payload(), 34)).toBe(logProcessAction(payload(), 34));
  });

  it("copies the payload rather than holding it", () => {
    const original = payload();

    expect(startProcessing(original)).not.toBe(original);
    expect(startProcessing(original)).toEqual(original);
  });
});

describe("events that fire only sometimes", () => {
  /**
   * A halted request has a 200 and no action, which reads exactly like an
   * action that ran and did nothing. The filter's name is the only thing that
   * tells them apart.
   */
  it("names the filter that halted the chain", () => {
    const halted = callbackHalted("PostsController", "show", "requireLogin");

    expect(halted.filter).toBe("requireLogin");
    expect(haltedCallback(halted)).toContain("requireLogin");
  });

  it("records a file being sent", () => {
    expect(fileSent("/tmp/report.pdf", { type: "application/pdf" })).toEqual({
      path: "/tmp/report.pdf",
      type: "application/pdf",
    });
  });

  /**
   * The size, never the data: a subscriber that logs payloads would otherwise
   * write whole file contents into the log — enormous, and for anything a user
   * uploaded, a disclosure.
   */
  it("records only the size of sent data", () => {
    const event = dataSent(2048, { filename: "export.csv" });

    expect(event).toEqual({ bytes: 2048, filename: "export.csv" });
    expect(Object.keys(event)).not.toContain("data");
  });

  it("records a redirect", () => {
    expect(redirected("/posts", 302)).toEqual({ location: "/posts", status: 302 });
  });

  /**
   * An unpermitted parameter is usually a rename applied to a form and not to
   * the controller: the field stops saving and nothing says so.
   */
  it("reports unpermitted parameters", () => {
    expect(unpermittedParameters(["admin"], "PostsController", "create")).toEqual({
      keys: ["admin"],
      controller: "PostsController",
      action: "create",
    });
  });

  it("records which handler took an exception", () => {
    expect(rescueFromHandled(new TypeError("bad"), "handleTypeError")).toEqual({
      handler: "handleTypeError",
      exception: ["TypeError", "bad"],
    });
  });

  it("records something thrown that is not an error", () => {
    expect(rescueFromHandled("boom", "h")["exception"]).toEqual(["string", "boom"]);
  });
});

describe("collecting what a request published", () => {
  it("subscribes once", () => {
    const collector = new EventCollector();
    let subscriptions = 0;

    collector.ensureSubscribed(() => {
      subscriptions += 1;
    });
    collector.ensureSubscribed(() => {
      subscriptions += 1;
    });

    expect(subscriptions).toBe(1);
    expect(collector.subscribed).toBe(true);
  });

  it("records what it is given", () => {
    const collector = new EventCollector();
    collector.ensureSubscribed((record) => {
      record({ name: "process_action", payload: {} });
      record({ name: "redirect_to", payload: {} });
    });

    expect(collector.collectEvents()).toHaveLength(2);
  });

  it("filters by name", () => {
    const collector = new EventCollector();
    collector.ensureSubscribed((record) => {
      record({ name: "process_action", payload: {} });
      record({ name: "redirect_to", payload: {} });
    });

    expect(collector.collectEvents("redirect_to")).toHaveLength(1);
  });

  it("empties", () => {
    const collector = new EventCollector();
    collector.ensureSubscribed((record) => record({ name: "x", payload: {} }));

    collector.reset();

    expect(collector.collectEvents()).toEqual([]);
  });
});

describe("wrapping an action", () => {
  const clock = () => {
    let time = 0;

    return () => (time += 10);
  };

  it("publishes a start and a finish", async () => {
    const seen: string[] = [];

    await buildInstrumented(
      payload(),
      (name) => seen.push(name),
      async () => undefined,
      clock(),
    );

    expect(seen).toEqual(["start_processing", "process_action"]);
  });

  it("measures how long the body took", async () => {
    let measured = 0;

    await buildInstrumented(
      payload(),
      (name, _payload, totalMs) => {
        if (name === "process_action") measured = totalMs;
      },
      async () => undefined,
      clock(),
    );

    expect(measured).toBe(10);
  });

  it("hands back what the body returned", async () => {
    expect(
      await buildInstrumented(
        payload(),
        () => undefined,
        async () => 7,
        clock(),
      ),
    ).toBe(7);
  });

  /**
   * An action that raised is the one whose timing matters most, and an event
   * that simply does not fire leaves a gap at the moment something went wrong.
   */
  it("still publishes when the body throws", async () => {
    const seen: string[] = [];

    await expect(
      buildInstrumented(
        payload(),
        (name) => seen.push(name),
        async () => {
          throw new Error("boom");
        },
        clock(),
      ),
    ).rejects.toThrow("boom");
    expect(seen).toEqual(["start_processing", "process_action"]);
  });

  it("records the exception on the payload", async () => {
    const given = payload();

    await expect(
      buildInstrumented(
        given,
        () => undefined,
        async () => {
          throw new Error("boom");
        },
        clock(),
      ),
    ).rejects.toThrow();
    expect(given.exception).toEqual(["Error", "boom"]);
  });
});
