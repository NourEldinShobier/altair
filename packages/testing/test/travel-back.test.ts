/**
 * Holding the clock across a whole file, ported from the `travel_back` cases
 * in `activesupport/test/testing/time_helpers_test.rb`.
 *
 * The block form covers one test. A suite that wants every test in a file to
 * run at a fixed date has no block to use — a runner's per-test hooks are two
 * separate functions — which is what the unblocked form and `travelBack` are
 * for, and why the way they fail matters.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { currentTime, freezeTime, isTimeFrozen, travelBack, travelTo } from "@altair/support";

const MOMENT = new Date("2026-06-01T12:00:00.000Z");

// Whatever a test in here did, the next file gets a real clock.
afterEach(travelBack);

describe("travelling without a block", () => {
  it("holds the clock until it is given back", () => {
    travelTo(MOMENT);

    expect(isTimeFrozen()).toBe(true);
    expect(currentTime().toISOString()).toBe(MOMENT.toISOString());

    travelBack();

    expect(isTimeFrozen()).toBe(false);
  });

  it("returns nothing to await", () => {
    expect(travelTo(MOMENT)).toBeUndefined();
  });

  it("takes a timestamp as well as a date", () => {
    travelTo(MOMENT.getTime());

    expect(currentTime().toISOString()).toBe(MOMENT.toISOString());
  });
});

describe("giving the clock back", () => {
  /**
   * An `afterEach` does not know how many times the test travelled, so
   * unwinding one level would leave a test that travelled twice holding a
   * clock the next file inherits.
   */
  it("undoes every travel, not one level", () => {
    travelTo(MOMENT);
    travelTo(new Date("2030-01-01T00:00:00.000Z"));

    travelBack();

    expect(isTimeFrozen()).toBe(false);
  });

  /** A teardown guarded by a question is one that gets the question wrong once. */
  it("does nothing when nothing travelled", () => {
    expect(isTimeFrozen()).toBe(false);

    travelBack();

    expect(isTimeFrozen()).toBe(false);
  });
});

describe("the block form still puts the clock back itself", () => {
  it("restores when the block ends", async () => {
    await travelTo(MOMENT, () => expect(isTimeFrozen()).toBe(true));

    expect(isTimeFrozen()).toBe(false);
  });

  it("restores when the block throws", async () => {
    await expect(
      travelTo(MOMENT, () => {
        throw new Error("no");
      }),
    ).rejects.toThrow("no");

    expect(isTimeFrozen()).toBe(false);
  });

  /** Restored to what was held before, not to the real clock. */
  it("restores to an unblocked travel it was nested inside", async () => {
    travelTo(MOMENT);

    await travelTo(new Date("2030-01-01T00:00:00.000Z"), () => undefined);

    expect(isTimeFrozen()).toBe(true);
    expect(currentTime().toISOString()).toBe(MOMENT.toISOString());
  });

  it("hands back what the block returned", async () => {
    expect(await freezeTime(() => 7)).toBe(7);
  });
});
