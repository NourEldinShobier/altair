/**
 * A job's arguments across a queue, ported from
 * `activejob/test/cases/argument_serialization_test.rb`.
 *
 * A queue stores JSON. A Date through `JSON.stringify` and back is a string,
 * so a job that took a date yesterday takes a string today — and
 * `date.getTime()` throws inside a worker, hours after the code that enqueued
 * it looked fine.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Job, MemoryQueue, runJob } from "../src/index.js";
import { addSerializer, deserializeArgument, serializeArgument } from "../src/serializers.js";

/** What survives a real trip through JSON. */
const roundTrip = (value: unknown): unknown =>
  deserializeArgument(JSON.parse(JSON.stringify(serializeArgument(value))));

describe("what survives a queue", () => {
  it("keeps a date a date", () => {
    const when = new Date("2026-08-27T13:05:09.000Z");
    const back = roundTrip(when) as Date;

    expect(back).toBeInstanceOf(Date);
    expect(back.getTime()).toBe(when.getTime());
  });

  // A bigint is a bigint because a number could not hold it, and JSON has only
  // numbers.
  it("keeps a bigint exact", () => {
    const huge = 9_007_199_254_740_993n;

    expect(roundTrip(huge)).toBe(huge);
  });

  it("keeps a set and a map", () => {
    expect(roundTrip(new Set([1, 2]))).toEqual(new Set([1, 2]));
    expect(roundTrip(new Map([["a", 1]]))).toEqual(new Map([["a", 1]]));
  });

  it("leaves the plain values alone", () => {
    for (const value of [1, "a", true, null]) expect(roundTrip(value)).toBe(value);
  });

  /**
   * Where a hand-written version usually stops, and where the bug lives: the
   * date is not the argument, it is inside the argument.
   */
  it("reaches a date inside an object", () => {
    const back = roundTrip({ user: { id: 1, joinedAt: new Date(0) } }) as {
      user: { joinedAt: Date };
    };

    expect(back.user.joinedAt).toBeInstanceOf(Date);
  });

  it("reaches one inside an array", () => {
    const back = roundTrip([new Date(0), new Date(1000)]) as Date[];

    expect(back.every((one) => one instanceof Date)).toBe(true);
  });

  it("reaches one inside a set", () => {
    const back = roundTrip(new Set([new Date(0)])) as Set<Date>;

    expect([...back][0]).toBeInstanceOf(Date);
  });
});

describe("an application's own kind", () => {
  class Money {
    constructor(
      readonly amount: number,
      readonly currency: string,
    ) {}
  }

  beforeEach(() => {
    addSerializer({
      key: "Money",
      serializes: (value) => value instanceof Money,
      serialize: (value) => ({
        amount: (value as Money).amount,
        currency: (value as Money).currency,
      }),
      deserialize: (payload) => {
        const { amount, currency } = payload as { amount: number; currency: string };
        return new Money(amount, currency);
      },
    });
  });

  it("survives the trip", () => {
    const back = roundTrip(new Money(50, "GBP")) as Money;

    expect(back).toBeInstanceOf(Money);
    expect([back.amount, back.currency]).toEqual([50, "GBP"]);
  });

  // A module reloaded in development registers twice, and two serializers for
  // one kind is one shadowing the other for reasons of ordering.
  it("replaces rather than stacking when registered again", () => {
    addSerializer({
      key: "Money",
      serializes: (value) => value instanceof Money,
      serialize: () => ({ amount: 0, currency: "XXX" }),
      deserialize: () => new Money(0, "XXX"),
    });

    expect((roundTrip(new Money(50, "GBP")) as Money).currency).toBe("XXX");
  });

  /**
   * A payload written by a version that had a serializer this one does not.
   * Handing back the wrapper would run the job with an object where it
   * expected a value, which fails somewhere else entirely.
   */
  it("says so when it cannot read a marked payload", () => {
    expect(() => deserializeArgument({ _altair_type: "Gone", value: 1 })).toThrow(
      /No serializer for "Gone"/,
    );
  });
});

describe("a job that takes a date", () => {
  it("gets one back in the worker", async () => {
    const queue = new MemoryQueue();
    Job.adapter = queue;
    Job.resetRegistry();

    const seen: unknown[] = [];

    class Remind extends Job {
      override async perform(at: Date): Promise<void> {
        seen.push(at);
      }
    }

    const when = new Date("2026-08-27T00:00:00.000Z");
    await Remind.performLater(when);

    // Through JSON, as a real queue would.
    const payload = JSON.parse(JSON.stringify(await queue.dequeue("default")));
    await runJob(payload, queue);

    expect(seen[0]).toBeInstanceOf(Date);
    expect((seen[0] as Date).getTime()).toBe(when.getTime());
  });
});
