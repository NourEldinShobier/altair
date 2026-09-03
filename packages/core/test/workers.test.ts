/**
 * `server.workers`, ported from Puma's `WEB_CONCURRENCY` as Rails uses it in
 * `config/puma.rb`, and from `cluster.fork` in Node's own cluster tests.
 *
 * Bun runs JavaScript on one thread, so one `Bun.serve` uses one core however
 * many the machine has — the same ceiling Ruby's GVL puts on a Rails process.
 * A benchmark on this port measured it: one Altair process reached parity with
 * four Rails workers and lost to them on every association-heavy page, while
 * using a quarter of the cores.
 *
 * `node:cluster` rather than `Bun.serve`'s `reusePort`. `reusePort` is a
 * Linux-only socket option that Windows and macOS silently *ignore* — the same
 * code would run four unbalanced servers on a developer's machine and behave
 * differently in production, which is the worst property a concurrency setting
 * can have. Cluster's primary accepts and hands the descriptor to a worker.
 *
 * The count is unit-tested here; the fan-out is driven end to end from a real
 * forked supervisor in `workers_cluster.test.ts`, which needs a spawned
 * process and does not belong in the same file as the pure functions.
 */

import { describe, expect, it } from "bun:test";
import { workerCount } from "../src/application.js";
import { workersFrom } from "../src/config.js";

describe("what WEB_CONCURRENCY asks for", () => {
  it("is one when it is not set", () => {
    expect(workersFrom(undefined)).toBe(1);
    expect(workersFrom("")).toBe(1);
    expect(workersFrom("   ")).toBe(1);
  });

  it("is the number when it is a number", () => {
    expect(workersFrom("4")).toBe(4);
    expect(workersFrom("1")).toBe(1);
  });

  it("is every core when it is auto", () => {
    expect(workersFrom("auto")).toBe("auto");
  });

  /**
   * A variable set to something meaningless is more likely a typo than a
   * request to fan out, and starting eight processes because of one is worse
   * than starting one.
   */
  it("is one when it is nonsense, rather than a guess", () => {
    expect(workersFrom("lots")).toBe(1);
    expect(workersFrom("0")).toBe(1);
    expect(workersFrom("-2")).toBe(1);
    expect(workersFrom("2.5")).toBe(1);
  });
});

describe("how many workers that becomes", () => {
  it("is one when nothing was configured", () => {
    expect(workerCount(undefined)).toBe(1);
  });

  it("is the count it was given", () => {
    expect(workerCount(4)).toBe(4);
  });

  /**
   * `availableParallelism` reports the cores a cgroup allows, so a four-core
   * container does not start thirty-two workers that preempt each other.
   */
  it("is at least one for auto, and no more than the cores allow", () => {
    const auto = workerCount("auto");

    expect(auto).toBeGreaterThanOrEqual(1);
    expect(auto).toBeLessThanOrEqual(navigator.hardwareConcurrency);
  });

  it("never goes below one", () => {
    expect(workerCount(0)).toBe(1);
    expect(workerCount(-3)).toBe(1);
  });
});
