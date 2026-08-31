/**
 * The scope in force right now, and the counters kept on a parent row. Ported
 * from `activerecord/test/cases/scoping/named_scoping_test.rb`,
 * `default_scoping_test.rb` and `counter_cache_test.rb`.
 *
 * The case that matters for scoping is concurrency: a scope set while serving
 * one request must be invisible to every other, or a tenancy model becomes a
 * data leak that only appears under load and never under test.
 */

import { describe, expect, it } from "bun:test";
import { RecordNotFound } from "../src/relation.js";
import type { Relation } from "../src/relation.js";
import {
  addCounterCacheCallbacks,
  allQueriesScope,
  applyScope,
  associationScopeCache,
  buildScope,
  clearAssociationScopeCache,
  counterMustBeUpdatedByHasMany,
  currentScopeFor,
  decrementCounters,
  decrementCountersBeforeLastSave,
  evalScope,
  globalCurrentScope,
  hasActiveCachedCounter,
  hasCachedCounter,
  ignoreDefaultScope,
  incrementCounters,
  initialCountFor,
  joinScope,
  joinScopes,
  klassJoinScope,
  populateWithCurrentScopeAttributes,
  raiseRecordNotFoundException,
  scopeAttributes,
  scopeRegistry,
  setCurrentScope,
  setGlobalCurrentScope,
  setIgnoreDefaultScope,
} from "../src/scoping.js";

/** A stand-in relation: scoping does not care what it is, only that it is carried. */
const relation = (name: string) => name as unknown as Relation<unknown>;

/** The stand-ins are strings, so comparing them as such reads better than by identity. */
const named = (value: unknown) => (value === undefined ? undefined : String(value));

describe("the current scope", () => {
  it("is nothing outside a block", () => {
    expect(currentScopeFor("Post")).toBeUndefined();
    expect(scopeRegistry().scopes.size).toBe(0);
  });

  it("is in force inside one", async () => {
    const inside = await setCurrentScope("Post", relation("published"), async () =>
      currentScopeFor("Post"),
    );

    expect(named(inside)).toBe("published");
  });

  it("is gone again afterwards", async () => {
    await setCurrentScope("Post", relation("published"), async () => undefined);

    expect(currentScopeFor("Post")).toBeUndefined();
  });

  it("does not leak to another model", async () => {
    await setCurrentScope("Post", relation("published"), async () => {
      expect(currentScopeFor("Comment")).toBeUndefined();
    });
  });

  it("nests, with the inner one winning", async () => {
    await setCurrentScope("Post", relation("outer"), async () => {
      await setCurrentScope("Post", relation("inner"), async () => {
        expect(named(currentScopeFor("Post"))).toBe("inner");
      });

      expect(named(currentScopeFor("Post"))).toBe("outer");
    });
  });

  it("keeps two models' scopes at once", async () => {
    await setCurrentScope("Post", relation("published"), async () => {
      await setCurrentScope("Comment", relation("approved"), async () => {
        expect(named(currentScopeFor("Post"))).toBe("published");
        expect(named(currentScopeFor("Comment"))).toBe("approved");
      });
    });
  });

  /**
   * The one that matters. Two things running at once must not see each
   * other's scope — this is a tenancy model failing silently under load.
   */
  it("is invisible to work running concurrently", async () => {
    const seen: (Relation<unknown> | undefined)[] = [];

    await Promise.all([
      setCurrentScope("Post", relation("tenant-a"), async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        seen.push(currentScopeFor("Post"));
      }),
      setCurrentScope("Post", relation("tenant-b"), async () => {
        seen.push(currentScopeFor("Post"));
      }),
    ]);

    expect(new Set(seen.map(named))).toEqual(new Set(["tenant-a", "tenant-b"]));
  });

  it("is gone after the block throws", async () => {
    await expect(
      setCurrentScope("Post", relation("published"), async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(currentScopeFor("Post")).toBeUndefined();
  });
});

describe("a scope over every model", () => {
  it("is nothing by default", () => {
    expect(globalCurrentScope()).toBeUndefined();
    expect(allQueriesScope()).toBeUndefined();
  });

  it("applies inside its block", async () => {
    const inside = await setGlobalCurrentScope(relation("replica"), async () => allQueriesScope());

    expect(named(inside)).toBe("replica");
  });

  /** It must survive a model installing its own, or the two would fight. */
  it("survives a per-model scope being set inside it", async () => {
    await setGlobalCurrentScope(relation("replica"), async () => {
      await setCurrentScope("Post", relation("published"), async () => {
        expect(named(allQueriesScope())).toBe("replica");
        expect(named(currentScopeFor("Post"))).toBe("published");
      });
    });
  });
});

describe("suspending a default scope", () => {
  it("is not suspended by default", () => {
    expect(ignoreDefaultScope("Post")).toBe(false);
  });

  it("is inside the block", async () => {
    await setIgnoreDefaultScope("Post", async () => {
      expect(ignoreDefaultScope("Post")).toBe(true);
    });
  });

  it("only for the model named", async () => {
    await setIgnoreDefaultScope("Post", async () => {
      expect(ignoreDefaultScope("Comment")).toBe(false);
    });
  });

  /**
   * A flag set and unset by hand stays on when an exception skips the unset,
   * and a default scope that silently stops applying is how deleted records
   * come back.
   */
  it("goes back even when the block throws", async () => {
    await expect(
      setIgnoreDefaultScope("Post", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(ignoreDefaultScope("Post")).toBe(false);
  });
});

describe("what a scope implies for a new record", () => {
  it("takes the equality conditions", () => {
    expect(scopeAttributes({ status: "draft", author_id: 1 })).toEqual({
      status: "draft",
      author_id: 1,
    });
  });

  /**
   * A record cannot be built to satisfy `views > 10`, and guessing a value
   * that happens to is worse than leaving it unset.
   */
  it("leaves out anything that is not an equality", () => {
    expect(scopeAttributes({ status: "draft", views: { greaterThan: 10 } })).toEqual({
      status: "draft",
    });
  });

  it("keeps an explicit null, which is an equality", () => {
    expect(scopeAttributes({ deleted_at: null })).toEqual({ deleted_at: null });
  });

  it("applies them to a record", () => {
    expect(populateWithCurrentScopeAttributes({}, { status: "draft" })).toEqual({
      status: "draft",
    });
  });

  /** `Post.draft.build({ status: "published" })` has to mean what it says. */
  it("does not overwrite what the caller set", () => {
    expect(
      populateWithCurrentScopeAttributes({ status: "published" }, { status: "draft" }),
    ).toEqual({ status: "published" });
  });

  it("leaves other attributes alone", () => {
    const record: Record<string, unknown> = { title: "x" };

    expect(populateWithCurrentScopeAttributes(record, { status: "draft" })).toEqual({
      title: "x",
      status: "draft",
    });
  });
});

describe("combining scopes", () => {
  const upcase = (r: Relation<unknown>) => relation(`${String(r)}!`);

  it("runs one", () => {
    expect(evalScope(relation("posts"), upcase)).toBe(relation("posts!"));
  });

  it("applies one when there is one", () => {
    expect(applyScope(relation("posts"), upcase)).toBe(relation("posts!"));
  });

  it("leaves the relation alone when there is not", () => {
    expect(named(applyScope(relation("posts"), undefined))).toBe("posts");
  });

  it("builds several in order", () => {
    const a = (r: Relation<unknown>) => relation(`${String(r)}-a`);
    const b = (r: Relation<unknown>) => relation(`${String(r)}-b`);

    expect(named(buildScope(relation("posts"), [a, b]))).toBe("posts-a-b");
  });

  it("builds nothing from none", () => {
    expect(named(buildScope(relation("posts"), []))).toBe("posts");
  });

  /**
   * The thing most easily got wrong: a join that ignores the target's default
   * scope returns rows the same association would not return when read
   * directly.
   */
  it("applies the target's default scope to a join as well as the association's", () => {
    const associationScope = (r: Relation<unknown>) => relation(`${String(r)}-assoc`);
    const defaultScope = (r: Relation<unknown>) => relation(`${String(r)}-default`);

    expect(named(joinScope(relation("comments"), associationScope, [defaultScope]))).toBe(
      "comments-default-assoc",
    );
  });

  it("puts the default scopes first", () => {
    const associationScope = (r: Relation<unknown>) => r;
    const defaultScope = (r: Relation<unknown>) => r;

    expect(joinScopes(associationScope, [defaultScope])).toEqual([defaultScope, associationScope]);
  });

  it("takes just the default scopes when the association has none", () => {
    const defaultScope = (r: Relation<unknown>) => r;

    expect(joinScopes(undefined, [defaultScope])).toEqual([defaultScope]);
  });

  it("applies the target's own scopes", () => {
    const defaultScope = (r: Relation<unknown>) => relation(`${String(r)}-default`);

    expect(named(klassJoinScope(relation("comments"), [defaultScope]))).toBe("comments-default");
  });

  it("skips them when they are being ignored", () => {
    const defaultScope = (r: Relation<unknown>) => relation(`${String(r)}-default`);

    expect(named(klassJoinScope(relation("comments"), [defaultScope], true))).toBe("comments");
  });

  it("caches association scopes and can forget them", () => {
    associationScopeCache().set("Post#comments", relation("cached"));

    expect(named(associationScopeCache().get("Post#comments"))).toBe("cached");

    clearAssociationScopeCache();

    expect(associationScopeCache().size).toBe(0);
  });
});

describe("raiseRecordNotFoundException", () => {
  it("throws the error the rest of the ORM already uses", () => {
    expect(() => raiseRecordNotFoundException("Post", 7)).toThrow(RecordNotFound);
  });

  /** "Not found" alone sends you through a stack looking for which lookup failed. */
  it("names the model, the key and the value", () => {
    expect(() => raiseRecordNotFoundException("Post", 7)).toThrow("Post");
    expect(() => raiseRecordNotFoundException("Post", 7)).toThrow("id 7");
  });

  it("names a key that is not id", () => {
    expect(() => raiseRecordNotFoundException("Post", "abc", "slug")).toThrow("slug abc");
  });
});

describe("counter caches", () => {
  it("knows when one is kept", () => {
    expect(hasCachedCounter(true)).toBe(true);
    expect(hasCachedCounter("comments_count")).toBe(true);
    expect(hasCachedCounter(undefined)).toBe(false);
  });

  /**
   * Separate from whether one exists: a bulk load turns maintenance off,
   * because updating the parent once per child turns one INSERT into two
   * writes.
   */
  it("knows when it should be maintained right now", () => {
    expect(hasActiveCachedCounter(true)).toBe(true);
    expect(hasActiveCachedCounter(true, false)).toBe(false);
    expect(hasActiveCachedCounter(undefined, true)).toBe(false);
  });

  /**
   * Both sides doing it means every child counted twice; neither means the
   * number is a lie that only shows up on a page that displays it.
   */
  it("puts the work on the has_many side", () => {
    expect(counterMustBeUpdatedByHasMany(true, false)).toBe(true);
    expect(counterMustBeUpdatedByHasMany(true, true)).toBe(false);
    expect(counterMustBeUpdatedByHasMany(undefined, false)).toBe(false);
  });

  it("starts a count from what the column held", () => {
    expect(initialCountFor(5)).toBe(5);
    expect(initialCountFor("5")).toBe(5);
  });

  it("starts from zero when the column held nothing usable", () => {
    expect(initialCountFor(null)).toBe(0);
    expect(initialCountFor(undefined)).toBe(0);
    expect(initialCountFor("not a number")).toBe(0);
    expect(initialCountFor(-1)).toBe(0);
  });

  it("moves a counter up and down", () => {
    expect(incrementCounters(["comments_count"])).toEqual({ comments_count: 1 });
    expect(decrementCounters(["comments_count"])).toEqual({ comments_count: -1 });
  });

  it("moves several at once", () => {
    expect(incrementCounters(["a", "b"], 2)).toEqual({ a: 2, b: 2 });
  });

  /**
   * A child moved between parents has to decrement the old one as well as
   * increment the new. Doing only the increment leaves an empty post claiming
   * it has comments, and nothing reads the old parent again until much later.
   */
  it("decrements the parent a child moved away from", () => {
    expect(decrementCountersBeforeLastSave("comments_count", 1, 2)).toEqual({
      id: 1,
      change: { comments_count: -1 },
    });
  });

  it("does nothing when the parent did not change", () => {
    expect(decrementCountersBeforeLastSave("comments_count", 1, 1)).toBeUndefined();
  });

  it("does nothing when there was no previous parent", () => {
    expect(decrementCountersBeforeLastSave("comments_count", null, 2)).toBeUndefined();
    expect(decrementCountersBeforeLastSave("comments_count", undefined, 2)).toBeUndefined();
  });

  /**
   * After create and after destroy, not before: a child that fails to save
   * would otherwise leave the count permanently one ahead with nothing to
   * point at.
   */
  it("moves the counter after the row exists and after it is gone", () => {
    expect(addCounterCacheCallbacks("comments_count")).toEqual({
      afterCreate: { comments_count: 1 },
      afterDestroy: { comments_count: -1 },
    });
  });
});
