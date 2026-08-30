/**
 * Object and class helpers, ported from
 * `activesupport/test/core_ext/module/delegation_test.rb`,
 * `class/attribute_test.rb` and `core_ext/object/duplicable_test.rb`.
 */

import { describe, expect, it } from "bun:test";
import {
  classAttribute,
  delegate,
  delegateMissingTo,
  duplicable,
  instanceValues,
  instanceVariableNames,
  moduleParentName,
  moduleParents,
  ownCopy,
} from "../src/index.js";

describe("classAttribute", () => {
  it("gives the class its default", () => {
    class Post {}
    classAttribute(Post, "perPage", 25);

    expect((Post as unknown as { perPage: number }).perPage).toBe(25);
  });

  it("lets the class change it", () => {
    class Post {}
    classAttribute(Post, "perPage", 25);
    (Post as unknown as { perPage: number }).perPage = 50;

    expect((Post as unknown as { perPage: number }).perPage).toBe(50);
  });

  it("lets a subclass inherit it", () => {
    class Post {}
    classAttribute(Post, "perPage", 25);
    class Draft extends Post {}

    expect((Draft as unknown as { perPage: number }).perPage).toBe(25);
  });

  /**
   * The half that is easy to leave out, and quiet when it is missing: one
   * subclass would otherwise reconfigure every other model in the process.
   */
  it("does not let a subclass change its parent", () => {
    class Post {}
    classAttribute(Post, "perPage", 25);
    class Draft extends Post {}
    (Draft as unknown as { perPage: number }).perPage = 10;

    expect((Draft as unknown as { perPage: number }).perPage).toBe(10);
    expect((Post as unknown as { perPage: number }).perPage).toBe(25);
  });

  it("does not let one subclass change a sibling", () => {
    class Post {}
    classAttribute(Post, "perPage", 25);
    class Draft extends Post {}
    class Archived extends Post {}
    (Draft as unknown as { perPage: number }).perPage = 10;

    expect((Archived as unknown as { perPage: number }).perPage).toBe(25);
  });

  it("lets a later change to the parent reach an unset subclass", () => {
    class Post {}
    classAttribute(Post, "perPage", 25);
    class Draft extends Post {}
    (Post as unknown as { perPage: number }).perPage = 30;

    expect((Draft as unknown as { perPage: number }).perPage).toBe(30);
  });
});

describe("ownCopy", () => {
  /** Pushing on a subclass otherwise mutates the array the parent owns. */
  it("gives a subclass its own array", () => {
    class Post {
      static rules: string[] = ["a"];
    }
    class Draft extends Post {}

    ownCopy(Draft, "rules");
    Draft.rules.push("b");

    expect(Draft.rules).toEqual(["a", "b"]);
    expect(Post.rules).toEqual(["a"]);
  });

  it("leaves an array the class already owns alone", () => {
    class Post {
      static rules: string[] = ["a"];
    }
    const before = Post.rules;
    ownCopy(Post, "rules");

    expect(Post.rules).toBe(before);
  });

  it("copies an object as well as an array", () => {
    class Post {
      static config: Record<string, number> = { a: 1 };
    }
    class Draft extends Post {}

    ownCopy(Draft, "config");
    Draft.config.b = 2;

    expect(Post.config).toEqual({ a: 1 });
  });
});

describe("delegate", () => {
  class Address {
    street = "Main St";
    city = "Springfield";
    describe(): string {
      return `${this.street}, ${this.city}`;
    }
  }

  function orderClass() {
    return class Order {
      address: Address | null = new Address();
    };
  }

  it("forwards a property", () => {
    const Order = orderClass();
    delegate(Order.prototype, ["street"], "address");

    expect((new Order() as unknown as { street: string }).street).toBe("Main St");
  });

  it("forwards a method, called on the holder", () => {
    const Order = orderClass();
    delegate(Order.prototype, ["describe"], "address");

    expect((new Order() as unknown as { describe(): string }).describe()).toBe(
      "Main St, Springfield",
    );
  });

  it("forwards several at once", () => {
    const Order = orderClass();
    delegate(Order.prototype, ["street", "city"], "address");
    const order = new Order() as unknown as { street: string; city: string };

    expect(order.street).toBe("Main St");
    expect(order.city).toBe("Springfield");
  });

  it("takes a prefix", () => {
    const Order = orderClass();
    delegate(Order.prototype, ["city"], "address", { prefix: "billing" });

    expect((new Order() as unknown as { billing_city: string }).billing_city).toBe("Springfield");
  });

  /** A silent undefined from a typo reads exactly like a missing value. */
  it("throws when the holder is absent", () => {
    const Order = orderClass();
    delegate(Order.prototype, ["street"], "address");
    const order = new Order();
    order.address = null;

    expect(() => (order as unknown as { street: string }).street).toThrow(/cannot delegate/);
  });

  it("answers undefined instead when allowNil is set", () => {
    const Order = orderClass();
    delegate(Order.prototype, ["street"], "address", { allowNil: true });
    const order = new Order();
    order.address = null;

    expect((order as unknown as { street: string | undefined }).street).toBeUndefined();
  });

  it("defines a real method rather than relying on a proxy", () => {
    const Order = orderClass();
    delegate(Order.prototype, ["street"], "address");

    expect("street" in new Order()).toBe(true);
  });
});

describe("delegateMissingTo", () => {
  it("answers the object's own properties itself", () => {
    const wrapped = delegateMissingTo({ own: 1, inner: { other: 2 } }, "inner");

    expect(wrapped.own).toBe(1);
  });

  it("falls through to the holder", () => {
    const wrapped = delegateMissingTo({ inner: { other: 2 } }, "inner") as unknown as {
      other: number;
    };

    expect(wrapped.other).toBe(2);
  });

  it("binds a forwarded function to the holder", () => {
    const inner = {
      value: 7,
      read(): number {
        return this.value;
      },
    };
    const wrapped = delegateMissingTo({ inner }, "inner") as unknown as { read(): number };

    expect(wrapped.read()).toBe(7);
  });

  it("reports what it can answer", () => {
    const wrapped = delegateMissingTo({ inner: { other: 2 } }, "inner");

    expect("other" in wrapped).toBe(true);
    expect("absent" in wrapped).toBe(false);
  });

  it("gives undefined when the holder is absent", () => {
    const wrapped = delegateMissingTo({ inner: null }, "inner") as unknown as { other?: number };

    expect(wrapped.other).toBeUndefined();
  });
});

describe("namespaces", () => {
  it("names the enclosing namespace", () => {
    expect(moduleParentName("Admin::Users::Post")).toBe("Admin::Users");
  });

  it("gives undefined for a bare name", () => {
    expect(moduleParentName("Post")).toBeUndefined();
  });

  it("lists every enclosing namespace, innermost first", () => {
    expect(moduleParents("Admin::Users::Post")).toEqual(["Admin::Users", "Admin"]);
  });

  it("lists none for a bare name", () => {
    expect(moduleParents("Post")).toEqual([]);
  });
});

describe("instance values", () => {
  it("gives the own enumerable properties", () => {
    class Post {
      title = "Hi";
      draft = true;
    }

    expect(instanceValues(new Post())).toEqual({ title: "Hi", draft: true });
  });

  it("gives their names", () => {
    class Post {
      title = "Hi";
    }

    expect(instanceVariableNames(new Post())).toEqual(["title"]);
  });

  it("leaves methods out", () => {
    class Post {
      title = "Hi";
      read(): string {
        return this.title;
      }
    }

    expect(instanceVariableNames(new Post())).toEqual(["title"]);
  });
});

describe("duplicable", () => {
  it("says no to the immutables", () => {
    expect(duplicable(1)).toBe(false);
    expect(duplicable("a")).toBe(false);
    expect(duplicable(true)).toBe(false);
    expect(duplicable(null)).toBe(false);
    expect(duplicable(undefined)).toBe(false);
    expect(duplicable(Symbol("s"))).toBe(false);
  });

  it("says yes to the rest", () => {
    expect(duplicable({})).toBe(true);
    expect(duplicable([])).toBe(true);
    expect(duplicable(new Date())).toBe(true);
    expect(duplicable(() => {})).toBe(true);
  });
});
