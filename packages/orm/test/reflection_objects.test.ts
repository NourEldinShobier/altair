/**
 * What an association resolves to, ported from
 * `activerecord/test/cases/reflection_test.rb` — the `through_reflection`,
 * `source_reflection`, `association_class`, `polymorphic_name` and
 * `check_validity_of_inverse!` cases.
 *
 * The declaration says `through: "posts"`. What a preloader or a join needs is
 * the chain that implies, and every place that derives it separately is a
 * place that can come to disagree with the others.
 */

import { describe, expect, it } from "bun:test";
import { Model } from "../src/index.js";
import {
  Reflection,
  ReflectionError,
  addReflection,
  clearReflectionsCache,
  createReflection,
  likelyReflections,
  normalizedReflections,
  reflectionFor,
} from "../src/reflection.js";
import type { ReflectingModel } from "../src/reflection.js";

interface AuthorRow {
  id: number;
  name: string;
}
interface PostRow {
  id: number;
  author_id: number;
  title: string;
}
interface CommentRow {
  id: number;
  post_id: number;
  body: string;
}
interface PictureRow {
  id: number;
  imageable_id: number;
  imageable_type: string;
}

class Author extends Model<AuthorRow>("authors") {
  declare posts: () => unknown;
  declare comments: () => unknown;
  declare remarks: () => unknown;
  declare viaSource: () => unknown;
  declare profile: () => unknown;
  declare missing: () => unknown;
  declare nowhere: () => unknown;
  declare badInverse: () => unknown;
}
class Post extends Model<PostRow>("posts") {
  declare comments: () => unknown;
  declare author: () => unknown;
  declare pictures: () => unknown;
}
class Comment extends Model<CommentRow>("comments") {
  declare post: () => unknown;
}
class Picture extends Model<PictureRow>("pictures") {
  declare imageable: () => unknown;
}

Author.hasMany("posts", () => Post, { foreignKey: "author_id" });
Post.hasMany("comments", () => Comment, { foreignKey: "post_id" });
Post.belongsTo("author", () => Author, { foreignKey: "author_id" });
Comment.belongsTo("post", () => Post, { foreignKey: "post_id", inverseOf: "comments" });

/** The whole point of the chain: an author's comments are two hops away. */
Author.hasMany("comments", () => Comment, { through: "posts" });

/** Named explicitly, because the association on Post is not called `remarks`. */
Author.hasMany("remarks", () => Comment, { through: "posts", source: "comments" });

/**
 * A through whose declared target disagrees with what the source actually
 * points at. For a `through`, the source is authoritative and the declared
 * target is redundant — so this is the case that tells the two apart.
 */
Author.hasMany("viaSource", () => Post, { through: "posts", source: "comments" });

/** A one-to-one, so `collection?` is asked about all three kinds and not two. */
Author.hasOne("profile", () => Post, { foreignKey: "author_id" });

/** A source that is not there, for the error. */
Author.hasMany("missing", () => Comment, { through: "posts", source: "nonexistent" });

/** A through that is not there. */
Author.hasMany("nowhere", () => Comment, { through: "nonexistent" });

/** An inverse that is not there. */
Author.hasMany("badInverse", () => Post, { foreignKey: "author_id", inverseOf: "nonexistent" });

Post.hasMany("pictures", () => Picture, {
  as: "imageable",
  types: { Post: () => Post, Comment: () => Comment },
});
Picture.belongsTo("imageable", () => Post, {
  polymorphic: true,
  types: { Post: () => Post, Comment: () => Comment },
});

/** A narrowed association, for the scope cases. */
class Scoped extends Model<AuthorRow>("scoped") {
  declare recent: () => unknown;
}
Scoped.hasMany("recent", () => Post, { scope: (posts) => posts.order("id") });

/** For recording a reflection by hand. */
class Manual extends Model<AuthorRow>("manual") {
  declare posts: () => unknown;
}
Manual.hasMany("posts", () => Post);

/** For clearing what was built. */
class Cleared extends Model<AuthorRow>("cleared") {
  declare posts: () => unknown;
}
Cleared.hasMany("posts", () => Post);

/** For a key that is not `id`. */
class Keyed extends Model<AuthorRow>("keyed") {
  declare posts: () => unknown;
}
Keyed.hasMany("posts", () => Post, { primaryKey: "uuid" });

const reflect = (owner: unknown, name: string): Reflection =>
  reflectionFor(owner as ReflectingModel, name) as Reflection;

describe("the kind", () => {
  /** Rails' names, which is what its docs and its errors use. */
  it("reports the macro", () => {
    expect(reflect(Author, "posts").macro()).toBe("has_many");
    expect(reflect(Post, "author").macro()).toBe("belongs_to");
  });

  it("says whether reading gives many", () => {
    expect(reflect(Author, "posts").isCollection()).toBe(true);
    expect(reflect(Post, "author").isCollection()).toBe(false);
    // A hasOne is not a collection either, and is the case that separates
    // "is a hasMany" from "is not a belongsTo".
    expect(reflect(Author, "profile").isCollection()).toBe(false);
  });

  it("says which side holds the foreign key", () => {
    expect(reflect(Post, "author").isBelongsTo()).toBe(true);
    expect(reflect(Author, "posts").isBelongsTo()).toBe(false);
  });

  it("says whether it goes through another", () => {
    expect(reflect(Author, "comments").isThrough()).toBe(true);
    expect(reflect(Author, "posts").isThrough()).toBe(false);
  });

  it("carries its own name", () => {
    expect(reflect(Author, "posts").name).toBe("posts");
  });
});

describe("what it points at", () => {
  it("is the declared target for an ordinary association", () => {
    expect(reflect(Author, "posts").associationClass()).toBe(Post);
  });

  /**
   * Not the intermediate: an author's comments are Comments, and a caller
   * handed Post here builds the wrong query and finds out when a column is
   * missing.
   */
  it("is the source's class for a through association", () => {
    expect(reflect(Author, "comments").associationClass()).toBe(Comment);
  });

  /**
   * And it is the source's class even when the declaration named something
   * else — which is the only case that tells "asked the source" apart from
   * "returned what was declared".
   */
  it("prefers the source over the declared target", () => {
    expect(reflect(Author, "viaSource").associationClass()).toBe(Comment);
  });

  it("joins on the target's primary key", () => {
    expect(reflect(Author, "posts").associationPrimaryKey()).toBe("id");
  });

  it("takes the key the declaration named", () => {
    expect(reflect(Keyed, "posts").associationPrimaryKey()).toBe("uuid");
  });
});

describe("through associations", () => {
  it("names the association it goes through", () => {
    expect(reflect(Author, "comments").throughReflection().name).toBe("posts");
  });

  it("names the class in the middle", () => {
    expect(reflect(Author, "comments").throughModel()).toBe(Post);
  });

  /** Defaults to the association's own name, as Rails does. */
  it("looks for a source of the same name", () => {
    expect(reflect(Author, "comments").sourceReflectionName()).toBe("comments");
  });

  it("takes the source the declaration named", () => {
    expect(reflect(Author, "remarks").sourceReflectionName()).toBe("comments");
  });

  it("finds the reflection on the intermediate", () => {
    const source = reflect(Author, "comments").sourceReflection();

    expect(source.name).toBe("comments");
    expect(source.owner).toBe(Post as unknown as ReflectingModel);
  });

  it("offers both spellings it would accept", () => {
    expect(reflect(Author, "comments").sourceReflectionNames()).toEqual(["comments", "comment"]);
  });

  it("offers one when singular and plural are the same", () => {
    expect(reflect(Author, "remarks").sourceReflectionNames()).toEqual(["comments", "comment"]);
  });

  it("has no middle for an ordinary two-hop chain", () => {
    expect(reflect(Author, "comments").middleReflection()).toBeUndefined();
  });

  it("has no middle at all for a plain association", () => {
    expect(reflect(Author, "posts").middleReflection()).toBeUndefined();
  });

  it("refuses to report a through for one that is not", () => {
    expect(() => reflect(Author, "posts").throughReflection()).toThrow(ReflectionError);
  });
});

describe("when a chain does not resolve", () => {
  it("says which through is missing", () => {
    expect(() => reflect(Author, "nowhere").throughReflection()).toThrow("nonexistent");
  });

  it("names the model that has no such association", () => {
    expect(() => reflect(Author, "nowhere").throughReflection()).toThrow("Author");
  });

  it("says which source is missing", () => {
    expect(() => reflect(Author, "missing").sourceReflection()).toThrow("nonexistent");
  });

  /** The list is what turns "no such association" into a fix. */
  it("lists what the intermediate does have", () => {
    expect(() => reflect(Author, "missing").sourceReflection()).toThrow("comments");
  });

  it("suggests naming one", () => {
    expect(() => reflect(Author, "missing").sourceReflection()).toThrow("source");
  });
});

describe("inverses", () => {
  it("knows when one was declared", () => {
    expect(reflect(Comment, "post").hasInverse()).toBe(true);
  });

  it("knows when none was", () => {
    expect(reflect(Author, "posts").hasInverse()).toBe(false);
  });

  it("counts a polymorphic `as` as one", () => {
    expect(reflect(Post, "pictures").hasInverse()).toBe(true);
  });

  it("accepts an inverse that resolves", () => {
    expect(() => reflect(Comment, "post").checkValidityOfInverse()).not.toThrow();
  });

  /**
   * The symptom otherwise is not an error: an inverse that does not resolve
   * stops being used, preloading keeps working, and it quietly goes back to
   * one query per record.
   */
  it("refuses one that does not", () => {
    expect(() => reflect(Author, "badInverse").checkValidityOfInverse()).toThrow(ReflectionError);
  });

  it("names both sides in the complaint", () => {
    expect(() => reflect(Author, "badInverse").checkValidityOfInverse()).toThrow("nonexistent");
    expect(() => reflect(Author, "badInverse").checkValidityOfInverse()).toThrow("Post");
  });

  it("passes silently when there is nothing to check", () => {
    expect(() => reflect(Author, "posts").checkValidityOfInverse()).not.toThrow();
  });

  it("finds the polymorphic association pointing back", () => {
    const inverse = reflect(Post, "pictures").polymorphicInverseOf(
      Picture as unknown as ReflectingModel,
    );

    expect(inverse?.name).toBe("imageable");
  });

  it("gives nothing when the association is not polymorphic", () => {
    expect(
      reflect(Author, "posts").polymorphicInverseOf(Post as unknown as ReflectingModel),
    ).toBeUndefined();
  });
});

describe("polymorphism", () => {
  /** What goes in the `*_type` column — the owner's name, since the target varies. */
  it("stores the owner's class name", () => {
    expect(reflect(Post, "pictures").polymorphicName()).toBe("Post");
  });

  it("resolves a declared type", () => {
    expect(reflect(Picture, "imageable").polymorphicClassFor("Post")).toBe(Post);
    expect(reflect(Picture, "imageable").polymorphicClassFor("Comment")).toBe(Comment);
  });

  /**
   * The column holds a string that arrived from the database. Turning an
   * arbitrary one into a class to instantiate is how a write to that column
   * becomes code execution.
   */
  it("refuses a type nobody declared", () => {
    expect(() => reflect(Picture, "imageable").polymorphicClassFor("Secret")).toThrow(
      ReflectionError,
    );
  });

  it("lists what it will accept", () => {
    expect(() => reflect(Picture, "imageable").polymorphicClassFor("Secret")).toThrow("Post");
  });

  it("says none when nothing was declared", () => {
    expect(() => reflect(Author, "posts").polymorphicClassFor("Anything")).toThrow("none");
  });
});

describe("scopes", () => {
  it("has none by default", () => {
    expect(reflect(Author, "posts").hasScope()).toBe(false);
    expect(reflect(Author, "posts").scopeForAssociation()).toBeUndefined();
  });

  it("carries the one it was declared with", () => {
    expect(reflect(Scoped, "recent").hasScope()).toBe(true);
    expect(reflect(Scoped, "recent").scopeForAssociation()).toBeInstanceOf(Function);
  });
});

describe("the registry", () => {
  it("builds one for an association that exists", () => {
    expect(reflectionFor(Author as unknown as ReflectingModel, "posts")).toBeInstanceOf(Reflection);
  });

  it("gives nothing for one that does not", () => {
    expect(reflectionFor(Author as unknown as ReflectingModel, "nope")).toBeUndefined();
  });

  /** Resolving a through walks two classes, and this is on every query's path. */
  it("builds it once", () => {
    const first = reflectionFor(Author as unknown as ReflectingModel, "posts");
    const second = reflectionFor(Author as unknown as ReflectingModel, "posts");

    expect(first).toBe(second);
  });

  it("takes one recorded by hand", () => {
    const built = createReflection(
      Manual.reflectOnAssociation("posts") as never,
      Manual as unknown as ReflectingModel,
    );

    addReflection(Manual as unknown as ReflectingModel, "posts", built);

    expect(reflectionFor(Manual as unknown as ReflectingModel, "posts")).toBe(built);
  });

  it("forgets what it built", () => {
    const before = reflectionFor(Cleared as unknown as ReflectingModel, "posts");

    clearReflectionsCache(Cleared as unknown as ReflectingModel);

    expect(reflectionFor(Cleared as unknown as ReflectingModel, "posts")).not.toBe(before);
  });

  it("reports every association as a reflection", () => {
    const all = normalizedReflections(Post as unknown as ReflectingModel);

    expect(all.get("comments")).toBeInstanceOf(Reflection);
    expect(all.get("author")).toBeInstanceOf(Reflection);
  });

  it("keys them by name", () => {
    expect(Array.from(normalizedReflections(Post as unknown as ReflectingModel).keys())).toContain(
      "author",
    );
  });
});

describe("likelyReflections", () => {
  /** "Did you mean comments?" ends the search that "no such association" starts. */
  it("suggests a near miss", () => {
    expect(likelyReflections(Post as unknown as ReflectingModel, "comment")).toContain("comments");
  });

  it("suggests across a plural", () => {
    expect(likelyReflections(Post as unknown as ReflectingModel, "commentss")).toContain(
      "comments",
    );
  });

  it("suggests nothing for something unrelated", () => {
    expect(likelyReflections(Post as unknown as ReflectingModel, "zzzzz")).toEqual([]);
  });
});
