/**
 * The hops a `through` association traverses, ported from
 * `activerecord/test/cases/reflection_test.rb`'s chain cases and
 * `associations/nested_through_associations_test.rb`.
 *
 * A chain that is wrong does not raise. It builds a join that returns rows
 * from the wrong table, or that matches on an id across every kind of thing an
 * id could belong to.
 */

import { describe, expect, it } from "bun:test";
import { Model, reflectionFor } from "../src/index.js";
import {
  addAsSource,
  addAsThrough,
  associationChain,
  deprecatedNestedReflections,
} from "../src/reflection-chain.js";

class Comment extends Model<{ id: number; post_id: number }>("comments") {
  declare commenter: () => unknown;
}
class Post extends Model<{ id: number; author_id: number }>("posts") {
  declare comments: () => unknown;
  declare commenters: () => unknown;
  declare legacyComments: () => unknown;
}
class Author extends Model<{ id: number }>("authors") {
  declare posts: () => unknown;
  declare comments: () => unknown;
  declare commenters: () => unknown;
  declare postCommenters: () => unknown;
  declare legacyPosts: () => unknown;
  declare legacyComments: () => unknown;
  declare viaLegacySource: () => unknown;
  declare deepLegacy: () => unknown;
}
class Commenter extends Model<{ id: number }>("commenters") {}

Post.hasMany("comments", () => Comment, { foreignKey: "post_id" });
Post.hasMany("commenters", () => Commenter, { through: "comments", source: "commenter" });
Post.hasMany("legacyComments", () => Comment, { foreignKey: "post_id", deprecated: true });
Comment.belongsTo("commenter", () => Commenter, { foreignKey: "commenter_id" });

Author.hasMany("posts", () => Post, { foreignKey: "author_id" });
Author.hasMany("comments", () => Comment, { through: "posts" });
Author.hasMany("commenters", () => Commenter, { through: "comments", source: "commenter" });

// The source is itself a `through`, which is the shape that makes the source
// half of the collection load-bearing.
Author.hasMany("postCommenters", () => Commenter, { through: "posts", source: "commenters" });

Author.hasMany("legacyPosts", () => Post, { foreignKey: "author_id", deprecated: true });
Author.hasMany("legacyComments", () => Comment, { through: "legacyPosts", source: "comments" });
Author.hasMany("viaLegacySource", () => Comment, { through: "posts", source: "legacyComments" });
Author.hasMany("deepLegacy", () => Commenter, {
  through: "viaLegacySource",
  source: "commenter",
});

const chainOf = (owner: typeof Author, name: string): string[] =>
  associationChain(reflectionFor(owner, name)!).map((hop) => hop.reflection.name);

describe("a plain association", () => {
  /**
   * Not a special case worth removing: it is what lets a join builder take any
   * association without asking whether it is a `through`.
   */
  it("is a chain of one", () => {
    expect(chainOf(Author, "posts")).toEqual(["posts"]);
  });

  it("contributes nothing as somebody's source", () => {
    const posts = reflectionFor(Author, "posts")!;

    expect(addAsSource(posts, [])).toEqual([]);
  });

  /**
   * Appended rather than prepended: the intermediate is further from the owner
   * than whatever is already in the seed.
   */
  it("appends itself as an intermediate", () => {
    const posts = reflectionFor(Author, "posts")!;
    const comments = reflectionFor(Post, "comments")!;

    expect(
      addAsThrough(posts, [{ reflection: comments }]).map((hop) => hop.reflection.name),
    ).toEqual(["comments", "posts"]);
  });
});

describe("a through association", () => {
  /**
   * Outermost first, because that is the order a query builds joins in: each
   * entry joins to the one before it, and reversed the first join has nothing
   * to attach to.
   */
  it("is the association, then the hop it goes through", () => {
    expect(chainOf(Author, "comments")).toEqual(["comments", "posts"]);
  });

  /**
   * Either half can itself be a `through`: an author's commenters go through
   * comments, which go through posts.
   */
  it("flattens a through whose intermediate is also one", () => {
    expect(chainOf(Author, "commenters")).toEqual(["commenters", "comments", "posts"]);
  });

  /**
   * The source half can be a `through` too — an author's post-commenters reach
   * a `through` on Post — and it is collected before the intermediate.
   */
  it("flattens a through whose source is also one", () => {
    expect(chainOf(Author, "postCommenters")).toEqual(["postCommenters", "comments", "posts"]);
  });

  it("names each hop's own reflection, not the association's", () => {
    const chain = associationChain(reflectionFor(Author, "comments")!);

    expect(chain[1]?.reflection.owner.name).toBe("Author");
    expect(chain).toHaveLength(2);
  });
});

class Rating extends Model<{ id: number }>("ratings") {
  declare rateable: () => unknown;
}
class Reader extends Model<{ id: number }>("readers") {
  declare ratings: () => unknown;
  declare ratedPosts: () => unknown;
  declare memberships: () => unknown;
  declare memberRatings: () => unknown;
  declare memberRatedPosts: () => unknown;
}
class Membership extends Model<{ id: number }>("memberships") {
  declare ratings: () => unknown;
}

Rating.belongsTo("rateable", () => Post, { polymorphic: true });
Membership.hasMany("ratings", () => Rating, { foreignKey: "membership_id" });

Reader.hasMany("ratings", () => Rating, { foreignKey: "reader_id" });
Reader.hasMany("ratedPosts", () => Post, {
  through: "ratings",
  source: "rateable",
  sourceType: "Post",
});

// A typed hop that is itself a `through`.
Reader.hasMany("memberships", () => Membership, { foreignKey: "reader_id" });
Reader.hasMany("memberRatings", () => Rating, { through: "memberships", source: "ratings" });
Reader.hasMany("memberRatedPosts", () => Post, {
  through: "memberRatings",
  source: "rateable",
  sourceType: "Post",
});

describe("a hop reached by type", () => {
  /**
   * Without the type on the hop the join matches on the foreign key alone,
   * across every kind of thing the polymorphic association can point at — a
   * wrong answer with the right shape.
   */
  it("carries the source type into the chain", () => {
    const chain = associationChain(reflectionFor(Reader, "ratedPosts")!);

    expect(chain.map((hop) => hop.reflection.name)).toEqual(["ratedPosts", "ratings"]);
    expect(chain[1]?.sourceType).toBe("Post");
  });

  /** The typed hop can itself be a `through`, and is flattened like any other. */
  it("flattens a typed hop that goes through something", () => {
    const chain = associationChain(reflectionFor(Reader, "memberRatedPosts")!);

    expect(chain.map((hop) => hop.reflection.name)).toEqual([
      "memberRatedPosts",
      "memberRatings",
      "memberships",
    ]);
    expect(chain[1]?.sourceType).toBe("Post");
  });

  it("leaves the type off a hop that has none", () => {
    const chain = associationChain(reflectionFor(Author, "comments")!);

    expect(chain[1]).not.toHaveProperty("sourceType");
  });
});

describe("a deprecated association underneath another", () => {
  /**
   * The case a deprecation warning otherwise misses entirely: nothing names
   * it, so nothing warns, and it is removed on the strength of a search that
   * found no callers — taking the `through` above it with it.
   */
  it("is found through the association that uses it", () => {
    const found = deprecatedNestedReflections(reflectionFor(Author, "legacyComments")!);

    expect(found.map((one) => one.name)).toEqual(["legacyPosts"]);
  });

  /** The source half counts as much as the intermediate. */
  it("is found when it is the source rather than the hop", () => {
    const found = deprecatedNestedReflections(reflectionFor(Author, "viaLegacySource")!);

    expect(found.map((one) => one.name)).toEqual(["legacyComments"]);
  });

  /**
   * Nesting goes as deep as the declarations do: a deprecated association two
   * `through`s down is the one nothing names at all.
   */
  it("is found two levels down", () => {
    const found = deprecatedNestedReflections(reflectionFor(Author, "deepLegacy")!);

    expect(found.map((one) => one.name)).toEqual(["legacyComments"]);
  });

  it("is nothing when neither half is deprecated", () => {
    expect(deprecatedNestedReflections(reflectionFor(Author, "comments")!)).toEqual([]);
  });

  it("is nothing for an association that goes through nothing", () => {
    expect(deprecatedNestedReflections(reflectionFor(Author, "posts")!)).toEqual([]);
  });

  it("reads the flag off the declaration", () => {
    expect(reflectionFor(Author, "legacyPosts")?.isDeprecated()).toBe(true);
    expect(reflectionFor(Author, "posts")?.isDeprecated()).toBe(false);
  });
});
