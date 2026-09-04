/**
 * Getting a connection and giving it back, ported from
 * `activerecord/test/cases/connection_pool_test.rb` and the version-gated
 * capability cases in `activerecord/test/cases/adapters/*`.
 *
 * The cases worth having are the ones where the wrong answer is silent: a
 * pinned connection returned early, a capability assumed from the adapter
 * name, a version compared as a string.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  PoolExhausted,
  atLeast,
  clearAllConnections,
  clearReloadableConnections,
  clientMinMessages,
  connectionRetries,
  getDatabaseVersion,
  leaseConnection,
  maxConnections,
  minConnections,
  newLeaseBook,
  permanentLease,
  pinConnection,
  preconnect,
  releaseConnection,
  resetDatabaseVersions,
  retrieveConnection,
  serverVersion,
  supportSha1ForNonDeterministicEncryption,
  supportsClosePrepared,
  supportsConcurrentConnections,
  supportsDisablingIndexes,
  supportsEnforcedForeignKeys,
  supportsInsertOnDuplicateSkip,
  supportsInsertOnDuplicateUpdate,
  supportsInsertReturning,
  supportsPartitionedIndexes,
  translateConnectError,
  typeAliasesForVersion,
  unpinConnection,
} from "../src/connection-leasing.js";

afterEach(() => {
  resetDatabaseVersions();
});

describe("reading a server version", () => {
  it("reads the three parts", () => {
    expect(serverVersion("3.35.5")).toEqual({ major: 3, minor: 35, patch: 5 });
    expect(serverVersion("PostgreSQL 14.2 on x86_64")).toEqual({ major: 14, minor: 2, patch: 0 });
  });

  it("refuses something with no version in it", () => {
    expect(() => serverVersion("unknown")).toThrow("nobody checked");
  });

  /** A missing part is zero, not a repeat of the one before it. */
  it("reads a version with parts missing", () => {
    expect(serverVersion("8")).toEqual({ major: 8, minor: 0, patch: 0 });
    expect(serverVersion("8.4")).toEqual({ major: 8, minor: 4, patch: 0 });
  });

  /**
   * `"3.9"` sorts after `"3.35"` lexically, so a string comparison decides
   * that SQLite 3.35 is older than 3.9 — turning off exactly the features 3.35
   * added.
   */
  it("compares numerically, not lexically", () => {
    expect(atLeast(serverVersion("3.35.0"), 3, 9)).toBe(true);
    expect(atLeast(serverVersion("3.9.0"), 3, 35)).toBe(false);
  });

  it("compares each part in turn", () => {
    expect(atLeast(serverVersion("14.0.0"), 13, 99)).toBe(true);
    expect(atLeast(serverVersion("3.35.5"), 3, 35, 5)).toBe(true);
    expect(atLeast(serverVersion("3.35.4"), 3, 35, 5)).toBe(false);
  });

  /**
   * The version is a round trip, and asking on every statement that wants a
   * capability check would double the query count of anything that inserts.
   */
  it("asks once per pool", () => {
    let asks = 0;
    const ask = () => {
      asks += 1;

      return "14.2";
    };

    getDatabaseVersion("primary", ask);
    getDatabaseVersion("primary", ask);

    expect(asks).toBe(1);
  });

  it("asks separately for a different pool", () => {
    getDatabaseVersion("primary", () => "14.2");

    expect(getDatabaseVersion("animals", () => "13.1").major).toBe(13);
  });
});

describe("what a server can do", () => {
  /**
   * Postgres always, SQLite from 3.35, MySQL never — so trusting the adapter
   * name alone gets a syntax error from whichever server was not upgraded.
   */
  it("gates RETURNING on the SQLite version", () => {
    expect(supportsInsertReturning({ adapter: "postgres" })).toBe(true);
    // With a version too: MySQL has no RETURNING at any version, so a check
    // that only asks "is the version new enough" would say yes for MySQL 8.
    expect(supportsInsertReturning({ adapter: "mysql" })).toBe(false);
    expect(supportsInsertReturning({ adapter: "mysql", version: serverVersion("8.4") })).toBe(
      false,
    );
    expect(supportsInsertReturning({ adapter: "sqlite", version: serverVersion("3.35.0") })).toBe(
      true,
    );
    expect(supportsInsertReturning({ adapter: "sqlite", version: serverVersion("3.34.0") })).toBe(
      false,
    );
  });

  /**
   * Refusing a feature the server has costs a slower path; using one it lacks
   * costs an error in production.
   */
  it("says no when the version is unknown", () => {
    expect(supportsInsertReturning({ adapter: "sqlite" })).toBe(false);
    expect(supportsPartitionedIndexes({ adapter: "postgres" })).toBe(false);
    expect(supportsDisablingIndexes({ adapter: "mysql" })).toBe(false);
  });

  it("gates upsert on each server's version", () => {
    expect(supportsInsertOnDuplicateSkip({ adapter: "mysql" })).toBe(true);
    expect(
      supportsInsertOnDuplicateSkip({ adapter: "postgres", version: serverVersion("9.5") }),
    ).toBe(true);
    expect(
      supportsInsertOnDuplicateSkip({ adapter: "postgres", version: serverVersion("9.4") }),
    ).toBe(false);
    expect(supportsInsertOnDuplicateUpdate({ adapter: "mysql" })).toBe(true);
  });

  it("gates partitioned indexes on Postgres 11", () => {
    expect(
      supportsPartitionedIndexes({ adapter: "postgres", version: serverVersion("11.0") }),
    ).toBe(true);
    expect(supportsPartitionedIndexes({ adapter: "mysql", version: serverVersion("11.0") })).toBe(
      false,
    );
  });

  /**
   * A bulk load that "disabled" indexes by dropping them leaves the table
   * without them if it fails partway — slower forever rather than slower once.
   */
  it("gates disabling indexes on MySQL 8", () => {
    expect(supportsDisablingIndexes({ adapter: "mysql", version: serverVersion("8.0") })).toBe(
      true,
    );
    expect(supportsDisablingIndexes({ adapter: "mysql", version: serverVersion("5.7") })).toBe(
      false,
    );
  });

  /**
   * SQLite has foreign keys and does not enforce them unless asked, so a
   * fixture load assuming enforcement gets no error and a table full of rows
   * pointing at nothing.
   */
  it("knows SQLite does not enforce foreign keys by default", () => {
    expect(supportsEnforcedForeignKeys({ adapter: "sqlite" })).toBe(false);
    expect(supportsEnforcedForeignKeys({ adapter: "postgres" })).toBe(true);
  });

  it("knows SQLite serialises writers", () => {
    expect(supportsConcurrentConnections({ adapter: "sqlite" })).toBe(false);
    expect(supportsConcurrentConnections({ adapter: "mysql" })).toBe(true);
  });

  it("knows which server can close one prepared statement", () => {
    expect(supportsClosePrepared({ adapter: "postgres" })).toBe(true);
    expect(supportsClosePrepared({ adapter: "mysql" })).toBe(false);
  });

  /**
   * A compatibility switch rather than a choice: turning it on for new records
   * would mean writing with a digest nobody would choose today.
   */
  it("keeps the legacy digest off unless asked", () => {
    expect(supportSha1ForNonDeterministicEncryption()).toBe(false);
    expect(supportSha1ForNonDeterministicEncryption(true)).toBe(true);
  });

  /**
   * Postgres emits a notice for every implicitly created index and sequence,
   * so a migration creating twenty tables produces sixty lines nobody reads —
   * which is how the one that mattered gets missed.
   */
  it("keeps Postgres quiet by default", () => {
    expect(clientMinMessages()).toBe("warning");
    expect(clientMinMessages("notice")).toBe("notice");
  });

  it("notes a type an older server needs an extension for", () => {
    expect(typeAliasesForVersion({ adapter: "postgres", version: serverVersion("12.0") })).toEqual({
      uuid: expect.stringContaining("pgcrypto"),
    });
    expect(typeAliasesForVersion({ adapter: "postgres", version: serverVersion("13.0") })).toEqual(
      {},
    );
  });
});

describe("leasing a connection", () => {
  it("keeps one per owner", () => {
    const book = newLeaseBook();
    const first = leaseConnection(book, "task-1", () => ({}));

    expect(leaseConnection(book, "task-1", () => ({}))).toBe(first);
    expect(retrieveConnection(book, "task-1")).toBe(first);
  });

  it("finds nothing for an owner that has none", () => {
    expect(retrieveConnection(newLeaseBook(), "task-1")).toBeUndefined();
  });

  /**
   * "Could not obtain a connection" on its own sends people to raise the pool
   * size, which hides the actual cause — something holding one across an await
   * it did not need to.
   */
  it("names the holders when the pool is empty", () => {
    const book = newLeaseBook({ max: 1 });
    leaseConnection(book, "task-1", () => ({}));

    expect(() => leaseConnection(book, "task-2", () => ({}))).toThrow(PoolExhausted);
    expect(() => leaseConnection(book, "task-2", () => ({}))).toThrow("task-1");
  });

  /** The two are usually set in different places, and one gets quietly ignored. */
  it("refuses a minimum above the maximum", () => {
    expect(() => newLeaseBook({ min: 5, max: 2 })).toThrow("quietly ignores");
  });

  it("reports its bounds", () => {
    const book = newLeaseBook({ min: 1, max: 4 });

    expect(minConnections(book)).toBe(1);
    expect(maxConnections(book)).toBe(4);
  });

  /**
   * Otherwise the first requests after a deploy each pay for a handshake, at
   * the moment a service is least able to afford it.
   */
  it("opens the minimum before serving", () => {
    const book = newLeaseBook({ min: 2, max: 4 });

    expect(preconnect(book, () => ({}))).toBe(2);
    expect(preconnect(book, () => ({}))).toBe(0);
  });
});

describe("a pinned connection", () => {
  /**
   * A pinned connection returned early is how a test's rollback unwinds a
   * transaction another test is inside.
   */
  it("is not released", () => {
    const book = newLeaseBook();
    leaseConnection(book, "test", () => ({}));
    pinConnection(book, "test");

    expect(releaseConnection(book, "test")).toBe(false);
    expect(retrieveConnection(book, "test")).toBeDefined();
  });

  it("is released once unpinned", () => {
    const book = newLeaseBook();
    leaseConnection(book, "test", () => ({}));
    pinConnection(book, "test");

    expect(unpinConnection(book, "test")).toBe(true);
    expect(releaseConnection(book, "test")).toBe(true);
  });

  it("says it is permanent while pinned", () => {
    const book = newLeaseBook();
    const lease = leaseConnection(book, "test", () => ({}));

    expect(permanentLease(lease)).toBe(false);

    pinConnection(book, "test");

    expect(permanentLease(lease)).toBe(true);
  });

  /**
   * Pinning creates the expectation that a *specific* connection is kept, and
   * creating a new one here would satisfy the call and not the expectation.
   */
  it("refuses to pin what is not held", () => {
    expect(() => pinConnection(newLeaseBook(), "nobody")).toThrow("none to pin");
  });

  it("reports an unpin of something that was not pinned", () => {
    const book = newLeaseBook();
    leaseConnection(book, "test", () => ({}));

    expect(unpinConnection(book, "test")).toBe(false);
    expect(unpinConnection(book, "absent")).toBe(false);
  });

  /**
   * Clearing runs on reload and at the end of a test run, and taking a pinned
   * connection would unwind a transaction its owner still believes it is
   * inside — which surfaces as data appearing in a later test.
   */
  it("survives a clear", () => {
    const book = newLeaseBook();
    leaseConnection(book, "test", () => ({}));
    leaseConnection(book, "request", () => ({}));
    pinConnection(book, "test");

    expect(clearAllConnections(book)).toEqual({ released: ["request"], kept: ["test"] });
    expect(retrieveConnection(book, "test")).toBeDefined();
  });

  it("survives a reload clear too", () => {
    const book = newLeaseBook();
    leaseConnection(book, "test", () => ({}));
    pinConnection(book, "test");

    expect(clearReloadableConnections(book).kept).toEqual(["test"]);
  });

  /**
   * A caller assuming it released would reuse the connection for something
   * else while a test still holds a transaction open on it.
   */
  it("reports whether it actually released", () => {
    const book = newLeaseBook();
    leaseConnection(book, "request", () => ({}));

    expect(releaseConnection(book, "request")).toBe(true);
    expect(releaseConnection(book, "request")).toBe(false);
  });
});

describe("a connection that failed", () => {
  /**
   * The driver's message is the only information there is — a bad password, a
   * wrong host and a server that is not running need three different
   * responses.
   */
  it("keeps what the driver said", () => {
    const translated = translateConnectError(new Error("password authentication failed"), {
      host: "db.internal",
      database: "app",
    });

    expect(translated.message).toContain("password authentication failed");
    expect(translated.message).toContain("db.internal/app");
    expect(translated.name).toBe("ConnectionNotEstablished");
  });

  it("keeps the original as the cause", () => {
    const original = new Error("nope");

    expect(translateConnectError(original, {}).cause).toBe(original);
  });

  /**
   * A connection failure is usually a restart or a blip, both of which resolve
   * in seconds — retrying many times turns one restart into a request that
   * hangs for a minute and then fails anyway.
   */
  it("retries a small bounded number of times", () => {
    expect(connectionRetries()).toBe(1);
    expect(connectionRetries(2)).toBe(2);
    expect(connectionRetries(50)).toBe(3);
    expect(connectionRetries(0)).toBe(0);
  });

  it("refuses a negative count", () => {
    expect(() => connectionRetries(-1)).toThrow("typo");
  });
});
