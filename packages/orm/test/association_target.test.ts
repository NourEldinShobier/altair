/**
 * The loaded side of an association, ported from
 * `activerecord/test/cases/associations/inverse_associations_test.rb`,
 * `activerecord/test/cases/associations/has_many_associations_test.rb` and the
 * staleness cases in `activerecord/test/cases/associations_test.rb`.
 *
 * Both failures this guards against are silent: a stale target answers with
 * another parent's children and runs no query to find out, and a missing
 * inverse produces two objects for one row that overwrite each other.
 */

import { describe, expect, it } from "bun:test";
import {
  AssociationTarget,
  type TargetRecord,
  deriveJoinTableName,
  inverseUpdatesCounterInMemory,
  inversedFrom,
  nilTarget,
  removeInverseInstance,
  savedChangeToTarget,
  setInverseInstance,
  setInverseInstances,
  skipPreloading,
  sourceRecords,
  staleState,
  staleTarget,
  targetPreviouslyChanged,
} from "../src/association_target.js";

const comment = (id: number): TargetRecord => ({ id });

describe("what a target was loaded for", () => {
  it("is built from the keys the query used", () => {
    expect(staleState({ id: 7 }, ["id"])).toBe(staleState({ id: 7 }, ["id"]));
  });

  it("differs when a key differs", () => {
    expect(staleState({ id: 7 }, ["id"])).not.toBe(staleState({ id: 8 }, ["id"]));
  });

  /** Comparing whole records would reload on an edit the query never looked at. */
  it("ignores columns the query did not use", () => {
    expect(staleState({ id: 7, title: "a" }, ["id"])).toBe(
      staleState({ id: 7, title: "b" }, ["id"]),
    );
  });

  it("takes several keys", () => {
    expect(staleState({ account_id: 1, id: 7 }, ["account_id", "id"])).not.toBe(
      staleState({ account_id: 2, id: 7 }, ["account_id", "id"]),
    );
  });

  it("is nothing when a key has no value yet", () => {
    expect(staleState({}, ["id"])).toBeUndefined();
  });
});

describe("whether a loaded target is still right", () => {
  /** A first read would otherwise look like a reload. */
  it("is never stale before it loads", () => {
    expect(staleTarget(false, undefined, "x")).toBe(false);
  });

  it("is not stale while the key holds", () => {
    expect(staleTarget(true, "x", "x")).toBe(false);
  });

  /**
   * The failure this exists for: reassigning a record to another parent and
   * reading its children returns the old parent's, with no query and no error.
   */
  it("is stale once the key changes", () => {
    expect(staleTarget(true, "x", "y")).toBe(true);
  });
});

describe("holding a target", () => {
  it("has nothing before it loads", () => {
    const target = new AssociationTarget({ id: 7 });

    expect(target.loaded).toBe(false);
    expect(target.target).toEqual([]);
    expect(target.needsLoad()).toBe(true);
  });

  it("holds what it loaded", () => {
    const target = new AssociationTarget({ id: 7 });
    target.load([comment(1), comment(2)]);

    expect(target.size).toBe(2);
    expect(target.loaded).toBe(true);
    expect(target.needsLoad()).toBe(false);
  });

  it("needs loading again once the owner's key changes", () => {
    const owner: TargetRecord = { id: 7 };
    const target = new AssociationTarget(owner);
    target.load([comment(1)]);

    owner["id"] = 8;

    expect(target.stale()).toBe(true);
    expect(target.needsLoad()).toBe(true);
  });

  /**
   * A `build` before the load is not in the database, so a load cannot have
   * returned it — dropping it would silently discard the record the caller
   * made.
   */
  it("keeps records built before the load", () => {
    const target = new AssociationTarget({ id: 7 });
    const built = target.addToTarget(comment(99));
    target.load([comment(1)]);

    expect(target.target).toContain(built);
    expect(target.size).toBe(2);
  });

  it("says when something was added", () => {
    const target = new AssociationTarget({ id: 7 });

    expect(target.targetChanged()).toBe(false);
    target.addToTarget(comment(99));
    expect(target.targetChanged()).toBe(true);
  });

  it("lists what has not been saved", () => {
    const target = new AssociationTarget({ id: 7 });
    target.load([comment(1)]);
    target.addToTarget(comment(99));

    expect(target.pending.map((each) => each["id"])).toEqual([99]);
  });

  /**
   * Keeping the flag with an empty target is the bug: the association then
   * reports itself loaded with nothing in it, and every later read answers
   * "none" without querying.
   */
  it("drops the loaded flag when reset", () => {
    const target = new AssociationTarget({ id: 7 });
    target.load([comment(1)]);

    target.reset();

    expect(target.loaded).toBe(false);
    expect(target.target).toEqual([]);
    expect(target.needsLoad()).toBe(true);
  });

  it("drops built records on a full reset", () => {
    const target = new AssociationTarget({ id: 7 });
    target.addToTarget(comment(99));

    target.reset();

    expect(target.pending).toEqual([]);
  });

  it("keeps built records when only the scope is reset", () => {
    const target = new AssociationTarget({ id: 7 });
    target.load([comment(1)]);
    target.addToTarget(comment(99));

    target.resetScope();

    expect(target.pending).toHaveLength(1);
    expect(target.loaded).toBe(false);
  });

  it("replaces what the database returned on a reload", () => {
    const target = new AssociationTarget({ id: 7 });
    target.load([comment(1)]);

    target.reload([comment(2)]);

    expect(target.target.map((each) => each["id"])).toEqual([2]);
  });
});

describe("pointing a record back at its owner", () => {
  /**
   * Without it, `post.comments.first.post` is a second query returning a
   * different object for the same row — and writing through one leaves the
   * other holding attributes a later save can put back.
   */
  it("sets the inverse", () => {
    const owner = { id: 7 };
    const record = setInverseInstance(comment(1), owner, "post");

    expect(record["post"]).toBe(owner);
  });

  it("does nothing when there is no inverse to set", () => {
    const record = setInverseInstance(comment(1), { id: 7 }, undefined);

    expect(Object.keys(record)).toEqual(["id"]);
  });

  it("sets it across a whole load", () => {
    const owner = { id: 7 };
    const records = setInverseInstances([comment(1), comment(2)], owner, "post");

    expect(records.every((each) => each["post"] === owner)).toBe(true);
  });

  /** Left set, it points at a parent it no longer belongs to — and reads fine. */
  it("clears it when a record leaves", () => {
    const record = setInverseInstance(comment(1), { id: 7 }, "post");

    removeInverseInstance(record, "post");

    expect(record["post"]).toBeUndefined();
  });

  it("reports what the inverse currently holds", () => {
    const owner = { id: 7 };

    expect(inversedFrom(setInverseInstance(comment(1), owner, "post"), "post")).toBe(owner);
    expect(inversedFrom(comment(1), undefined)).toBeUndefined();
  });
});

describe("an association that is known to be nothing", () => {
  /** Querying would be a query guaranteed to return no rows, once per record. */
  it("says a null foreign key points at nothing", () => {
    expect(nilTarget({ author_id: null }, "author_id")).toBe(true);
    expect(nilTarget({}, "author_id")).toBe(true);
  });

  it("says a set one does not", () => {
    expect(nilTarget({ author_id: 7 }, "author_id")).toBe(false);
  });

  it("skips preloading it", () => {
    expect(skipPreloading({ author_id: null }, "author_id")).toBe(true);
    expect(skipPreloading({ author_id: 7 }, "author_id")).toBe(false);
  });
});

describe("what a through association reaches", () => {
  it("collects the source from each join record", () => {
    const tags = sourceRecords([{ tag: { id: 1 } }, { tag: { id: 2 } }], "tag");

    expect(tags.map((each) => each["id"])).toEqual([1, 2]);
  });

  /**
   * Two taggings pointing at one tag make `post.tags` return it twice, which
   * is right for a count of taggings and wrong for a list of tags.
   */
  it("does not return one record twice", () => {
    const tags = sourceRecords([{ tag: { id: 1 } }, { tag: { id: 1 } }], "tag");

    expect(tags).toHaveLength(1);
  });

  it("flattens a source that is itself a collection", () => {
    const tags = sourceRecords([{ tags: [{ id: 1 }, { id: 2 }] }], "tags");

    expect(tags).toHaveLength(2);
  });

  it("skips a join record whose source is missing", () => {
    expect(sourceRecords([{ tag: null }, { tag: { id: 1 } }], "tag")).toHaveLength(1);
  });

  /**
   * Alphabetical, so the name is the same whichever model declares it — two
   * models deriving different names is two tables where one was meant.
   */
  it("derives one join table name from either side", () => {
    expect(deriveJoinTableName("posts", "tags")).toBe("posts_tags");
    expect(deriveJoinTableName("tags", "posts")).toBe("posts_tags");
  });
});

describe("counter caches", () => {
  /**
   * A save that changed nothing must not increment, or the counter drifts
   * upward by one per save and the number on the page is quietly wrong.
   */
  it("does nothing when the owner did not change", () => {
    expect(inverseUpdatesCounterInMemory(7, 7)).toBeUndefined();
  });

  it("moves both sides when it did", () => {
    expect(inverseUpdatesCounterInMemory(7, 8)).toEqual({ decrement: 7, increment: 8 });
  });

  it("handles a record that had no owner", () => {
    expect(inverseUpdatesCounterInMemory(null, 8)).toEqual({ decrement: null, increment: 8 });
  });

  it("says whether the target changed", () => {
    expect(savedChangeToTarget(7, 8)).toBe(true);
    expect(targetPreviouslyChanged(7, 7)).toBe(false);
  });
});
