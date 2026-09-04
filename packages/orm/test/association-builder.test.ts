/**
 * What declaring an association sets up, ported from
 * `activerecord/test/cases/associations/belongs_to_associations_test.rb`,
 * `has_many_associations_test.rb` and `has_one_associations_test.rb` — the
 * option-validation and constructor cases.
 *
 * The failure every case is about: an option that is accepted and does nothing.
 * The association works, against the wrong thing, and the mistake surfaces
 * somewhere else entirely.
 */

import { describe, expect, it } from "bun:test";
import {
  UnknownAssociationOption,
  buildAssociation,
  buildRecord,
  defineCallback,
  defineChangeTrackingMethods,
  defineConstructors,
  defineExtensions,
  defineValidations,
  validOptions,
  validateAssociationOptions,
} from "../src/association-builder.js";
import { InvalidDependentOption } from "../src/inheritance.js";

describe("which options a macro accepts", () => {
  it("takes the ones every macro has", () => {
    for (const macro of ["belongsTo", "hasMany", "hasOne"] as const) {
      expect(validOptions(macro).has("foreignKey")).toBe(true);
      expect(validOptions(macro).has("inverseOf")).toBe(true);
    }
  });

  /** `post.comments.recent` has nowhere to live on a singular association. */
  it("takes the collection callbacks only on hasMany", () => {
    expect(validOptions("hasMany").has("beforeAdd")).toBe(true);
    expect(validOptions("hasOne").has("beforeAdd")).toBe(false);
    expect(validOptions("belongsTo").has("beforeAdd")).toBe(false);
  });

  it("takes counterCache on the sides that have one", () => {
    expect(validOptions("belongsTo").has("counterCache")).toBe(true);
    expect(validOptions("hasOne").has("counterCache")).toBe(false);
  });

  /**
   * `source` without `through` names a hop that does not exist, and accepting
   * it would let the declaration look configured while doing nothing.
   */
  it("takes source only alongside through", () => {
    expect(validOptions("hasMany", {}).has("source")).toBe(false);
    expect(validOptions("hasMany", { through: "posts" }).has("source")).toBe(true);
  });

  it("takes foreignType only alongside as", () => {
    expect(validOptions("hasMany", {}).has("foreignType")).toBe(false);
    expect(validOptions("hasMany", { as: "commentable" }).has("foreignType")).toBe(true);
  });

  /**
   * A polymorphic belongsTo's class comes from a column, so naming one as well
   * is a declaration that contradicts itself.
   */
  it("swaps className for foreignType when polymorphic", () => {
    expect(validOptions("belongsTo", {}).has("className")).toBe(true);
    expect(validOptions("belongsTo", { polymorphic: true }).has("className")).toBe(false);
    expect(validOptions("belongsTo", { polymorphic: true }).has("foreignType")).toBe(true);
  });

  it("takes ensuringOwnerWas only with an async destroy", () => {
    expect(validOptions("hasMany", {}).has("ensuringOwnerWas")).toBe(false);
    expect(validOptions("hasMany", { dependent: "destroy_async" }).has("ensuringOwnerWas")).toBe(
      true,
    );
  });
});

describe("checking a declaration's options", () => {
  it("passes one that is spelled right", () => {
    expect(() => validateAssociationOptions("hasMany", { className: "Comment" })).not.toThrow();
  });

  /**
   * The typo case: unchecked, the association works against the wrong class and
   * the mistake surfaces as a missing column.
   */
  it("refuses a typo", () => {
    expect(() => validateAssociationOptions("hasMany", { classNmae: "Comment" })).toThrow(
      UnknownAssociationOption,
    );
  });

  it("names what it would have accepted", () => {
    expect(() => validateAssociationOptions("hasMany", { classNmae: "Comment" })).toThrow(
      "className",
    );
  });

  it("names every option it did not recognise", () => {
    expect(() => validateAssociationOptions("hasMany", { a: 1, b: 2 })).toThrow("a, b");
  });

  it("refuses one that belongs to another macro", () => {
    expect(() => validateAssociationOptions("hasOne", { beforeAdd: () => undefined })).toThrow(
      UnknownAssociationOption,
    );
  });
});

describe("the constructors a declaration adds", () => {
  /**
   * The association knows the foreign key and the caller does not; without
   * these, the caller that forgets writes a row with a null key.
   */
  it("gives a singular association build and create", () => {
    expect(defineConstructors("belongsTo", "author")).toEqual(["buildAuthor", "createAuthor"]);
    expect(defineConstructors("hasOne", "profile")).toEqual(["buildProfile", "createProfile"]);
  });

  /** A collection builds through the collection itself. */
  it("gives a hasMany none", () => {
    expect(defineConstructors("hasMany", "comments")).toEqual([]);
  });

  /** There is no class to build: the type is whatever gets assigned. */
  it("gives a polymorphic association none", () => {
    expect(defineConstructors("belongsTo", "subject", true)).toEqual([]);
  });
});

describe("the validations a declaration adds", () => {
  /**
   * Required by default since Rails 5: the common case is a child that must
   * have a parent, and the old default let a missing one through to a foreign
   * key violation, or to nothing where there was no constraint.
   */
  it("makes a belongsTo required by default", () => {
    expect(defineValidations("belongsTo", "author")).toEqual(["presence:author"]);
  });

  it("lets a belongsTo opt out", () => {
    expect(defineValidations("belongsTo", "author", { optional: true })).toEqual([]);
    expect(defineValidations("belongsTo", "author", { required: false })).toEqual([]);
  });

  it("takes the application's default", () => {
    expect(defineValidations("belongsTo", "author", {}, false)).toEqual([]);
  });

  /** `required` is the older spelling and the inverse of `optional`. */
  it("refuses a declaration that says both", () => {
    expect(() =>
      defineValidations("belongsTo", "author", { optional: true, required: true }),
    ).toThrow("not both");
  });

  /** The other way round: a hasOne is required only when asked. */
  it("makes a hasOne optional by default", () => {
    expect(defineValidations("hasOne", "profile")).toEqual([]);
    expect(defineValidations("hasOne", "profile", { required: true })).toEqual([
      "presence:profile",
    ]);
  });

  it("adds none for a hasMany", () => {
    expect(defineValidations("hasMany", "comments", { required: true })).toEqual([]);
  });
});

describe("the change tracking a declaration adds", () => {
  /**
   * `belongsTo` only: the change tracked is a change to the foreign key on this
   * record. A `commentsChanged` would have to load the collection to answer,
   * which is a query behind a method that reads like a field.
   */
  it("is on the side that holds the key", () => {
    expect(defineChangeTrackingMethods("belongsTo", "author")).toEqual([
      "isAuthorChanged",
      "isAuthorPreviouslyChanged",
    ]);
    expect(defineChangeTrackingMethods("hasMany", "comments")).toEqual([]);
    expect(defineChangeTrackingMethods("hasOne", "profile")).toEqual([]);
  });
});

describe("the collection callbacks a declaration adds", () => {
  /** Named after the association, or a second collection would replace the first. */
  it("names each after its association", () => {
    expect(defineCallback("hasMany", "comments", { beforeAdd: () => undefined })).toEqual([
      "beforeAddForComments",
    ]);
  });

  it("adds only the ones that were given", () => {
    expect(
      defineCallback("hasMany", "comments", {
        beforeAdd: () => undefined,
        afterRemove: () => undefined,
      }),
    ).toEqual(["beforeAddForComments", "afterRemoveForComments"]);
  });

  it("adds none when none were given", () => {
    expect(defineCallback("hasMany", "comments")).toEqual([]);
    expect(defineCallback("hasOne", "profile", { beforeAdd: () => undefined })).toEqual([]);
  });
});

describe("the extension a declaration adds", () => {
  it("is a collection's block", () => {
    expect(defineExtensions("hasMany", "comments", true)).toEqual(["CommentsAssociationExtension"]);
  });

  it("is nothing without a block, and nothing for a singular association", () => {
    expect(defineExtensions("hasMany", "comments")).toEqual([]);
    expect(defineExtensions("hasOne", "profile", true)).toEqual([]);
  });
});

describe("everything one declaration adds", () => {
  it("describes a belongsTo", () => {
    expect(buildAssociation("belongsTo", "author")).toEqual({
      readers: ["author"],
      writers: ["setAuthor"],
      constructors: ["buildAuthor", "createAuthor"],
      validations: ["presence:author"],
      changeTracking: ["isAuthorChanged", "isAuthorPreviouslyChanged"],
      callbacks: [],
      extensions: [],
    });
  });

  it("describes a hasMany", () => {
    expect(buildAssociation("hasMany", "comments", { dependent: "destroy" })).toMatchObject({
      readers: ["comments"],
      constructors: [],
      validations: [],
      changeTracking: [],
    });
  });

  /**
   * Checked at declaration, where the line is on screen, rather than at the
   * first query that uses it.
   */
  it("refuses a typo at the declaration", () => {
    expect(() => buildAssociation("hasMany", "comments", { classNmae: "Comment" })).toThrow(
      UnknownAssociationOption,
    );
  });

  it("refuses a dependent option the macro cannot honour", () => {
    expect(() => buildAssociation("belongsTo", "author", { dependent: "nullify" })).toThrow(
      InvalidDependentOption,
    );
    expect(() => buildAssociation("hasMany", "comments", { dependent: "destroy" })).not.toThrow();
  });
});

describe("a record built through an association", () => {
  /**
   * It starts with the association's conditions, so a comment built from
   * `post.comments.where({ spam: false })` is already not spam and already
   * carries the owner's key — a caller that had to set both would eventually
   * build one that the relation it came from would not return.
   */
  it("starts with the relation's conditions", () => {
    expect(buildRecord({ postId: 1, spam: false })).toEqual({ postId: 1, spam: false });
  });

  it("takes the caller's attributes too", () => {
    expect(buildRecord({ postId: 1 }, { body: "hello" })).toEqual({ postId: 1, body: "hello" });
  });

  /** A scope is a default, not a constraint: an exception is deliberate. */
  it("lets the caller override one", () => {
    expect(buildRecord({ spam: false }, { spam: true })).toEqual({ spam: true });
  });

  it("does not alter the conditions it was given", () => {
    const conditions = { postId: 1 };
    buildRecord(conditions, { postId: 2 });

    expect(conditions).toEqual({ postId: 1 });
  });
});
