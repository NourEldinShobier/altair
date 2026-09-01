/**
 * Optimistic locking, timestamps and `inspect`, ported from
 * `activerecord/test/cases/locking_test.rb`,
 * `activerecord/test/cases/timestamp_test.rb` and the filtering cases in
 * `activerecord/test/cases/core_test.rb`.
 *
 * Each of these is a place where the obvious implementation is silently wrong,
 * so the tests are mostly about the exceptions rather than the mechanism.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { StaleObjectError } from "../src/model.js";
import {
  CREATE_TIMESTAMPS,
  DEFAULT_LOCKING_COLUMN,
  allTimestampAttributesInModel,
  checkLockedUpdate,
  createTimestamps,
  currentLockingColumn,
  extractAttributes,
  filterAttributes,
  initializeAttributes,
  inspectWithAttributes,
  inspectionFilter,
  lockOptions,
  lockThread,
  lockWait,
  lockingCondition,
  nextLockVersion,
  onSensitiveAttributeDeclared,
  preserveLockVersionOnTouch,
  preservingLockVersionOnTouch,
  readonlyAttribute,
  resetFilterAttributes,
  resetLockingColumn,
  resetSensitiveAttributes,
  sensitiveAttributeWasDeclared,
  setLockingColumn,
  setPreserveLockVersionOnTouch,
  timestampAttributesForCreateInModel,
  timestampAttributesForUpdateInModel,
  timestampColumnNames,
  updateTimestamps,
} from "../src/locking_and_timestamps.js";

afterEach(() => {
  resetLockingColumn();
  resetFilterAttributes();
  resetSensitiveAttributes();
  setPreserveLockVersionOnTouch(false);
});

describe("optimistic locking", () => {
  it("uses lock_version unless told otherwise", () => {
    expect(currentLockingColumn()).toBe(DEFAULT_LOCKING_COLUMN);

    setLockingColumn("revision");

    expect(currentLockingColumn()).toBe("revision");
    expect(resetLockingColumn()).toBe(DEFAULT_LOCKING_COLUMN);
  });

  /**
   * The version the record was *loaded* with. The current value would match
   * the row the update is about to write and lock nothing — a lock that always
   * succeeds is worse than none, because it looks like one.
   */
  it("matches on the loaded version", () => {
    expect(lockingCondition(3)).toEqual({ lock_version: 3 });
  });

  it("uses the configured column", () => {
    setLockingColumn("revision");

    expect(lockingCondition(3)).toEqual({ revision: 3 });
  });

  /**
   * Rows written before the column was added have a null there, and those are
   * exactly the rows most likely to be edited concurrently.
   */
  it("treats a null version as zero", () => {
    expect(nextLockVersion(null)).toBe(1);
    expect(nextLockVersion(undefined)).toBe(1);
    expect(nextLockVersion(0)).toBe(1);
    expect(nextLockVersion(7)).toBe(8);
  });

  /**
   * Zero rows and "not found" need opposite responses: reload and retry versus
   * stop, so they are reported differently.
   */
  it("reports zero rows as staleness", () => {
    expect(() => checkLockedUpdate(0, "Post", 1)).toThrow(StaleObjectError);
    expect(() => checkLockedUpdate(0, "Post", 1)).toThrow("not a missing record");
  });

  it("says nothing when a row was updated", () => {
    expect(() => checkLockedUpdate(1, "Post", 1)).not.toThrow();
  });

  it("names the action", () => {
    expect(() => checkLockedUpdate(0, "Post", 1, "destroy")).toThrow("destroy a stale Post");
  });
});

describe("touching a locked record", () => {
  /**
   * A touch writes a timestamp and nothing else, so bumping the version makes
   * every concurrent editor's save fail for a reason unrelated to what they
   * changed — a counter cache touching a parent while somebody edits it.
   */
  it("is off by default", () => {
    expect(preserveLockVersionOnTouch()).toBe(false);
  });

  it("holds for the length of a block", async () => {
    await preservingLockVersionOnTouch(() => {
      expect(preserveLockVersionOnTouch()).toBe(true);
    });

    expect(preserveLockVersionOnTouch()).toBe(false);
  });

  /**
   * Left on, every later save in the process becomes one that cannot detect a
   * conflict.
   */
  it("is restored when the block throws", async () => {
    await expect(
      preservingLockVersionOnTouch(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(preserveLockVersionOnTouch()).toBe(false);
  });

  it("restores an outer block rather than clearing", async () => {
    setPreserveLockVersionOnTouch(true);

    await preservingLockVersionOnTouch(() => undefined);

    expect(preserveLockVersionOnTouch()).toBe(true);
  });
});

describe("pessimistic locking", () => {
  it("writes the clause", () => {
    expect(lockOptions()).toBe("FOR UPDATE");
    expect(lockOptions({ mode: "share" })).toBe("FOR SHARE");
    expect(lockOptions({ mode: "no key update" })).toBe("FOR NO KEY UPDATE");
  });

  it("refuses to wait when asked", () => {
    expect(lockOptions({ noWait: true })).toBe("FOR UPDATE NOWAIT");
  });

  it("skips taken rows when asked", () => {
    expect(lockOptions({ skipLocked: true })).toBe("FOR UPDATE SKIP LOCKED");
  });

  /**
   * NOWAIT fails when a row is taken and SKIP LOCKED silently omits it — they
   * are opposite answers to the same question, so a caller asking for both has
   * a bug that would otherwise be decided by whichever check ran first.
   */
  it("refuses both at once", () => {
    expect(() => lockOptions({ noWait: true, skipLocked: true })).toThrow("opposite answers");
  });

  /**
   * An unbounded wait is how one long transaction becomes every request
   * queueing behind it, and the symptom is a service that stops responding
   * with nothing in a log.
   */
  it("has a bounded default", () => {
    expect(lockWait(undefined)).toBe(5);
    expect(lockWait(undefined, 30)).toBe(30);
    expect(lockWait(2)).toBe(2);
  });

  /** So a reader can tell a deliberate no-wait from a timeout somebody forgot. */
  it("refuses a wait of zero", () => {
    expect(() => lockWait(0)).toThrow("NOWAIT");
    expect(() => lockWait(-1)).toThrow("NOWAIT");
  });

  it("sets the timeout per adapter", () => {
    expect(lockThread(2)).toBe("SET LOCAL lock_timeout = '2000ms'");
    expect(lockThread(2, "mysql")).toBe("SET innodb_lock_wait_timeout = 2");
  });

  it("rounds up rather than down to zero", () => {
    expect(lockThread(0.4, "mysql")).toContain("= 1");
  });
});

describe("timestamps", () => {
  const columns = ["id", "title", "created_at", "updated_at"];

  /**
   * Writing to a column that is not there is an error on every adapter, and a
   * model without timestamps is entirely ordinary.
   */
  it("uses only the columns the table has", () => {
    expect(timestampAttributesForCreateInModel(["id"])).toEqual([]);
    expect(timestampAttributesForCreateInModel(columns)).toEqual(["created_at"]);
    expect(timestampAttributesForUpdateInModel(columns)).toEqual(["updated_at"]);
  });

  it("knows the older spellings too", () => {
    expect(timestampAttributesForCreateInModel(["created_on"])).toEqual(["created_on"]);
    expect(timestampColumnNames()).toContain("updated_on");
    expect(CREATE_TIMESTAMPS).toContain("created_at");
  });

  it("lists both kinds", () => {
    expect(allTimestampAttributesInModel(columns)).toEqual(["created_at", "updated_at"]);
  });

  /**
   * Two columns written from two clock reads can differ by a millisecond, and
   * a record whose created_at is after its updated_at breaks every "changed
   * since creation" check written against it.
   */
  it("writes one value to both columns on create", () => {
    const at = new Date("2026-01-01T00:00:00Z");
    const written = createTimestamps(columns, at);

    expect(written["created_at"]).toBe(at);
    expect(written["updated_at"]).toBe(at);
  });

  /** `created_at` rewritten on update destroys the one fact nothing else records. */
  it("leaves created_at alone on update", () => {
    const written = updateTimestamps(columns, new Date());

    expect(written["created_at"]).toBeUndefined();
    expect(written["updated_at"]).toBeInstanceOf(Date);
  });

  it("writes nothing for a table with no timestamps", () => {
    expect(createTimestamps(["id"], new Date())).toEqual({});
  });
});

describe("what a record shows when printed", () => {
  /**
   * Printing a record is the most casual thing anybody does with one, which is
   * how a digest ends up in a log, an exception tracker, and a screenshot.
   */
  it("hides a secret", () => {
    expect(inspectWithAttributes("User", { email: "a@b.c", password_digest: "$2a$" })).toContain(
      "[FILTERED]",
    );
  });

  /**
   * Replaced rather than omitted: an omitted attribute reads as one the record
   * does not have, which sends somebody looking for a migration.
   */
  it("shows that the attribute exists", () => {
    expect(inspectWithAttributes("User", { password_digest: "x" })).toContain("password_digest:");
  });

  /** Substring, so `password_confirmation` is covered without naming it. */
  it("matches a substring", () => {
    expect(inspectionFilter("reset_password_token")).toBe(true);
    expect(inspectionFilter("password_confirmation")).toBe(true);
    expect(inspectionFilter("PASSWORD")).toBe(true);
    expect(inspectionFilter("email")).toBe(false);
  });

  it("takes a different list", () => {
    filterAttributes(["email"]);

    expect(inspectionFilter("email")).toBe(true);
    expect(inspectionFilter("password")).toBe(false);
  });

  it("shows ordinary values", () => {
    expect(inspectWithAttributes("Post", { id: 1, title: "Hi" })).toBe(
      '#<Post id: 1, title: "Hi">',
    );
  });

  /**
   * A truncated inspect that does not say so is read as the whole record, and
   * the attribute somebody is looking for is assumed missing.
   */
  it("says when it truncated", () => {
    const wide = Object.fromEntries(Array.from({ length: 15 }, (_, index) => [`c${index}`, index]));

    expect(inspectWithAttributes("Post", wide)).toContain("... 5 more");
  });

  it("does not say so when it did not", () => {
    expect(inspectWithAttributes("Post", { id: 1 })).not.toContain("more");
  });
});

describe("declaring an attribute sensitive", () => {
  /**
   * At declaration rather than at first use: adding it on first read means the
   * first `inspect` of the process prints it.
   */
  it("adds it to the filter list straight away", () => {
    expect(inspectionFilter("nickname")).toBe(false);

    onSensitiveAttributeDeclared("User", "nickname");

    expect(inspectionFilter("nickname")).toBe(true);
  });

  it("remembers which model declared it", () => {
    onSensitiveAttributeDeclared("User", "nickname");

    expect(sensitiveAttributeWasDeclared("User", "nickname")).toBe(true);
    expect(sensitiveAttributeWasDeclared("Post", "nickname")).toBe(false);
  });
});

describe("attributes an update does not send", () => {
  /**
   * Dropped rather than raising: raising makes every save on a record with one
   * fail, including saves that did not touch it — and the attribute is usually
   * one the database maintains.
   */
  it("drops a readonly attribute", () => {
    expect(extractAttributes({ title: "a", views: 3 }, ["views"])).toEqual({ title: "a" });
  });

  it("keeps everything when nothing is readonly", () => {
    expect(extractAttributes({ title: "a" })).toEqual({ title: "a" });
  });

  it("says which attributes are readonly", () => {
    expect(readonlyAttribute("views", ["views"])).toBe(true);
    expect(readonlyAttribute("title", ["views"])).toBe(false);
  });

  /**
   * An absent attribute and an explicitly null one read the same on the way
   * out and differently on the way in: the first is omitted from the insert so
   * the database default applies, and a model that set null explicitly would
   * find the default there instead.
   */
  it("gives a column with no default an explicit null", () => {
    expect(initializeAttributes([{ name: "title" }, { name: "views", default: 0 }])).toEqual({
      title: null,
      views: 0,
    });
  });
});
