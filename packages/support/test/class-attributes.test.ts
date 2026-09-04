/**
 * Configuration a subclass can override without disturbing its parent, ported
 * from `activesupport/test/core_ext/module/attribute_accessors_test.rb`,
 * `activesupport/test/core_ext/class/attribute_test.rb` and the
 * `attr_internal` cases in `activesupport/test/core_ext/module_test.rb`.
 *
 * The bug all of this exists to prevent is invisible until two subclasses
 * disagree about a value neither of them set — so the tests that matter check
 * the *parent* after a child writes.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { classAttribute } from "../src/objects.js";
import {
  NameError,
  NoTaskStore,
  anonymous,
  attrInternalAccessor,
  attrInternalName,
  attrInternalNamingFormat,
  attrInternalReader,
  attrInternalWriter,
  clearConstants,
  clearModuleAttributes,
  configAccessor,
  constantize,
  descendants,
  inheritableCopy,
  mattrAccessor,
  mattrReader,
  mattrWriter,
  methodDefinedWithin,
  methodVisibility,
  moduleParent,
  mutableClassAttribute,
  redefineMethod,
  registerConstant,
  removePossibleMethod,
  resetAttrInternalNamingFormat,
  safeConstantize,
  subclasses,
  threadMattrAccessor,
  threadMattrReader,
  threadMattrWriter,
  useTaskStore,
} from "../src/class-attributes.js";

afterEach(() => {
  clearModuleAttributes();
  clearConstants();
  useTaskStore(undefined);
  resetAttrInternalNamingFormat();
});

describe("a value a subclass may override", () => {
  const build = () => {
    class Base {}
    class Child extends Base {}
    classAttribute(Base, "timeout", 30);

    return { Base, Child };
  };

  it("gives a subclass its parent's value", () => {
    const { Child } = build();

    expect((Child as unknown as Record<string, unknown>)["timeout"]).toBe(30);
  });

  /**
   * The failure this prevents: a child writing through to the parent changes
   * every sibling, and nothing says so.
   */
  it("does not change the parent when a child writes", () => {
    const { Base, Child } = build();
    (Child as unknown as Record<string, unknown>)["timeout"] = 5;

    expect((Base as unknown as Record<string, unknown>)["timeout"]).toBe(30);
  });

  it("leaves a sibling alone too", () => {
    const { Base } = build();
    class First extends Base {}
    class Second extends Base {}
    (First as unknown as Record<string, unknown>)["timeout"] = 5;

    expect((Second as unknown as Record<string, unknown>)["timeout"]).toBe(30);
  });

  /** An unset subclass tracks its parent rather than a snapshot. */
  it("follows a later change to the parent", () => {
    const { Base, Child } = build();
    (Base as unknown as Record<string, unknown>)["timeout"] = 60;

    expect((Child as unknown as Record<string, unknown>)["timeout"]).toBe(60);
  });
});

describe("changing an inherited collection", () => {
  const build = () => {
    class Base {}
    class Child extends Base {}
    classAttribute(Base, "middleware", ["logger"]);

    return { Base, Child };
  };

  /**
   * A plain read hands back the parent's own array, so pushing to it appends
   * to the parent's — the shared-mutable-default bug in its usual form.
   */
  it("hands back a copy the child owns", () => {
    const { Base, Child } = build();

    mutableClassAttribute<string[]>(Child as unknown as Record<string, unknown>, "middleware").push(
      "auth",
    );

    expect((Base as unknown as Record<string, unknown>)["middleware"]).toEqual(["logger"]);
  });

  it("keeps what was inherited in the copy", () => {
    const { Child } = build();

    expect(
      mutableClassAttribute<string[]>(Child as unknown as Record<string, unknown>, "middleware"),
    ).toEqual(["logger"]);
  });

  it("makes the change visible on the child", () => {
    const { Child } = build();
    mutableClassAttribute<string[]>(Child as unknown as Record<string, unknown>, "middleware").push(
      "auth",
    );

    expect((Child as unknown as Record<string, unknown>)["middleware"]).toEqual(["logger", "auth"]);
  });

  it("copies an array", () => {
    const source = [1, 2];

    expect(inheritableCopy(source)).toEqual(source);
    expect(inheritableCopy(source)).not.toBe(source);
  });

  it("copies a plain object", () => {
    const source = { a: 1 };

    expect(inheritableCopy(source)).not.toBe(source);
  });

  /**
   * Only arrays and plain objects. Copying deeply would duplicate whatever a
   * value references — a connection, a logger — and the copy would diverge
   * from the thing it was meant to be.
   */
  it("does not copy anything else", () => {
    const regexp = /x/;
    const date = new Date(0);

    expect(inheritableCopy(regexp)).toBe(regexp);
    expect(inheritableCopy(date)).toBe(date);
    expect(inheritableCopy(7)).toBe(7);
  });
});

describe("a genuinely global value", () => {
  it("reads back what was written", () => {
    mattrWriter("logger", "stdout");

    expect(mattrReader("logger")).toBe("stdout");
  });

  it("takes a default", () => {
    expect(mattrAccessor("level", "info").get()).toBe("info");
  });

  it("does not overwrite a value already set", () => {
    mattrWriter("level", "debug");

    expect(mattrAccessor("level", "info").get()).toBe("debug");
  });

  it("writes through the accessor", () => {
    const level = mattrAccessor("level", "info");
    level.set("warn");

    expect(mattrReader("level")).toBe("warn");
  });
});

describe("a value scoped to one unit of work", () => {
  const store = () => {
    const held = new Map<string, unknown>();

    return {
      get: (name: string) => held.get(name),
      set: (name: string, value: unknown) => held.set(name, value),
    };
  };

  it("reads back what this task wrote", () => {
    useTaskStore(store());
    threadMattrWriter("currentUser", "ada");

    expect(threadMattrReader("currentUser")).toBe("ada");
  });

  it("sees nothing from another task's store", () => {
    useTaskStore(store());
    threadMattrWriter("currentUser", "ada");

    useTaskStore(store());

    expect(threadMattrReader("currentUser")).toBeUndefined();
  });

  /**
   * Falling back to a process-wide value is how one request's data reaches
   * another request's page, so this refuses instead.
   */
  it("refuses to write with no store open", () => {
    expect(() => threadMattrWriter("currentUser", "ada")).toThrow(NoTaskStore);
  });

  it("reads nothing rather than refusing", () => {
    expect(threadMattrReader("currentUser")).toBeUndefined();
  });

  it("works through the accessor", () => {
    useTaskStore(store());
    const user = threadMattrAccessor<string>("currentUser");
    user.set("ada");

    expect(user.get()).toBe("ada");
  });
});

describe("internal attributes", () => {
  /**
   * Prefixed so framework bookkeeping cannot collide with an application's
   * attribute of the same name — the collision would be silent and whichever
   * wrote last would win.
   */
  it("prefixes the property it uses", () => {
    expect(attrInternalName("view_context")).toBe("_view_context");
  });

  it("reads and writes through the prefix", () => {
    const target: Record<string, unknown> = {};
    attrInternalWriter(target, "view_context", "ctx");

    expect(target["_view_context"]).toBe("ctx");
    expect(attrInternalReader(target, "view_context")).toBe("ctx");
  });

  it("leaves the unprefixed name alone", () => {
    const target: Record<string, unknown> = { view_context: "theirs" };
    attrInternalWriter(target, "view_context", "ours");

    expect(target["view_context"]).toBe("theirs");
  });

  it("takes a different format", () => {
    attrInternalNamingFormat("@%s");

    expect(attrInternalName("x")).toBe("@x");
  });

  /** Without the placeholder every internal attribute would share one name. */
  it("refuses a format with no placeholder", () => {
    expect(() => attrInternalNamingFormat("_internal")).toThrow("%s");
  });

  it("works through the accessor", () => {
    const target: Record<string, unknown> = {};
    const accessor = attrInternalAccessor(target, "x");
    accessor.set(7);

    expect(accessor.get()).toBe(7);
  });
});

describe("config accessors", () => {
  it("takes a default", () => {
    const target: Record<string, unknown> = {};

    expect(configAccessor(target, "perform_caching", true).get()).toBe(true);
  });

  it("does not overwrite what is set", () => {
    const target: Record<string, unknown> = { perform_caching: false };

    expect(configAccessor(target, "perform_caching", true).get()).toBe(false);
  });

  it("writes back", () => {
    const target: Record<string, unknown> = {};
    configAccessor(target, "perform_caching", true).set(false);

    expect(target["perform_caching"]).toBe(false);
  });
});

describe("resolving a name to a class", () => {
  class Post {}

  it("finds one that was registered", () => {
    registerConstant("Post", Post);

    expect(constantize("Post")).toBe(Post);
  });

  /** Resolving against everything loaded is how a request string becomes a class. */
  it("refuses one that was not", () => {
    expect(() => constantize("Post")).toThrow(NameError);
  });

  it("says what is registered", () => {
    registerConstant("Post", Post);

    expect(() => constantize("Psot")).toThrow("Post");
  });

  /** For an optional adapter, where missing is an expected outcome. */
  it("answers undefined when asked safely", () => {
    expect(safeConstantize("Post")).toBeUndefined();
  });

  it("finds an enclosing namespace", () => {
    const admin = {};
    registerConstant("Admin", admin);

    expect(moduleParent("Admin::Post")).toBe(admin);
  });

  it("finds none for a top-level name", () => {
    expect(moduleParent("Post")).toBeUndefined();
  });

  /**
   * A class expression assigned to nothing has an empty `name`, which is
   * exactly the case worth detecting: a registry keyed on class names silently
   * collapses every anonymous class onto one key.
   */
  it("says which classes are anonymous", () => {
    class Named {}

    expect(anonymous(Named)).toBe(false);
    expect(anonymous(class {})).toBe(true);
    expect(anonymous({})).toBe(true);
  });
});

describe("finding classes below one", () => {
  class Base {}
  class Middle extends Base {}
  class Leaf extends Middle {}

  /**
   * Direct only. Conflating this with `descendants` makes a registry of
   * handlers pick up an abstract intermediate class as though it were one.
   */
  it("lists direct subclasses", () => {
    expect(subclasses(Base, [Middle, Leaf])).toEqual([Middle]);
  });

  it("lists everything below", () => {
    expect(descendants(Base, [Middle, Leaf])).toEqual([Middle, Leaf]);
  });

  it("does not list the class itself", () => {
    expect(descendants(Base, [Base, Middle])).toEqual([Middle]);
  });

  it("lists nothing for an unrelated class", () => {
    class Other {}

    expect(descendants(Base, [Other])).toEqual([]);
  });
});

describe("replacing methods", () => {
  /** Silently overwriting is how a hand-written method disappears. */
  it("says when it replaced something", () => {
    const target: Record<string, unknown> = { name: () => "old" };

    expect(redefineMethod(target, "name", () => "new").replaced).toBe(true);
  });

  it("says when it defined something new", () => {
    expect(redefineMethod({}, "name", () => "new").replaced).toBe(false);
  });

  it("removes one that is there", () => {
    const target: Record<string, unknown> = { name: () => "x" };

    expect(removePossibleMethod(target, "name")).toBe(true);
    expect("name" in target).toBe(false);
  });

  it("removes nothing that is not", () => {
    expect(removePossibleMethod({}, "name")).toBe(false);
  });

  it("says whether a method was defined below a boundary", () => {
    class Base {
      inherited(): void {}
    }
    class Child extends Base {
      own(): void {}
    }

    expect(methodDefinedWithin(Child.prototype, "own", Base.prototype)).toBe(true);
    expect(methodDefinedWithin(Child.prototype, "inherited", Base.prototype)).toBe(false);
  });

  it("reports visibility", () => {
    const target: Record<string, unknown> = { open: () => undefined };

    expect(methodVisibility(target, "open")).toBe("public");
    expect(methodVisibility(target, "_hidden")).toBe("private");
    expect(methodVisibility(target, "missing")).toBe("none");
  });
});
