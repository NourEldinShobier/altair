/**
 * Asking a model what its associations are, ported from
 * `activerecord/test/cases/reflection_test.rb`.
 *
 * The question anything generic asks: a serializer deciding what to include, a
 * fixture loader working out what to build first, a generator writing a form.
 * Without it each of those has to be handed a list, and the list drifts from
 * the model the moment somebody adds an association.
 */

import { describe, expect, it } from "bun:test";
import { Model } from "../src/index.js";

class Comment extends Model<{ id: number; post_id: number }>("comments") {}
class Author extends Model<{ id: number }>("authors") {}
class Tag extends Model<{ id: number }>("tags") {}

class Post extends Model<{ id: number; author_id: number }>("posts") {
  declare author: () => Promise<Author | null>;
  declare comments: () => unknown;
  declare firstComment: () => Promise<Comment | null>;
}

Post.belongsTo("author", () => Author, { foreignKey: "author_id" });
Post.hasMany("comments", () => Comment, { foreignKey: "post_id" });
Post.hasOne("firstComment", () => Comment, { foreignKey: "post_id" });

describe("listing them", () => {
  it("gives every association", () => {
    expect(Post.reflectOnAllAssociations()).toHaveLength(3);
  });

  it("gives their names in declaration order", () => {
    expect(Post.associationNames()).toEqual(["author", "comments", "firstComment"]);
  });

  it("narrows to one kind", () => {
    const many = Post.reflectOnAllAssociations("hasMany");

    expect(many.map((one) => one.name)).toEqual(["comments"]);
  });

  it("narrows to another", () => {
    expect(Post.reflectOnAllAssociations("belongsTo").map((one) => one.name)).toEqual(["author"]);
    expect(Post.reflectOnAllAssociations("hasOne").map((one) => one.name)).toEqual([
      "firstComment",
    ]);
  });

  it("gives nothing for a model with none", () => {
    expect(Tag.reflectOnAllAssociations()).toEqual([]);
    expect(Tag.associationNames()).toEqual([]);
  });
});

describe("asking about one", () => {
  it("gives its definition", () => {
    const reflection = Post.reflectOnAssociation("comments");

    expect(reflection?.name).toBe("comments");
    expect(reflection?.kind).toBe("hasMany");
    expect(reflection?.foreignKey).toBe("post_id");
  });

  it("resolves the class it points at", () => {
    expect(Post.reflectOnAssociation("author")?.target()).toBe(Author);
  });

  /**
   * Undefined rather than thrown, unlike `associationFor`. The two answer
   * different questions: this one asks whether there *is* an association, and
   * a caller asking that is prepared for no.
   */
  it("gives undefined for one that does not exist", () => {
    expect(Post.reflectOnAssociation("nonexistent")).toBeUndefined();
  });

  it("is the counterpart to associationFor, which insists", () => {
    expect(() => Post.associationFor("nonexistent")).toThrow();
  });
});

/**
 * A subclass has its parent's associations, so anything walking them has to
 * see them — otherwise a serializer built for the base class silently omits
 * half of what a subclass holds.
 */
describe("inheritance", () => {
  it("includes what the parent declared", () => {
    class Article extends Post {}

    expect(Article.associationNames()).toContain("comments");
  });

  it("includes the subclass's own alongside them", () => {
    class Article extends Post {
      declare tags: () => unknown;
    }
    Article.hasMany("tags", () => Tag, { foreignKey: "article_id" });

    expect(Article.associationNames()).toContain("comments");
    expect(Article.associationNames()).toContain("tags");
  });

  it("does not leak the subclass's back onto the parent", () => {
    class Article extends Post {
      declare revisions: () => unknown;
    }
    Article.hasMany("revisions", () => Tag, { foreignKey: "article_id" });

    expect(Post.associationNames()).not.toContain("revisions");
  });
});
