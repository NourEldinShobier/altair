/**
 * Choosing a queue and deciding what a failure means, ported from
 * `activejob/test/cases/queue_adapter_test.rb`,
 * `queue_naming_test.rb` and `exceptions_test.rb`.
 *
 * These are decisions made once per application and wrong in a way nobody
 * notices until a Friday — an inline adapter in production, staging draining
 * production's queue, a job retrying forever on an error that can never
 * succeed.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  DEFAULT_RETRY_RULE,
  IMMEDIATE_ADAPTERS,
  InlineAdapterInProduction,
  UnknownAdapter,
  adapterNames,
  addSerializers,
  buildQueue,
  checkAdapter,
  clearPerformedJobs,
  configureQueueNaming,
  dispositionFor,
  enqueueRetry,
  excluded,
  executor,
  immediate,
  performedJobs,
  queueAdapter,
  queueNameFromPart,
  queueNaming,
  recordPerformedJob,
  registerAdapter,
  resetExecutor,
  resetQueueNaming,
  retryJob,
  retryWait,
  setExecutor,
} from "../src/adapters.js";
import { argumentSerializers } from "../src/serializers.js";

afterEach(() => {
  resetQueueNaming();
  resetExecutor();
  clearPerformedJobs();
});

const named = (name: string) => {
  const error = new Error("boom");
  error.name = name;

  return error;
};

describe("what a failure means", () => {
  it("retries an error listed as retryable", () => {
    expect(dispositionFor(named("Timeout"), { retryOn: ["Timeout"] })).toBe("retry");
  });

  it("discards one listed as impossible", () => {
    expect(dispositionFor(named("RecordNotFound"), { discardOn: ["RecordNotFound"] })).toBe(
      "discard",
    );
  });

  it("raises anything unlisted", () => {
    expect(dispositionFor(named("Whatever"))).toBe("raise");
    expect(excluded(named("Whatever"))).toBe(true);
  });

  /**
   * A contradiction the application wrote. Discarding is the safe reading:
   * retrying something declared impossible burns a worker until the attempts
   * run out, while discarding loses one job and says so.
   */
  it("discards an error listed as both", () => {
    expect(dispositionFor(named("Timeout"), { retryOn: ["Timeout"], discardOn: ["Timeout"] })).toBe(
      "discard",
    );
  });

  it("says which errors it will not act on", () => {
    expect(excluded(named("Timeout"), { retryOn: ["Timeout"] })).toBe(false);
  });

  it("survives something thrown that is not an error", () => {
    expect(dispositionFor("just a string")).toBe("raise");
  });
});

describe("deciding to retry", () => {
  const policy = { retryOn: ["Timeout"] };

  it("retries while attempts remain", () => {
    const decision = retryJob(named("Timeout"), 1, DEFAULT_RETRY_RULE, policy, 0.5);

    expect(decision.action).toBe("retry");
    expect(decision.attempt).toBe(2);
    expect(decision.waitMs).toBeGreaterThan(0);
  });

  /**
   * "attempts: 5" reads as five runs. An off-by-one here means four or six,
   * and six is a job that outlives the incident that caused it.
   */
  it("stops on the last allowed attempt", () => {
    expect(retryJob(named("Timeout"), 5, { attempts: 5, wait: "exponential" }, policy).action).toBe(
      "raise",
    );
  });

  it("still retries on the one before", () => {
    expect(retryJob(named("Timeout"), 4, { attempts: 5, wait: "exponential" }, policy).action).toBe(
      "retry",
    );
  });

  it("discards when exhausted if that is what was asked for", () => {
    const rule = { attempts: 1, wait: "exponential" as const, onExhausted: "discard" as const };

    expect(retryJob(named("Timeout"), 1, rule, policy).action).toBe("discard");
  });

  it("does not retry something discardable", () => {
    expect(retryJob(named("Gone"), 1, DEFAULT_RETRY_RULE, { discardOn: ["Gone"] }).action).toBe(
      "discard",
    );
  });

  it("does not retry something unlisted", () => {
    expect(retryJob(named("Whatever"), 1).action).toBe("raise");
  });

  it("turns a retry into something a queue can store", () => {
    const decision = retryJob(named("Timeout"), 1, DEFAULT_RETRY_RULE, policy, 0.5);

    expect(enqueueRetry(decision, 1000)).toEqual({
      runAt: 1000 + (decision.waitMs as number),
      attempt: 2,
    });
  });

  it("gives nothing to store for anything else", () => {
    expect(enqueueRetry({ action: "discard", attempt: 1 })).toBeUndefined();
    expect(enqueueRetry({ action: "raise", attempt: 1 })).toBeUndefined();
  });
});

describe("how long it waits", () => {
  it("grows with each attempt", () => {
    const rule = { attempts: 10, wait: "exponential" as const };

    expect(retryWait(rule, 3, 0.5)).toBeGreaterThan(retryWait(rule, 1, 0.5));
  });

  it("takes a polynomial curve", () => {
    const rule = { attempts: 10, wait: "polynomial" as const };

    expect(retryWait(rule, 2, 0.5)).toBe(Math.round(2 ** 4 * 1000));
  });

  it("takes a function of its own", () => {
    const rule = { attempts: 10, wait: () => 5000 };

    expect(retryWait(rule, 3, 0.5)).toBe(5000);
  });

  /** Or an exponential backoff schedules something for next year. */
  it("stops at the ceiling", () => {
    const rule = { attempts: 30, wait: "exponential" as const, maxWaitMs: 60_000 };

    expect(retryWait(rule, 25, 0.5)).toBe(60_000);
  });

  /**
   * A hundred jobs failing on one outage retry at the same moment without
   * jitter, so the service that just came back is hit by the whole backlog and
   * goes down again.
   */
  it("spreads retries out", () => {
    const rule = { attempts: 10, wait: () => 1000 };

    expect(retryWait(rule, 1, 0)).not.toBe(retryWait(rule, 1, 1));
  });

  it("keeps the jitter within a sensible band", () => {
    const rule = { attempts: 10, wait: () => 1000 };

    expect(retryWait(rule, 1, 0)).toBeGreaterThanOrEqual(850);
    expect(retryWait(rule, 1, 1)).toBeLessThanOrEqual(1150);
  });
});

describe("naming a queue", () => {
  it("is the bare name with no prefix", () => {
    expect(queueNameFromPart("mailers")).toBe("mailers");
  });

  /**
   * What stops staging's workers draining production's queue when somebody
   * points a connection string at the wrong host — a failure whose symptom is
   * jobs quietly disappearing rather than an error.
   */
  it("takes the configured prefix", () => {
    configureQueueNaming({ prefix: "staging" });

    expect(queueNameFromPart("mailers")).toBe("staging_mailers");
  });

  it("takes a delimiter of its own", () => {
    configureQueueNaming({ prefix: "staging", delimiter: ":" });

    expect(queueNameFromPart("mailers")).toBe("staging:mailers");
  });

  it("ignores an empty prefix", () => {
    configureQueueNaming({ prefix: "" });

    expect(queueNameFromPart("mailers")).toBe("mailers");
  });

  it("reports what is configured", () => {
    configureQueueNaming({ prefix: "staging" });

    expect(queueNaming().prefix).toBe("staging");
  });

  it("goes back on reset", () => {
    configureQueueNaming({ prefix: "staging" });
    resetQueueNaming();

    expect(queueNameFromPart("mailers")).toBe("mailers");
  });
});

describe("choosing an adapter", () => {
  it("builds one that was registered", () => {
    registerAdapter("fake", () => "the adapter");

    expect(queueAdapter("fake")).toBe("the adapter");
  });

  it("ignores case", () => {
    registerAdapter("fake", () => "the adapter");

    expect(queueAdapter("FAKE")).toBe("the adapter");
  });

  it("refuses one nobody registered", () => {
    expect(() => queueAdapter("nonexistent")).toThrow(UnknownAdapter);
  });

  it("lists what there is", () => {
    registerAdapter("fake", () => "x");

    expect(adapterNames()).toContain("fake");
    expect(() => queueAdapter("nonexistent")).toThrow("fake");
  });

  it("knows which adapters run a job in the caller", () => {
    expect(immediate("inline")).toBe(true);
    expect(immediate("test")).toBe(true);
    expect(IMMEDIATE_ADAPTERS.has("async")).toBe(true);
  });

  it("knows which do not", () => {
    expect(immediate("solid_queue")).toBe(false);
  });

  /**
   * A boot failure rather than a latency graph. Otherwise every background job
   * runs in the foreground and the symptom is a slow endpoint that names
   * nothing about the queue.
   */
  it("refuses an inline adapter in production", () => {
    expect(() => checkAdapter("inline", { production: true })).toThrow(InlineAdapterInProduction);
  });

  it("says what to do about it", () => {
    expect(() => checkAdapter("inline", { production: true })).toThrow("deliver_now");
  });

  it("allows it outside production", () => {
    expect(() => checkAdapter("inline", { production: false })).not.toThrow();
  });

  it("allows it when the environment says it means to", () => {
    expect(() => checkAdapter("inline", { production: true, allowImmediate: true })).not.toThrow();
  });

  it("allows a real adapter in production", () => {
    registerAdapter("solid_queue", () => "real");

    expect(() => checkAdapter("solid_queue", { production: true })).not.toThrow();
  });

  it("checks before it builds", () => {
    registerAdapter("inline", () => "inline adapter");

    expect(() => buildQueue("inline", { production: true })).toThrow(InlineAdapterInProduction);
  });

  it("builds when the check passes", () => {
    registerAdapter("solid_queue", () => "real");

    expect(buildQueue("solid_queue", { production: true })).toBe("real");
  });
});

describe("argument serializers", () => {
  const keysOf = () => argumentSerializers().map((each) => each.key);
  const one = {
    key: "test-one",
    serializes: () => false,
    serialize: (v: unknown) => v,
    deserialize: (v: unknown) => v,
  };
  const two = {
    key: "test-two",
    serializes: () => false,
    serialize: (v: unknown) => v,
    deserialize: (v: unknown) => v,
  };

  it("registers several at once", () => {
    addSerializers(one, two);

    expect(keysOf()).toContain("test-one");
    expect(keysOf()).toContain("test-two");
  });

  /**
   * Passing them in priority order and having the last one win would be a trap
   * nobody reads the docs for.
   */
  it("tries the first argument before the second", () => {
    addSerializers(one, two);

    expect(keysOf().indexOf("test-one")).toBeLessThan(keysOf().indexOf("test-two"));
  });

  /**
   * A module reloaded in development registers twice; two copies would leave
   * the stale one shadowing the fresh one.
   */
  it("replaces rather than duplicating a key", () => {
    addSerializers(one);
    addSerializers(one);

    expect(keysOf().filter((key) => key === "test-one")).toHaveLength(1);
  });

  it("leaves the built-in serializers in front", () => {
    addSerializers(one);

    expect(keysOf().indexOf("Date")).toBeLessThan(keysOf().indexOf("test-one"));
  });
});

describe("where a job runs", () => {
  it("runs it directly by default", async () => {
    expect(await executor()(async () => "done")).toBe("done");
  });

  /**
   * A job that runs outside whatever a request is wrapped in leaks a
   * connection per job, which is a pool exhausted in an hour.
   */
  it("can be wrapped", async () => {
    const around: string[] = [];
    setExecutor(async (body) => {
      around.push("before");
      const result = await body();
      around.push("after");

      return result;
    });

    expect(await executor()(async () => "done")).toBe("done");
    expect(around).toEqual(["before", "after"]);
  });

  it("goes back on reset", async () => {
    setExecutor(async () => "replaced" as never);
    resetExecutor();

    expect(await executor()(async () => "done")).toBe("done");
  });
});

describe("what ran", () => {
  it("records nothing to start with", () => {
    expect(performedJobs()).toEqual([]);
  });

  it("records what performed", () => {
    recordPerformedJob({ name: "SendEmail" });

    expect(performedJobs()).toHaveLength(1);
  });

  it("can be cleared between tests", () => {
    recordPerformedJob({ name: "SendEmail" });
    clearPerformedJobs();

    expect(performedJobs()).toEqual([]);
  });
});
