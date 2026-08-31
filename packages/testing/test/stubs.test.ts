/**
 * Replacing something for the length of one test, ported from
 * `activesupport/test/testing/method_call_assertions_test.rb` and the
 * constant-stubbing cases in `activesupport/test/testing/constant_stubbing_test.rb`.
 *
 * A stub that is not restored does not fail the test that left it — some later
 * test fails instead, and running that one alone makes the symptom disappear.
 * So most of these check what happens *after*.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  UnexpectedCallCount,
  assertCalled,
  assertNotCalled,
  calledWith,
  recorder,
  stubConst,
  stubObject,
  stubbed,
  stubbing,
  unstubAll,
  withStub,
} from "../src/stubs.js";

afterEach(() => {
  unstubAll();
});

describe("replacing a property", () => {
  it("replaces it", () => {
    const target = { name: () => "real" };
    stubObject(target, "name", () => "stubbed");

    expect(target.name()).toBe("stubbed");
  });

  it("puts it back", () => {
    const target = { name: () => "real" };
    const undo = stubObject(target, "name", () => "stubbed");

    undo();

    expect(target.name()).toBe("real");
  });

  /**
   * Deleting a property the target did not own and then assigning `undefined`
   * back would shadow the prototype's version forever — a stub that never
   * really ends.
   */
  it("removes a property the target did not own", () => {
    class Base {
      name(): string {
        return "inherited";
      }
    }
    const target = new Base();
    const undo = stubObject(target, "name", () => "stubbed");

    undo();

    expect(Object.hasOwn(target, "name")).toBe(false);
    expect(target.name()).toBe("inherited");
  });

  it("restores an own property to its value", () => {
    const target = { count: 1 };
    const undo = stubObject(target, "count", 2);

    undo();

    expect(target.count).toBe(1);
    expect(Object.hasOwn(target, "count")).toBe(true);
  });

  /**
   * Idempotent: a test that restores explicitly *and* has a teardown must not
   * put the stub back on the second call.
   */
  it("restores only once", () => {
    const target = { name: "real" };
    const undo = stubObject(target, "name", "stubbed");

    undo();
    target.name = "changed since";
    undo();

    expect(target.name).toBe("changed since");
  });
});

describe("replacing an entry in a registry", () => {
  it("replaces it", () => {
    const registry = new Map<string, unknown>([["Post", "real"]]);
    stubConst(registry, "Post", "stubbed");

    expect(registry.get("Post")).toBe("stubbed");
  });

  it("puts it back", () => {
    const registry = new Map<string, unknown>([["Post", "real"]]);
    stubConst(registry, "Post", "stubbed")();

    expect(registry.get("Post")).toBe("real");
  });

  /** One that was not there has to be removed, not set to undefined. */
  it("removes one that was not there", () => {
    const registry = new Map<string, unknown>();
    stubConst(registry, "Post", "stubbed")();

    expect(registry.has("Post")).toBe(false);
  });

  it("restores only once", () => {
    const registry = new Map<string, unknown>([["Post", "real"]]);
    const undo = stubConst(registry, "Post", "stubbed");

    undo();
    registry.set("Post", "changed since");
    undo();

    expect(registry.get("Post")).toBe("changed since");
  });
});

describe("the safety net", () => {
  it("says when nothing is stubbed", () => {
    expect(stubbing()).toBe(false);
    expect(stubbed()).toEqual([]);
  });

  it("says what is stubbed", () => {
    const target = { name: "real" };
    stubObject(target, "name", "stubbed");

    expect(stubbing()).toBe(true);
    expect(stubbed()).toEqual([{ target: "Object", property: "name" }]);
  });

  /**
   * A teardown reporting a leak has to report what is *still* stubbed. Listing
   * one already put back turns the safety net into a source of false alarms,
   * and a warning nobody believes is a warning nobody reads.
   */
  it("stops reporting one that has been restored", () => {
    const target = { name: "real" };
    stubObject(target, "name", "stubbed")();

    expect(stubbing()).toBe(false);
    expect(stubbed()).toEqual([]);
  });

  /** The case a suite's teardown exists for: a test that threw before its own cleanup. */
  it("puts everything back", () => {
    const first = { a: 1 };
    const second = { b: 2 };
    stubObject(first, "a", 99);
    stubObject(second, "b", 99);

    expect(unstubAll()).toBe(2);
    expect(first.a).toBe(1);
    expect(second.b).toBe(2);
  });

  /**
   * In reverse: two stubs of one property have to unwind the way they were
   * applied, or the first restore puts back the *second* stub's value.
   */
  it("unwinds two stubs of one property in order", () => {
    const target = { name: "real" };
    stubObject(target, "name", "first");
    stubObject(target, "name", "second");

    unstubAll();

    expect(target.name).toBe("real");
  });

  it("counts nothing when nothing is stubbed", () => {
    expect(unstubAll()).toBe(0);
  });

  it("does not double-count one already restored", () => {
    const target = { a: 1 };
    stubObject(target, "a", 99)();

    expect(unstubAll()).toBe(0);
  });

  it("restores registry entries too", () => {
    const registry = new Map<string, unknown>([["Post", "real"]]);
    stubConst(registry, "Post", "stubbed");

    unstubAll();

    expect(registry.get("Post")).toBe("real");
  });
});

describe("running a body with a stub", () => {
  it("stubs for the body only", async () => {
    const target = { name: "real" };

    await withStub(target, "name", "stubbed", () => {
      expect(target.name).toBe("stubbed");
    });

    expect(target.name).toBe("real");
  });

  /** A body that throws is exactly when a test's own cleanup does not run. */
  it("restores when the body throws", async () => {
    const target = { name: "real" };

    await expect(
      withStub(target, "name", "stubbed", () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(target.name).toBe("real");
  });

  it("hands back what the body returned", async () => {
    expect(await withStub({ a: 1 }, "a", 2, () => 7)).toBe(7);
  });
});

describe("recording calls", () => {
  it("counts them", () => {
    const stub = recorder();
    stub();
    stub();

    expect(stub.calls).toHaveLength(2);
  });

  /**
   * Arguments, not only a count: "was it called" is rarely the question, and a
   * count cannot tell a right call from a wrong one.
   */
  it("records the arguments", () => {
    const stub = recorder();
    stub(7, "a");

    expect(stub.calls[0]?.args).toEqual([7, "a"]);
  });

  it("returns a fixed value", () => {
    expect(recorder("value")()).toBe("value");
  });

  it("returns a computed one", () => {
    const stub = recorder((left: number, right: number) => left + right);

    expect(stub(2, 3)).toBe(5);
    expect(stub.calls[0]?.result).toBe(5);
  });

  it("counts calls matching a predicate", () => {
    const stub = recorder();
    stub(7);
    stub(8);

    expect(calledWith(stub, ([first]) => first === 7)).toBe(1);
  });

  it("passes an assertion on the count", () => {
    const stub = recorder();
    stub();

    expect(() => assertCalled("save", stub)).not.toThrow();
  });

  it("fails one that does not match", () => {
    const stub = recorder();

    expect(() => assertCalled("save", stub)).toThrow(UnexpectedCallCount);
  });

  it("says what it expected and what it saw", () => {
    const stub = recorder();
    stub();
    stub();

    expect(() => assertCalled("save", stub)).toThrow("1 time");
    expect(() => assertCalled("save", stub)).toThrow("not 2");
  });

  it("asserts a call never happened", () => {
    const stub = recorder();

    expect(() => assertNotCalled("save", stub)).not.toThrow();

    stub();

    expect(() => assertNotCalled("save", stub)).toThrow(UnexpectedCallCount);
  });

  it("takes an expected count", () => {
    const stub = recorder();
    stub();
    stub();

    expect(() => assertCalled("save", stub, 2)).not.toThrow();
  });
});
