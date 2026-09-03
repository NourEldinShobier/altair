/**
 * A datetime cut to what its column can hold, ported from the
 * `datetime_precision` cases in
 * `activerecord/test/cases/adapters/mysql2/datetime_precision_test.rb` and
 * `activerecord/test/cases/adapters/postgresql/datetime_precision_test.rb`.
 *
 * `datetime(0)` is MySQL's default, and it stores whole seconds. A record
 * written at 12:00:00.523 comes back as 12:00:00 while the object in hand
 * still says .523 — so a test that reloads, a cache key, and a `changed`
 * check all disagree, and the record differs from itself with nothing to say
 * why.
 */

import { describe, expect, it } from "bun:test";
import { DateTimeType } from "../src/types.js";
import { applySecondsPrecision } from "../src/attribute_patterns.js";

const MOMENT = new Date("2026-06-01T12:00:00.523Z");

function typed(precision?: number): DateTimeType {
  return new DateTimeType(precision === undefined ? {} : { precision });
}

describe("a column that did not say", () => {
  /** Nothing changes for a column with no precision, which is most of them. */
  it("keeps every millisecond", () => {
    expect((typed().cast(MOMENT) as Date).toISOString()).toBe("2026-06-01T12:00:00.523Z");
  });
});

describe("a column that holds whole seconds", () => {
  it("drops the milliseconds", () => {
    expect((typed(0).cast(MOMENT) as Date).toISOString()).toBe("2026-06-01T12:00:00.000Z");
  });

  it("does the same to a value that arrived as a string", () => {
    expect((typed(0).cast("2026-06-01T12:00:00.523Z") as Date).toISOString()).toBe(
      "2026-06-01T12:00:00.000Z",
    );
  });

  /**
   * Floored, not rounded. Rounding moves a timestamp *forward*, past the
   * moment it was recorded — so a row could claim to have been created after
   * something that happened after it.
   */
  it("floors rather than rounds", () => {
    expect((typed(0).cast(new Date("2026-06-01T12:00:00.999Z")) as Date).toISOString()).toBe(
      "2026-06-01T12:00:00.000Z",
    );
  });

  /** So a row loaded from that column does not read as changed. */
  it("agrees with a value that came back from the column", () => {
    const type = typed(0);

    expect(type.changed(MOMENT, new Date("2026-06-01T12:00:00.000Z"), undefined)).toBe(false);
  });
});

describe("the finer precisions", () => {
  it("keeps tenths at precision 1", () => {
    expect((typed(1).cast(MOMENT) as Date).toISOString()).toBe("2026-06-01T12:00:00.500Z");
  });

  it("keeps hundredths at precision 2", () => {
    expect((typed(2).cast(MOMENT) as Date).toISOString()).toBe("2026-06-01T12:00:00.520Z");
  });

  it("keeps everything at precision 3", () => {
    expect((typed(3).cast(MOMENT) as Date).toISOString()).toBe("2026-06-01T12:00:00.523Z");
  });

  /**
   * A Date holds milliseconds and nothing finer. Pretending to honour
   * microseconds would be a claim the runtime cannot keep — the column can
   * store them, this cannot, and saying so here would only hide it.
   */
  it("keeps everything at a precision finer than a Date has", () => {
    expect((typed(6).cast(MOMENT) as Date).toISOString()).toBe("2026-06-01T12:00:00.523Z");
  });
});

describe("what is not a datetime", () => {
  it("stays null", () => {
    expect(typed(0).cast(null)).toBeNull();
    expect(typed(0).cast("")).toBeNull();
    expect(typed(0).cast("not a date")).toBeNull();
  });
});

describe("the cut itself", () => {
  it("leaves a value alone when nothing was asked for", () => {
    expect(applySecondsPrecision(MOMENT, undefined).toISOString()).toBe(MOMENT.toISOString());
  });

  it("does not move a value that is already that precise", () => {
    const whole = new Date("2026-06-01T12:00:00.000Z");

    expect(applySecondsPrecision(whole, 0).toISOString()).toBe(whole.toISOString());
  });

  it("does not modify the value it was given", () => {
    const original = new Date(MOMENT);

    applySecondsPrecision(original, 0);

    expect(original.toISOString()).toBe("2026-06-01T12:00:00.523Z");
  });
});
