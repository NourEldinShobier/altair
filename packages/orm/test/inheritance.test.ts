/**
 * Which class a row belongs to and what happens to its children, ported from
 * `activerecord/test/cases/inheritance_test.rb` and the `dependent` cases in
 * `activerecord/test/cases/associations/`.
 *
 * Both features turn a value in a row into a decision about code, and both are
 * places where trusting the row is the bug.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  DEPENDENT_OPTIONS,
  InvalidDependentOption,
  UnknownStiClass,
  abstractClass,
  addDestroyCallbacks,
  addTouchCallbacks,
  applicationRecordClass,
  checkDependentOptions,
  validDependentOptions,
  clearPendingTouches,
  computeType,
  createSubclass,
  descendsFromActiveRecord,
  destroyAssociationAsyncJob,
  destroyAssociations,
  finderNeedsTypeCondition,
  handleDependency,
  pendingTouches,
  primaryAbstractClass,
  realInheritanceColumn,
  registerStiClass,
  resetInheritance,
  setPrimaryAbstractClass,
  stiClassFor,
  stiClassNames,
  stiName,
  touchAttributesWithTime,
  touchLater,
  touchModelTimestampsUnless,
  touchRecord,
} from "../src/inheritance.js";

class User {}
class Admin extends User {}

afterEach(() => {
  resetInheritance();
  clearPendingTouches();
});

describe("resolving a stored class name", () => {
  it("finds one that was declared", () => {
    registerStiClass("Admin", Admin);

    expect(stiClassFor("Admin")).toBe(Admin);
  });

  /**
   * The column's contents came from the database — a backup restore, a
   * migration, another service. Resolving an arbitrary string to a class is how
   * a writable column becomes a way to instantiate anything loaded.
   */
  it("refuses one that was not", () => {
    expect(() => stiClassFor("Whatever")).toThrow(UnknownStiClass);
  });

  it("says what it will accept", () => {
    registerStiClass("Admin", Admin);

    expect(() => stiClassFor("Whatever")).toThrow("Admin");
  });

  it("says why", () => {
    expect(() => stiClassFor("Whatever")).toThrow("must never resolve");
  });

  it("lists what is declared", () => {
    registerStiClass("Admin", Admin);
    registerStiClass("User", User);

    expect(stiClassNames()).toEqual(["Admin", "User"]);
  });

  it("writes a class's own name into the column", () => {
    expect(stiName(Admin)).toBe("Admin");
  });

  it("falls back when the column holds nothing", () => {
    expect(computeType(null, User)).toBe(User);
    expect(computeType(undefined, User)).toBe(User);
    expect(computeType("", User)).toBe(User);
  });

  it("resolves when it holds something", () => {
    registerStiClass("Admin", Admin);

    expect(computeType("Admin", User)).toBe(Admin);
  });

  it("still refuses an unknown name through computeType", () => {
    expect(() => computeType("Whatever", User)).toThrow(UnknownStiClass);
  });

  it("makes a subclass for a name with no class of its own", () => {
    const built = createSubclass(User, "Moderator");

    expect(built.name).toBe("Moderator");
    expect(stiClassFor("Moderator")).toBe(built);
  });
});

describe("abstract classes", () => {
  it("says which are abstract", () => {
    expect(abstractClass({ abstract: true })).toBe(true);
    expect(abstractClass({})).toBe(false);
  });

  it("remembers the one at the top", () => {
    setPrimaryAbstractClass(User);

    expect(primaryAbstractClass()).toBe(User);
    expect(applicationRecordClass(User)).toBe(true);
    expect(applicationRecordClass(Admin)).toBe(false);
  });

  it("has none to start with", () => {
    expect(primaryAbstractClass()).toBeUndefined();
  });
});

describe("whether a query needs a type condition", () => {
  it("says a model with its own table does not", () => {
    expect(descendsFromActiveRecord({ superclassIsAbstract: true })).toBe(true);
  });

  it("says a subclass does not descend directly", () => {
    expect(descendsFromActiveRecord({ superclassIsAbstract: false })).toBe(false);
  });

  it("says an abstract class does not either", () => {
    expect(descendsFromActiveRecord({ abstract: true, superclassIsAbstract: true })).toBe(false);
  });

  /**
   * Without one, `Admin.count` counts every user, and each row comes back as
   * an Admin answering to admin methods.
   */
  it("makes a subclass narrow by type", () => {
    expect(
      finderNeedsTypeCondition({ superclassIsAbstract: false, hasInheritanceColumn: true }),
    ).toBe(true);
  });

  it("does not make a base class narrow", () => {
    expect(
      finderNeedsTypeCondition({ superclassIsAbstract: true, hasInheritanceColumn: true }),
    ).toBe(false);
  });

  it("does not narrow a table with no type column", () => {
    expect(
      finderNeedsTypeCondition({ superclassIsAbstract: false, hasInheritanceColumn: false }),
    ).toBe(false);
  });

  it("names the column", () => {
    expect(realInheritanceColumn({})).toBe("type");
    expect(realInheritanceColumn({ inheritanceColumn: "kind" })).toBe("kind");
  });

  it("reports none where a model says it has none", () => {
    expect(realInheritanceColumn({ inheritanceColumn: null })).toBeNull();
  });
});

describe("what a dependent option may be", () => {
  it("accepts the ones its macro allows", () => {
    for (const macro of ["hasMany", "hasOne", "belongsTo"] as const) {
      for (const option of validDependentOptions(macro)) {
        expect(checkDependentOptions(option, macro)).toBe(option);
      }
    }
  });

  /**
   * The two lists are not the same list, and the gap is deliberate.
   * `DEPENDENT_OPTIONS` is what Rails has; `validDependentOptions` is what the
   * destroy path here can honour. Validating against the wider one is how
   * `delete_all` came to pass the check and then nullify.
   */
  it("accepts only options that are options", () => {
    const accepted = new Set([
      ...validDependentOptions("hasMany"),
      ...validDependentOptions("hasOne"),
      ...validDependentOptions("belongsTo"),
    ]);

    for (const option of accepted) expect(DEPENDENT_OPTIONS).toContain(option);
  });

  /**
   * Refused where it is written rather than accepted and quietly turned into
   * something else: it needs a job to enqueue and the ORM has no job to reach
   * for.
   */
  it("refuses destroy_async, which nothing here can honour", () => {
    for (const macro of ["hasMany", "hasOne", "belongsTo"] as const) {
      expect(() => checkDependentOptions("destroy_async", macro)).toThrow(InvalidDependentOption);
    }
  });

  /**
   * `delete` names one row and `delete_all` a collection, so each is refused by
   * the macro that has the other.
   */
  it("keeps delete and delete_all to their own macros", () => {
    expect(checkDependentOptions("delete", "hasOne")).toBe("delete");
    expect(() => checkDependentOptions("delete", "hasMany")).toThrow(InvalidDependentOption);
    expect(() => checkDependentOptions("delete_all", "hasOne")).toThrow(InvalidDependentOption);
  });

  /**
   * Listing every option there is would send the reader to try one that this
   * macro refuses too.
   */
  it("lists only what this macro would accept", () => {
    expect(() => checkDependentOptions("vaporise", "belongsTo")).not.toThrow("nullify");
  });

  it("refuses one that does not", () => {
    expect(() => checkDependentOptions("vaporise", "hasMany")).toThrow(InvalidDependentOption);
  });

  it("lists what it would accept", () => {
    expect(() => checkDependentOptions("vaporise", "hasMany")).toThrow("nullify");
  });

  /**
   * Rails accepts these on a belongs_to and does nothing, which reads as
   * configured and is not.
   */
  it("refuses one a belongs_to cannot do", () => {
    expect(() => checkDependentOptions("nullify", "belongsTo")).toThrow(InvalidDependentOption);
    expect(() => checkDependentOptions("delete_all", "belongsTo")).toThrow(InvalidDependentOption);
  });

  /**
   * None, for now. `handleDependents` skips a `belongsTo` outright, so
   * destroying a parent from a child is a feature this does not have — and
   * refusing at the declaration says so where saying nothing at the destroy
   * did not.
   */
  it("allows nothing on a belongs_to, because nothing acts on it", () => {
    expect(() => checkDependentOptions("destroy", "belongsTo")).toThrow(InvalidDependentOption);
  });
});

describe("what destroying a parent does", () => {
  it("destroys children when told to", () => {
    expect(handleDependency("destroy", "post_id")).toEqual({ action: "destroy" });
  });

  /**
   * `delete_all` skips the children's own callbacks, which is its point and
   * its hazard — a child that owns a file or children of its own leaves both
   * behind. So it is a separate action rather than a speed setting.
   */
  it("deletes them without their callbacks when told that instead", () => {
    expect(handleDependency("delete_all", "post_id")).toEqual({ action: "delete" });
    // `delete` is the same action on one row rather than many: turning it into
    // a destroy would run the child's callbacks, which is the thing the caller
    // asked to skip.
    expect(handleDependency("delete", "post_id")).toEqual({ action: "delete" });
  });

  it("clears the foreign key for a nullify", () => {
    expect(handleDependency("nullify", "post_id")).toEqual({
      action: "nullify",
      foreignKey: "post_id",
    });
  });

  it("refuses for a restriction", () => {
    expect(handleDependency("restrict", "post_id")).toEqual({ action: "refuse" });
  });

  it("enqueues for an async destroy", () => {
    expect(handleDependency("destroy_async", "post_id")).toEqual({ action: "enqueue" });
  });

  /**
   * Checking restrictions after some children are already gone means a refused
   * destroy has already deleted things — and the caller sees an exception and
   * assumes nothing happened.
   */
  it("checks restrictions before it destroys anything", () => {
    const actions = destroyAssociations([
      { name: "comments", dependent: "destroy", foreignKey: "post_id" },
      { name: "orders", dependent: "restrict", foreignKey: "post_id" },
    ]);

    expect(actions.map((each) => each.name)).toEqual(["orders", "comments"]);
  });

  it("leaves out associations with no dependent option", () => {
    const actions = destroyAssociations([
      { name: "comments", dependent: "destroy", foreignKey: "post_id" },
      { name: "views", foreignKey: "post_id" },
    ]);

    expect(actions.map((each) => each.name)).toEqual(["comments"]);
  });

  it("does nothing for a record with no dependents", () => {
    expect(destroyAssociations([])).toEqual([]);
  });

  it("describes the job an async destroy enqueues", () => {
    expect(destroyAssociationAsyncJob("Post", "comments", "post_id", 7)).toEqual({
      owner: "Post",
      association: "comments",
      foreignKey: "post_id",
      ownerId: 7,
    });
  });

  /** A restriction that ran after the destroy would refuse what already happened. */
  it("runs a restriction before and everything else after", () => {
    expect(addDestroyCallbacks("restrict")).toEqual({ before: true, after: false });
    expect(addDestroyCallbacks("destroy")).toEqual({ before: false, after: true });
  });
});

describe("touching", () => {
  it("moves updated_at", () => {
    const at = new Date("2026-06-15T12:00:00Z");

    expect(touchAttributesWithTime([], at)).toEqual({ updated_at: at });
  });

  /**
   * One timestamp for all of them, or a record touched across two columns ends
   * up with two times a millisecond apart — which reads as two edits.
   */
  it("gives every column the same time", () => {
    const at = new Date("2026-06-15T12:00:00Z");

    expect(touchAttributesWithTime(["last_seen_at"], at)).toEqual({
      updated_at: at,
      last_seen_at: at,
    });
  });

  it("takes a different timestamp column", () => {
    const at = new Date(0);

    expect(touchAttributesWithTime([], at, ["modified_at"])).toEqual({ modified_at: at });
  });

  it("moves them on a save by default", () => {
    expect(touchModelTimestampsUnless(true, ["title"])).toBe(true);
  });

  it("does not when the model turned them off", () => {
    expect(touchModelTimestampsUnless(false, ["title"])).toBe(false);
  });

  /**
   * An import that sets `updated_at` deliberately means it, and overwriting it
   * throws away the only thing that said when the data was actually true.
   */
  it("does not when the record set the column itself", () => {
    expect(touchModelTimestampsUnless(true, ["title", "updated_at"])).toBe(false);
  });
});

describe("queuing a touch", () => {
  /**
   * A hundred children touching one parent would otherwise write it a hundred
   * times inside a transaction — a hundred row versions, a hundred index
   * updates, and a lock held for all of it.
   */
  it("collapses several touches of one record into one", () => {
    touchLater("Post/1", ["updated_at"]);
    touchLater("Post/1", ["updated_at"]);
    touchLater("Post/1", ["updated_at"]);

    expect(pendingTouches()).toBe(1);
  });

  it("keeps two records apart", () => {
    touchLater("Post/1", ["updated_at"]);
    touchLater("Post/2", ["updated_at"]);

    expect(pendingTouches()).toBe(2);
  });

  it("merges the columns of several touches", () => {
    touchLater("Post/1", ["updated_at"]);
    touchLater("Post/1", ["last_commented_at"]);

    expect(touchRecord()[0]?.columns.sort()).toEqual(["last_commented_at", "updated_at"]);
  });

  /** The last change is the one a cache key should reflect. */
  it("keeps the latest time", () => {
    touchLater("Post/1", ["updated_at"], new Date(1000));
    touchLater("Post/1", ["updated_at"], new Date(5000));

    expect(touchRecord()[0]?.at).toEqual(new Date(5000));
  });

  it("empties as it hands them over", () => {
    touchLater("Post/1", ["updated_at"]);

    touchRecord();

    expect(pendingTouches()).toBe(0);
  });

  it("hands back nothing when nothing was queued", () => {
    expect(touchRecord()).toEqual([]);
  });

  it("describes the callbacks a touch association adds", () => {
    expect(addTouchCallbacks("last_commented_at")).toEqual({
      afterSave: ["last_commented_at"],
      afterDestroy: ["last_commented_at"],
    });
  });

  it("adds none for a bare touch", () => {
    expect(addTouchCallbacks()).toEqual({ afterSave: [], afterDestroy: [] });
  });
});
