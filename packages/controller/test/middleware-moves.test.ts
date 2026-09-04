/**
 * Reordering a middleware that is already in the stack, ported from
 * `actionpack/test/dispatch/middleware_stack_test.rb`.
 *
 * The case inserting cannot cover: a library adds its own middleware at boot
 * and puts it in the wrong place, and the application has to reorder it
 * knowing only its name.
 */

import { describe, expect, it } from "bun:test";
import { MiddlewareStack, UnknownMiddleware, type Middleware } from "../src/middleware.js";

const nothing: Middleware = async (request, next) => await next(request);

const stackOf = (...names: string[]): MiddlewareStack => {
  const stack = new MiddlewareStack();
  for (const name of names) stack.use(name, nothing);

  return stack;
};

describe("the stack as it stands", () => {
  it("is the entries in order", () => {
    expect(stackOf("a", "b").middlewares.map((entry) => entry.name)).toEqual(["a", "b"]);
  });

  /**
   * A copy: the stack is built once and shared by every request, and an entry
   * spliced out of the array somebody was iterating is a middleware that stops
   * running with nothing to say it did.
   */
  it("cannot be edited by whoever reads it", () => {
    const stack = stackOf("a", "b");
    stack.middlewares.splice(0, 1);

    expect(stack.names).toEqual(["a", "b"]);
  });
});

describe("moving one after another", () => {
  it("puts it directly after the target", () => {
    const stack = stackOf("a", "b", "c");
    stack.moveAfter("c", "a");

    expect(stack.names).toEqual(["b", "c", "a"]);
  });

  /**
   * Removed before the target is located. Located first, the index would be
   * the one before the removal and the entry would land one place too far
   * along — an off-by-one that looks right in a three-entry stack.
   */
  it("lands directly after it when it was already earlier", () => {
    const stack = stackOf("a", "b", "c", "d");
    stack.moveAfter("c", "a");

    expect(stack.names).toEqual(["b", "c", "a", "d"]);
  });

  it("moves one that was later", () => {
    const stack = stackOf("a", "b", "c");
    stack.moveAfter("a", "c");

    expect(stack.names).toEqual(["a", "c", "b"]);
  });

  it("moves one to the end", () => {
    const stack = stackOf("a", "b", "c");
    stack.moveAfter("c", "b");

    expect(stack.names).toEqual(["a", "c", "b"]);
  });

  it("keeps the handler it was registered with", () => {
    const stack = new MiddlewareStack();
    const handler: Middleware = async (request, next) => await next(request);
    stack.use("a", nothing);
    stack.use("b", handler);
    stack.moveAfter("a", "b");

    expect(stack.middlewares[1]?.handler).toBe(handler);
  });

  it("does not change how many there are", () => {
    const stack = stackOf("a", "b", "c");
    stack.moveAfter("a", "c");

    expect(stack.length).toBe(3);
  });

  it("can be chained", () => {
    const stack = stackOf("a", "b", "c");

    expect(stack.moveAfter("a", "c")).toBe(stack);
  });
});

describe("moving one before another", () => {
  it("puts it directly before the target", () => {
    const stack = stackOf("a", "b", "c");
    stack.moveBefore("a", "c");

    expect(stack.names).toEqual(["c", "a", "b"]);
  });

  it("moves one that was earlier", () => {
    const stack = stackOf("a", "b", "c", "d");
    stack.moveBefore("d", "a");

    expect(stack.names).toEqual(["b", "c", "a", "d"]);
  });

  it("moves one to the front", () => {
    const stack = stackOf("a", "b", "c");
    stack.moveBefore("a", "b");

    expect(stack.names).toEqual(["b", "a", "c"]);
  });
});

describe("moving something that is not there", () => {
  it("says so for the one being moved", () => {
    expect(() => stackOf("a").moveAfter("a", "missing")).toThrow(UnknownMiddleware);
  });

  it("says so for the target", () => {
    expect(() => stackOf("a").moveAfter("missing", "a")).toThrow(UnknownMiddleware);
  });

  it("names what it does have", () => {
    expect(() => stackOf("a", "b").moveBefore("missing", "a")).toThrow("a");
  });
});
