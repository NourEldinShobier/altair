/**
 * Keeping a pool healthy over days, ported from
 * `activerecord/test/cases/connection_pool_test.rb`,
 * `activerecord/test/cases/reaper_test.rb` and
 * `activerecord/test/cases/advisory_lock_base_test.rb`.
 *
 * Every failure here appears only after uptime: a connection the database
 * closed while nobody held it, a request that leaked one by throwing, two
 * deploys migrating at once. So the tests are mostly about the paths taken when
 * something has already gone wrong.
 */

import { describe, expect, it } from "bun:test";
import {
  AdvisoryLockUnavailable,
  AdvisoryLocks,
  AlreadyLeased,
  ConnectionLeases,
  type ManagedConnection,
  advisoryLockId,
  allowPreconnect,
  anyWaiting,
  connectionAge,
  flushable,
  mayRetry,
  needsReconnect,
  needsVerification,
  retireOldConnections,
  retryDelay,
  retryableError,
  secondsIdle,
  secondsSinceLastActivity,
  shouldRetire,
  throwAway,
  withTemporaryConnection,
} from "../src/pool_lifecycle.js";

const NOW = 1_000_000;

const conn = (overrides: Partial<ManagedConnection> = {}): ManagedConnection => ({
  createdAt: NOW,
  lastActivityAt: NOW,
  alive: true,
  ...overrides,
});

describe("how old a connection is", () => {
  it("measures age from when it opened", () => {
    expect(connectionAge(conn({ createdAt: NOW - 5000 }), NOW)).toBe(5000);
  });

  it("measures idleness from the last activity", () => {
    expect(secondsIdle(conn({ lastActivityAt: NOW - 3000 }), NOW)).toBe(3);
    expect(secondsSinceLastActivity(conn({ lastActivityAt: NOW - 3000 }), NOW)).toBe(3);
  });
});

describe("whether to check a connection before using it", () => {
  /**
   * A connection idle for a while may have been closed by a database restart,
   * a load balancer or a firewall, with nothing telling this process. Not
   * verifying costs the *next request* an error it did not cause.
   */
  it("verifies one idle past the window", () => {
    expect(
      needsVerification(conn({ lastActivityAt: NOW - 5000 }), { verifyTimeoutMs: 1000 }, NOW),
    ).toBe(true);
  });

  it("does not verify one just used", () => {
    expect(needsVerification(conn(), { verifyTimeoutMs: 1000 }, NOW)).toBe(false);
  });

  /** Verifying costs a round trip, so it is opt-in. */
  it("does not verify when no window is set", () => {
    expect(needsVerification(conn({ lastActivityAt: 0 }), {}, NOW)).toBe(false);
  });

  it("says when one is known dead", () => {
    expect(needsReconnect(conn({ alive: false }))).toBe(true);
    expect(needsReconnect(conn())).toBe(false);
  });
});

describe("retiring connections", () => {
  it("retires one that is dead", () => {
    expect(shouldRetire(conn({ alive: false }), {}, NOW)).toBe(true);
  });

  it("retires one past its age", () => {
    expect(shouldRetire(conn({ createdAt: NOW - 10_000 }), { maxAgeMs: 5000 }, NOW)).toBe(true);
  });

  it("retires one idle too long", () => {
    expect(shouldRetire(conn({ lastActivityAt: NOW - 10_000 }), { idleTimeoutMs: 5000 }, NOW)).toBe(
      true,
    );
  });

  /** Age and idleness catch different things, so neither alone is enough. */
  it("keeps a busy young one", () => {
    expect(shouldRetire(conn(), { maxAgeMs: 5000, idleTimeoutMs: 5000 }, NOW)).toBe(false);
  });

  /**
   * Closing a connection under its holder turns a slow query into a lost one,
   * which is worse than the leak retiring prevents.
   */
  it("never retires one somebody is holding", () => {
    expect(
      shouldRetire(conn({ owner: "req-1", createdAt: 0, lastActivityAt: 0 }), { maxAgeMs: 1 }, NOW),
    ).toBe(false);
  });

  it("retires a dead one even when held", () => {
    expect(shouldRetire(conn({ owner: "req-1", alive: false }), {}, NOW)).toBe(true);
  });

  it("keeps everything when no policy is set", () => {
    expect(shouldRetire(conn({ createdAt: 0, lastActivityAt: 0 }), {}, NOW)).toBe(false);
  });

  it("splits a set into what goes and what stays", () => {
    const { retire, keep } = retireOldConnections(
      [conn({ alive: false }), conn()],
      { maxAgeMs: 5000 },
      NOW,
    );

    expect(retire).toHaveLength(1);
    expect(keep).toHaveLength(1);
  });
});

describe("who holds what", () => {
  it("records a lease", () => {
    const leases = new ConnectionLeases();
    const connection = conn();

    leases.lease("req-1", connection, NOW);

    expect(leases.activeConnection("req-1")).toBe(connection);
    expect(connection.owner).toBe("req-1");
  });

  it("knows nobody holds one to start with", () => {
    expect(new ConnectionLeases().activeConnection("req-1")).toBeUndefined();
  });

  /**
   * Nothing would ever return the first, so the pool shrinks by one for the
   * life of the process.
   */
  it("refuses a second lease under one owner", () => {
    const leases = new ConnectionLeases();
    leases.lease("req-1", conn(), NOW);

    expect(() => leases.lease("req-1", conn(), NOW)).toThrow(AlreadyLeased);
  });

  it("allows re-leasing the same connection", () => {
    const leases = new ConnectionLeases();
    const connection = conn();
    leases.lease("req-1", connection, NOW);

    expect(() => leases.lease("req-1", connection, NOW)).not.toThrow();
  });

  it("releases one", () => {
    const leases = new ConnectionLeases();
    const connection = conn();
    leases.lease("req-1", connection, NOW);

    leases.releaseConnection("req-1", NOW);

    expect(leases.activeConnection("req-1")).toBeUndefined();
    expect(connection.owner).toBeUndefined();
  });

  it("releases nothing when nothing is held", () => {
    expect(new ConnectionLeases().releaseConnection("req-1")).toBeUndefined();
  });

  /**
   * The sweep a web server runs between requests. A request that threw between
   * checkout and checkin leaked one, and without this the pool is empty hours
   * later with nothing to point at.
   */
  it("sweeps every leaked lease", () => {
    const leases = new ConnectionLeases();
    leases.lease("req-1", conn(), NOW);
    leases.lease("req-2", conn(), NOW);

    expect(leases.clearActiveConnections(NOW)).toHaveLength(2);
    expect(leases.size).toBe(0);
  });

  it("lists who holds one", () => {
    const leases = new ConnectionLeases();
    leases.lease("req-1", conn(), NOW);

    expect(leases.activeConnections()).toHaveLength(1);
  });

  it("takes one back from an owner that is gone", () => {
    const leases = new ConnectionLeases();
    const connection = conn();
    leases.lease("req-1", connection, NOW);

    expect(leases.steal("req-1", NOW)).toBe(connection);
    expect(leases.size).toBe(0);
  });
});

describe("running with a connection", () => {
  it("hands the body a connection", async () => {
    const leases = new ConnectionLeases();
    const connection = conn();

    expect(await withTemporaryConnection(leases, "req-1", connection, async (c) => c)).toBe(
      connection,
    );
  });

  it("returns it afterwards", async () => {
    const leases = new ConnectionLeases();
    await withTemporaryConnection(leases, "req-1", conn(), async () => undefined);

    expect(leases.size).toBe(0);
  });

  /** Every leak this file cleans up after is a caller that threw. */
  it("returns it when the body throws", async () => {
    const leases = new ConnectionLeases();

    await expect(
      withTemporaryConnection(leases, "req-1", conn(), async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(leases.size).toBe(0);
  });

  /**
   * Reentrant, so a transaction opened outside the body is still the one the
   * body runs in.
   */
  it("hands back the one already held", async () => {
    const leases = new ConnectionLeases();
    const outer = conn();
    leases.lease("req-1", outer, NOW);

    expect(await withTemporaryConnection(leases, "req-1", conn(), async (c) => c)).toBe(outer);
  });

  it("does not release one it did not take", async () => {
    const leases = new ConnectionLeases();
    leases.lease("req-1", conn(), NOW);

    await withTemporaryConnection(leases, "req-1", conn(), async () => undefined);

    expect(leases.size).toBe(1);
  });
});

describe("retrying a connect", () => {
  it("backs off further each attempt", () => {
    const policy = { attempts: 5, baseDelayMs: 100, maxJitter: 0 };

    expect(retryDelay(1, policy, () => 0)).toBe(100);
    expect(retryDelay(2, policy, () => 0)).toBe(200);
    expect(retryDelay(3, policy, () => 0)).toBe(400);
  });

  /**
   * A database restart drops every connection in every process at once.
   * Without jitter they all retry at once, and the first thing the database
   * sees on coming back is the herd that would knock it over again.
   */
  it("jitters the delay", () => {
    const policy = { attempts: 5, baseDelayMs: 100, maxJitter: 0.5 };

    expect(retryDelay(1, policy, () => 1)).toBe(150);
    expect(retryDelay(1, policy, () => 0)).toBe(100);
  });

  it("stops after the attempts run out", () => {
    expect(mayRetry(2, { attempts: 3 }, 0)).toBe(true);
    expect(mayRetry(3, { attempts: 3 }, 0)).toBe(false);
  });

  /** A deadline bounds the total wait however many attempts remain. */
  it("stops at the deadline", () => {
    expect(mayRetry(1, { attempts: 10, deadlineMs: 5000 }, 6000)).toBe(false);
    expect(mayRetry(1, { attempts: 10, deadlineMs: 5000 }, 1000)).toBe(true);
  });

  it("retries a connection failure", () => {
    expect(retryableError(new Error("connect ECONNREFUSED 127.0.0.1:5432"))).toBe(true);
    expect(retryableError(new Error("Lost connection to MySQL server"))).toBe(true);
  });

  /**
   * A statement that reached the server may have applied. Retrying it is how
   * one duplicate-key error becomes two rows.
   */
  it("does not retry anything else", () => {
    expect(retryableError(new Error("duplicate key value violates unique constraint"))).toBe(false);
    expect(retryableError(new Error("syntax error at or near"))).toBe(false);
  });
});

describe("advisory locks", () => {
  it("takes one", () => {
    expect(new AdvisoryLocks().getAdvisoryLock("migrations")).toBe(true);
  });

  /** What stops two of three deploying processes running the same ALTER TABLE. */
  it("refuses one already held", () => {
    const locks = new AdvisoryLocks();
    locks.getAdvisoryLock("migrations");

    expect(locks.getAdvisoryLock("migrations")).toBe(false);
  });

  it("allows a different name", () => {
    const locks = new AdvisoryLocks();
    locks.getAdvisoryLock("migrations");

    expect(locks.getAdvisoryLock("seeds")).toBe(true);
  });

  it("releases one", () => {
    const locks = new AdvisoryLocks();
    locks.getAdvisoryLock("migrations");

    expect(locks.releaseAdvisoryLock("migrations")).toBe(true);
    expect(locks.getAdvisoryLock("migrations")).toBe(true);
  });

  it("reports releasing one it never had", () => {
    expect(new AdvisoryLocks().releaseAdvisoryLock("migrations")).toBe(false);
  });

  it("runs a body under one", async () => {
    const locks = new AdvisoryLocks();
    let ran = false;

    await locks.withAdvisoryLock("migrations", async () => {
      ran = locks.holds("migrations");
    });

    expect(ran).toBe(true);
  });

  /**
   * A migration that throws while holding it and does not release blocks every
   * later deploy until someone finds the session and kills it by hand.
   */
  it("releases it when the body throws", async () => {
    const locks = new AdvisoryLocks();

    await expect(
      locks.withAdvisoryLock("migrations", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(locks.holds("migrations")).toBe(false);
  });

  it("refuses to run when it cannot take the lock", async () => {
    const locks = new AdvisoryLocks();
    locks.getAdvisoryLock("migrations");

    await expect(locks.withAdvisoryLock("migrations", async () => undefined)).rejects.toThrow(
      AdvisoryLockUnavailable,
    );
  });

  /**
   * Postgres takes integers. The hash has to be the same in every process, or
   * two deploys take two different locks and both proceed.
   */
  it("hashes a name the same way every time", () => {
    expect(advisoryLockId("migrations")).toBe(advisoryLockId("migrations"));
  });

  it("gives different names different ids", () => {
    expect(advisoryLockId("migrations")).not.toBe(advisoryLockId("seeds"));
  });

  it("stays positive", () => {
    for (const name of ["migrations", "seeds", "a", "zzzzzzzzzzzzzzzz"]) {
      expect(advisoryLockId(name)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("what the pool reports", () => {
  it("says whether anyone is queued", () => {
    expect(anyWaiting(0)).toBe(false);
    expect(anyWaiting(3)).toBe(true);
  });

  /**
   * Connections opened before a fork are shared file descriptors after it, and
   * two processes writing one socket corrupt each other's results.
   */
  it("does not preconnect before a fork", () => {
    expect(allowPreconnect(true, false)).toBe(false);
    expect(allowPreconnect(true, true)).toBe(true);
    expect(allowPreconnect(false, false)).toBe(true);
  });

  it("flushes idle connections", () => {
    const idle = [conn({ lastActivityAt: NOW - 100 }), conn({ lastActivityAt: NOW - 200 })];

    expect(flushable(idle, { max: 5 })).toHaveLength(2);
  });

  it("leaves held ones alone", () => {
    const connections = [conn({ owner: "req-1" }), conn()];

    expect(flushable(connections, { max: 5 })).toHaveLength(1);
  });

  it("keeps the minimum", () => {
    const idle = [conn({ lastActivityAt: NOW - 100 }), conn({ lastActivityAt: NOW - 200 })];

    expect(flushable(idle, { max: 5, min: 1 })).toHaveLength(1);
  });

  /** What survives a flush should be the set most recently proven to work. */
  it("flushes the oldest first", () => {
    const oldest = conn({ lastActivityAt: NOW - 900 });
    const newest = conn({ lastActivityAt: NOW - 100 });

    expect(flushable([newest, oldest], { max: 5, min: 1 })).toEqual([oldest]);
  });

  it("marks a connection as unusable", () => {
    const thrown = throwAway(conn({ owner: "req-1" }));

    expect(thrown.alive).toBe(false);
    expect(thrown.owner).toBeUndefined();
  });
});
