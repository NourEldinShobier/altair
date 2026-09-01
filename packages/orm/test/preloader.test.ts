/**
 * Loading an association for many records at once, ported from
 * `activerecord/test/cases/associations/eager_test.rb`,
 * `associations/preloader_test.rb` and the polymorphic cases in
 * `associations/eager_load_nested_include_test.rb`.
 *
 * The failures worth testing are the quiet ones: an association that comes
 * back empty because two keys had different types, and one that comes back
 * holding another record's rows.
 */

import { describe, expect, it } from "bun:test";
import {
  addCachedAssociations,
  extractAssociated,
  findFromTarget,
  groupedRecordsByClass,
  inverseWhichUpdatesCounterCache,
  inversedFromQueries,
  joinKey,
  markInversedFromQueries,
  nullifiedOwnerAttributes,
  ownersNeedingLoad,
  preloadedRecords,
  recordsByOwner,
  resolveCachedAssociations,
  setInverseInstanceFromQueries,
  sourceAttributeFromPreservedAttribute,
  targetClasses,
} from "../src/preloader.js";

describe("putting loaded records back on their owners", () => {
  const posts = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const comments = [
    { id: 10, postId: 1 },
    { id: 11, postId: 1 },
    { id: 12, postId: 2 },
  ];

  it("groups by the join key", () => {
    const byOwner = recordsByOwner(posts, comments, "id", "postId");

    expect(byOwner.get(posts[0]!)).toHaveLength(2);
    expect(byOwner.get(posts[1]!)).toHaveLength(1);
  });

  /** An owner with nothing is an empty list, not a missing entry. */
  it("gives an owner with no records an empty list", () => {
    expect(recordsByOwner(posts, comments, "id", "postId").get(posts[2]!)).toEqual([]);
  });

  /**
   * A foreign key that came back as a string and an id that came back as a
   * number would match nothing, and an association that is quietly empty is
   * the failure this whole file exists to avoid producing.
   */
  it("matches across driver types", () => {
    const byOwner = recordsByOwner([{ id: 1 }], [{ postId: "1" }], "id", "postId");

    expect([...byOwner.values()][0]).toHaveLength(1);
  });

  /**
   * A hundred comments with no post are not a hundred comments belonging to
   * the same post — grouping them together puts one record's rows on another.
   */
  it("does not group records with no key together", () => {
    const orphans = [{ postId: null }, { postId: undefined }];
    const byOwner = recordsByOwner([{ id: null }], orphans, "id", "postId");

    expect([...byOwner.values()][0]).toEqual([]);
  });

  /**
   * Both sides guard. A sentinel on either would be a key an application could
   * legitimately hold — a type column containing the literal "undefined" is
   * unlikely and not impossible, and the failure is one record holding
   * another's rows.
   */
  it("does not match a keyless record to an owner whose key stringifies oddly", () => {
    const byOwner = recordsByOwner(
      [{ id: "undefined" }],
      [{ postId: undefined }, { postId: null }],
      "id",
      "postId",
    );

    expect([...byOwner.values()][0]).toEqual([]);
  });

  it("has no key for a null", () => {
    expect(joinKey(null)).toBeUndefined();
    expect(joinKey(undefined)).toBeUndefined();
    expect(joinKey(0)).toBe("0");
    expect(joinKey("")).toBe("");
  });
});

describe("grouping by what to load from", () => {
  const comments = [
    { id: 1, type: "Post" },
    { id: 2, type: "Photo" },
    { id: 3, type: "Post" },
  ];

  /**
   * One query per class is two queries for a `commentable` over posts and
   * photos; grouping by association name would have to fall back to one query
   * per record.
   */
  it("splits a polymorphic association by class", () => {
    const groups = groupedRecordsByClass(comments, (comment) => comment.type);

    expect(groups.get("Post")).toHaveLength(2);
    expect(groups.get("Photo")).toHaveLength(1);
  });

  it("names every class it will query", () => {
    expect(targetClasses(comments, (comment) => comment.type)).toEqual(["Post", "Photo"]);
  });

  /** Left in a group keyed null it would produce a query against no table. */
  it("drops an owner with no type", () => {
    const groups = groupedRecordsByClass(
      [{ type: null }, { type: "Post" }],
      (comment) => comment.type,
    );

    expect([...groups.keys()]).toEqual(["Post"]);
  });

  it("groups one class as one group", () => {
    expect(targetClasses([{ type: "Post" }, { type: "Post" }], (c) => c.type)).toEqual(["Post"]);
  });
});

describe("what is already loaded", () => {
  const loaded = { id: 1, associations: { comments: { loaded: true, target: [{ id: 9 }] } } };
  const unloaded = { id: 2, associations: {} };

  /**
   * A record whose association was assigned rather than read has a target the
   * preloader must not overwrite; doing so discards an unsaved change and the
   * record then saves what the database already had.
   */
  it("leaves a loaded association alone", () => {
    expect(ownersNeedingLoad([loaded, unloaded], "comments")).toEqual([unloaded]);
  });

  it("loads a record with no associations at all", () => {
    expect(ownersNeedingLoad([{ id: 3 }], "comments")).toHaveLength(1);
  });

  /** The next hop of a `through` starts from every record, cached or not. */
  it("returns both halves", () => {
    const { cached, toLoad } = resolveCachedAssociations([loaded, unloaded], "comments");

    expect(cached).toEqual([loaded]);
    expect(toLoad).toEqual([unloaded]);
  });

  it("collects the targets already in memory", () => {
    expect(addCachedAssociations([loaded, unloaded], "comments")).toEqual([{ id: 9 }]);
  });

  it("handles a single-record association", () => {
    const withOne = { associations: { author: { loaded: true, target: { id: 5 } } } };

    expect(addCachedAssociations([withOne], "author")).toEqual([{ id: 5 }]);
  });

  /**
   * Two owners pointing at one record is the normal case for a `belongs_to`,
   * and the next hop would otherwise query for the same id twice.
   */
  it("deduplicates what a preload produced", () => {
    const shared = { id: 1 };
    const byOwner = new Map([
      ["a", [shared]],
      ["b", [shared]],
    ]);

    expect(preloadedRecords(byOwner)).toEqual([shared]);
  });
});

describe("the records one hop hands the next", () => {
  /**
   * A hundred posts by ten authors reach the second hop as ten authors, not a
   * hundred — the N+1 this exists to prevent, one level down.
   */
  it("flattens and deduplicates", () => {
    const author = { id: 1 };

    expect(findFromTarget([author, [author, { id: 2 }], author])).toEqual([author, { id: 2 }]);
  });

  /**
   * A record with nothing there would otherwise reach a query as `undefined`
   * and match every row with a null key.
   */
  it("drops what is not there", () => {
    expect(findFromTarget([undefined, { id: 1 }])).toEqual([{ id: 1 }]);
  });

  /**
   * By identity, not by key. Records from one query are the same objects, and
   * comparing by key would merge two records a query legitimately returned
   * twice — a `has_many` through a table with duplicate rows.
   */
  it("reads one association off each record, keeping distinct objects apart", () => {
    const shared = { id: 1 };

    expect(extractAssociated([{ author: shared }, { author: shared }, {}], "author")).toEqual([
      shared,
    ]);
    expect(
      extractAssociated([{ author: { id: 1 } }, { author: { id: 1 } }], "author"),
    ).toHaveLength(2);
  });

  it("reads a collection association too", () => {
    expect(extractAssociated([{ comments: [{ id: 1 }, { id: 2 }] }], "comments")).toHaveLength(2);
  });
});

describe("pointing records back at their owners", () => {
  /**
   * Without this, `includes(:comments)` followed by a loop touching
   * `comment.post` is the N+1 the include was written to remove.
   */
  it("sets the inverse on every loaded record", () => {
    const post = { id: 1 };
    const comments = [{ id: 10 }, { id: 11 }];

    expect(setInverseInstanceFromQueries(new Map([[post, comments]]), "post")).toBe(2);
    expect(comments[0]!["post" as keyof object]).toBe(post as never);
  });

  it("sets nothing when there is no inverse to set", () => {
    expect(setInverseInstanceFromQueries(new Map([[{ id: 1 }, [{ id: 2 }]]]), undefined)).toBe(0);
  });

  /**
   * An inverse set by the preloader is a fact about the query, not a change to
   * the record — one marked dirty by it would be written back on the next save.
   */
  it("marks an inverse as coming from the query", () => {
    const record: Record<string, unknown> = {};

    expect(inversedFromQueries(record)).toBe(false);

    markInversedFromQueries(record);

    expect(inversedFromQueries(record)).toBe(true);
  });
});

describe("counter caches", () => {
  const reflection = (name: string) => ({ name }) as never;

  it("finds the one association that maintains a counter", () => {
    const found = inverseWhichUpdatesCounterCache(
      [reflection("comments"), reflection("drafts")],
      "comments_count",
      (each) => (each.name === "comments" ? "comments_count" : undefined),
    );

    expect(found?.name).toBe("comments");
  });

  it("finds nothing when no association maintains it", () => {
    expect(
      inverseWhichUpdatesCounterCache([reflection("a")], "comments_count", () => undefined),
    ).toBeUndefined();
  });

  /**
   * Each create would increment it once per association, and nothing
   * recomputes a counter cache — so the wrong number stays wrong.
   */
  it("refuses two associations maintaining one counter", () => {
    expect(() =>
      inverseWhichUpdatesCounterCache(
        [reflection("comments"), reflection("replies")],
        "comments_count",
        () => "comments_count",
      ),
    ).toThrow("comments, replies");
  });
});

describe("clearing an owner", () => {
  /**
   * Clearing only the id leaves a `*_type` naming a class the row no longer
   * points at, which reads as belonging to something that does not exist
   * rather than to nothing.
   */
  it("clears the type column too when polymorphic", () => {
    expect(nullifiedOwnerAttributes("commentable_id", "commentable_type")).toEqual({
      commentable_id: null,
      commentable_type: null,
    });
  });

  it("clears only the key otherwise", () => {
    expect(nullifiedOwnerAttributes("post_id")).toEqual({ post_id: null });
  });
});

describe("reading a key off a record that is being destroyed", () => {
  /**
   * `after_destroy` callbacks and `dependent: :destroy` cascades both run after
   * the row is gone, so the key comes from what was preserved rather than from
   * a record whose attributes may already be cleared.
   */
  it("prefers the preserved value", () => {
    expect(
      sourceAttributeFromPreservedAttribute({ post_id: null }, "post_id", { post_id: 7 }),
    ).toBe(7);
  });

  it("falls back to the record", () => {
    expect(sourceAttributeFromPreservedAttribute({ post_id: 7 }, "post_id", undefined)).toBe(7);
  });

  /** A preserved null is a value, not an absence. */
  it("uses a preserved null rather than the record's", () => {
    expect(
      sourceAttributeFromPreservedAttribute({ post_id: 7 }, "post_id", { post_id: null }),
    ).toBe(null);
  });
});
