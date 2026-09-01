/**
 * Mixins that carry their own class-level half, ported from
 * `activesupport/test/concern_test.rb` and the redefinition cases in
 * `activesupport/test/core_ext/module_test.rb`.
 *
 * The case worth testing hardest is the dependency one: a concern that needs
 * another concern is where the hand-written version breaks, and the symptom is
 * a missing class method that is plainly declared.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  type ConcernTarget,
  appendFeatures,
  classEval,
  classMethods,
  concerning,
  definedBy,
  defineConcern,
  instance,
  instanceMethods,
  isA,
  methodAdded,
  newConcernTarget,
  prependFeatures,
  redefine,
  redefineSingletonMethod,
  removePossibleSingletonMethod,
  resetDefinitions,
  resetInstances,
  silenceRedefinitionOfMethod,
} from "../src/concern.js";

afterEach(() => {
  resetDefinitions();
  resetInstances();
});

describe("a concern's two halves", () => {
  /**
   * Two modules in two places is how one of them gets a method the other does
   * not know about.
   */
  it("adds instance methods to the prototype and class methods to the class", () => {
    const concern = defineConcern("Trashable");
    instanceMethods(concern, { trash: () => "trashed" });
    classMethods(concern, { trashed: () => [] });

    const target = newConcernTarget("Post");
    appendFeatures(concern, target);

    expect(target.prototype["trash"]).toBeDefined();
    expect(target.statics["trashed"]).toBeDefined();
  });

  it("runs the included hook against the class", () => {
    const seen: string[] = [];
    const concern = defineConcern("Trashable", { included: (target) => seen.push(target.name) });

    appendFeatures(concern, newConcernTarget("Post"));

    expect(seen).toEqual(["Post"]);
  });
});

describe("a concern that needs another", () => {
  /**
   * The whole trick: at the moment an inner concern is written into an outer
   * one there is no class yet, so its class-methods half would have nothing to
   * extend — and the symptom is a NoMethodError for a class method that is
   * plainly declared in a file that is plainly loaded.
   */
  it("applies the dependency to the class, not to the concern", () => {
    const inner = defineConcern("Timestamps");
    classMethods(inner, { timestamps: () => true });

    const outer = defineConcern("Trashable", { dependencies: [inner] });
    instanceMethods(outer, { trash: () => "trashed" });

    const target = newConcernTarget("Post");
    appendFeatures(outer, target);

    expect(target.statics["timestamps"]).toBeDefined();
    expect(target.prototype["trash"]).toBeDefined();
  });

  it("applies dependencies before the concern itself", () => {
    const order: string[] = [];
    const inner = defineConcern("A", { included: () => order.push("A") });
    const outer = defineConcern("B", { dependencies: [inner], included: () => order.push("B") });

    appendFeatures(outer, newConcernTarget("Post"));

    expect(order).toEqual(["A", "B"]);
  });

  /**
   * A diamond — two concerns depending on a third — is the normal case, and a
   * second application would overwrite whatever the class did in between.
   */
  it("applies a shared dependency once", () => {
    let applications = 0;
    const shared = defineConcern("Shared", { included: () => (applications += 1) });
    const left = defineConcern("Left", { dependencies: [shared] });
    const right = defineConcern("Right", { dependencies: [shared] });

    const target = newConcernTarget("Post");
    appendFeatures(left, target);
    appendFeatures(right, target);

    expect(applications).toBe(1);
  });

  it("reports whether it did anything", () => {
    const concern = defineConcern("Trashable");
    const target = newConcernTarget("Post");

    expect(appendFeatures(concern, target)).toBe(true);
    expect(appendFeatures(concern, target)).toBe(false);
  });

  /**
   * Two concerns depending on each other is a declaration mistake, and a stack
   * overflow at boot is a worse way to report one than a missing method.
   */
  it("survives a cycle", () => {
    const first = defineConcern("First");
    const second = defineConcern("Second", { dependencies: [first] });
    first.dependencies.push(second);

    expect(() => appendFeatures(first, newConcernTarget("Post"))).not.toThrow();
  });
});

describe("prepending rather than including", () => {
  /**
   * Prepended, a concern's `save` can call the class's own; included, the
   * class's own replaces it and the concern's is never reached. That failure
   * is silent — the method exists, it is just not the one running.
   */
  it("does not replace a method the class already has", () => {
    const target = newConcernTarget("Post");
    target.prototype["save"] = () => "class";

    const concern = defineConcern("Auditable");
    instanceMethods(concern, { save: () => "concern" });

    prependFeatures(concern, target);

    expect((target.prototype["save"] as () => string)()).toBe("class");
  });

  it("adds a method the class does not have", () => {
    const target = newConcernTarget("Post");
    const concern = defineConcern("Auditable");
    instanceMethods(concern, { audit: () => "audited" });

    prependFeatures(concern, target);

    expect(target.prototype["audit"]).toBeDefined();
  });

  it("leaves an existing class method alone too", () => {
    const target = newConcernTarget("Post");
    target.statics["find"] = () => "class";

    const concern = defineConcern("Auditable");
    classMethods(concern, { find: () => "concern" });

    prependFeatures(concern, target);

    expect((target.statics["find"] as () => string)()).toBe("class");
  });

  it("runs the prepended hook", () => {
    const seen: string[] = [];
    const concern = defineConcern("Auditable", { prepended: (target) => seen.push(target.name) });

    prependFeatures(concern, newConcernTarget("Post"));

    expect(seen).toEqual(["Post"]);
  });

  /**
   * Including replaces, which is the difference being tested — the same
   * concern applied the other way wins.
   */
  it("differs from including", () => {
    const target = newConcernTarget("Post");
    target.prototype["save"] = () => "class";

    const concern = defineConcern("Auditable");
    instanceMethods(concern, { save: () => "concern" });

    appendFeatures(concern, target);

    expect((target.prototype["save"] as () => string)()).toBe("concern");
  });
});

describe("declaring a group inline", () => {
  /**
   * The group is a real module with a name, so it appears in a backtrace and
   * can be moved out later without changing what it does.
   */
  it("names the group after the class it is in", () => {
    const target = newConcernTarget("Post");
    const concern = concerning(target, "Trashable", (each) => {
      instanceMethods(each, { trash: () => "trashed" });
    });

    expect(concern.name).toBe("Post::Trashable");
    expect(target.prototype["trash"]).toBeDefined();
  });
});

describe("defining a method over one that exists", () => {
  /**
   * A warning in a log nobody reads is indistinguishable from no warning, so
   * the answer comes back at the definition.
   */
  it("says whether something was replaced", () => {
    const target: Record<string, unknown> = { save: () => 1 };

    expect(redefine(target, "save", () => 2)).toEqual({ replaced: true });
    expect(redefine(target, "trash", () => 3)).toEqual({ replaced: false });
  });

  /**
   * A class method and an instance method of the same name are different
   * methods, and a helper taking "the object" would define the wrong one.
   */
  it("keeps class and instance methods apart", () => {
    const target = newConcernTarget("Post");
    target.prototype["find"] = () => "instance";

    expect(redefineSingletonMethod(target, "find", () => "class")).toEqual({ replaced: false });
    expect((target.prototype["find"] as () => string)()).toBe("instance");
  });

  /**
   * The caller is usually undoing a definition that may or may not have
   * happened — a test tearing down a stub, a reloader dropping generated
   * methods.
   */
  it("removes one that is there and says nothing about one that is not", () => {
    const target = newConcernTarget("Post");
    target.statics["find"] = () => 1;

    expect(removePossibleSingletonMethod(target, "find")).toBe(true);
    expect(removePossibleSingletonMethod(target, "find")).toBe(false);
    expect(target.statics["find"]).toBeUndefined();
  });

  /**
   * Without a way to declare a replacement intended, the options are a warning
   * on every legitimate one — which trains everybody to ignore them — or none.
   */
  it("replaces quietly when told to", () => {
    const target: Record<string, unknown> = { save: () => 1 };

    silenceRedefinitionOfMethod(target, "save", () => 2);

    expect((target["save"] as () => number)()).toBe(2);
  });

  /**
   * The useful question is not "does this method exist" but "who defined it
   * last", and by the time anything looks the answer is not recoverable from
   * the object.
   */
  it("records who defined what", () => {
    methodAdded("Post", "save");
    methodAdded("Post", "save");

    expect(definedBy("Post", "save")).toEqual(["Post", "Post"]);
    expect(definedBy("Post", "trash")).toEqual([]);
  });
});

describe("running a block against a class", () => {
  /**
   * Losing the block's value forces every caller to reach back into the class
   * by name.
   */
  it("hands back what the block produced", () => {
    const target = newConcernTarget("Post");

    expect(classEval(target, (each: ConcernTarget) => each.name)).toBe("Post");
  });
});

describe("asking about an object", () => {
  /**
   * By name rather than identity: a reloaded class in development is a
   * different object with the same name, and an identity check turns every
   * reload into a type error for objects created before it.
   */
  it("walks the named ancestry", () => {
    expect(isA({ ancestry: ["SpecialPost", "Post"] }, "Post")).toBe(true);
    expect(isA({ ancestry: ["Post"] }, "Comment")).toBe(false);
    expect(isA({}, "Post")).toBe(false);
  });
});

describe("a module-level instance", () => {
  /**
   * Built on first use rather than at load: one built at load time runs before
   * configuration and captures whatever the defaults were.
   */
  it("builds once, on first use", () => {
    let builds = 0;
    const build = () => {
      builds += 1;

      return { built: true };
    };

    const first = instance("cache", build);

    expect(instance("cache", build)).toBe(first);
    expect(builds).toBe(1);
  });

  it("keeps different names apart", () => {
    expect(instance("a", () => 1)).not.toBe(instance("b", () => 2));
  });
});
