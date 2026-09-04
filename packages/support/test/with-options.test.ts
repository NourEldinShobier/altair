/**
 * `withOptions`, ported from `activesupport/test/option_merger_test.rb` and
 * the examples in
 * `activesupport/lib/active_support/core_ext/object/with_options.rb`.
 *
 * Every case below is one of Rails' own, with the receiver made explicit
 * because there is no implicit one here.
 */

import { describe, expect, it } from "bun:test";
import { withOptions } from "../src/with-options.js";

/** Rails' `method_with_options(options = {})`: hands back what it was given. */
const context = {
  options(options: Record<string, unknown> = {}): Record<string, unknown> {
    return options;
  },
  args(...given: unknown[]): unknown[] {
    return given;
  },
};

const defaults = { hello: "world" };

describe("merging", () => {
  it("adds the defaults to the options a call passes", () => {
    const merged = withOptions(context, defaults).options({ cool: true });

    expect(merged).toEqual({ hello: "world", cool: true });
  });

  it("leaves a call made on the context itself alone", () => {
    expect(context.options({ cool: true })).toEqual({ cool: true });
  });

  it("supplies the options when the call passes none", () => {
    expect(withOptions(context, defaults).options()).toEqual({ hello: "world" });
  });

  /**
   * A fresh object each time. Rails' `assert_not_same`: an association
   * declaration keeps the hash it was handed, so a shared one would let the
   * first declaration to write to it change every later call.
   */
  it("hands out a copy, not the defaults themselves", () => {
    const merger = withOptions(context, defaults);

    expect(merger.options()).not.toBe(merger.options());
    expect(merger.options()).not.toBe(defaults);
  });

  it("keeps a non-object last argument as an argument", () => {
    expect(withOptions(context, defaults).args("first", 2)).toEqual([
      "first",
      2,
      { hello: "world" },
    ]);
  });

  it("merges into the last argument when earlier ones are not options", () => {
    expect(withOptions(context, defaults).args("first", { cool: true })).toEqual([
      "first",
      { hello: "world", cool: true },
    ]);
  });
});

describe("who wins", () => {
  /** The whole point of a default: the one call that differs says so. */
  it("gives the call the last word", () => {
    expect(withOptions(context, defaults).options({ hello: "moon" })).toEqual({ hello: "moon" });
  });

  it("goes the other way round when the roles are swapped", () => {
    expect(withOptions(context, { hello: "moon" }).options(defaults)).toEqual({ hello: "world" });
  });
});

describe("nested objects", () => {
  it("merges rather than replaces", () => {
    const outer = withOptions(context, { conditions: { method: "get" } });
    const inner = withOptions(outer, { conditions: { domain: "www" } });

    expect(inner.options()).toEqual({ conditions: { method: "get", domain: "www" } });
  });

  it("lets the nearer default overwrite the further one", () => {
    const outer = withOptions(context, { conditions: { method: "get", domain: "www" } });
    const inner = withOptions(outer, { conditions: { method: "post" } });

    expect(inner.options()).toEqual({ conditions: { method: "post", domain: "www" } });
  });

  it("goes as deep as the objects do", () => {
    const outer = withOptions(context, {
      html: { class: "foo", style: { margin: 0, display: "block" } },
    });
    const inner = withOptions(outer, {
      html: { title: "bar", style: { margin: "1em", color: "#fff" } },
    });

    expect(inner.options()).toEqual({
      html: {
        class: "foo",
        title: "bar",
        style: { margin: "1em", display: "block", color: "#fff" },
      },
    });
  });

  it("leaves the outer defaults untouched for the next call through them", () => {
    const outer = withOptions(context, { conditions: { method: "get" } });

    withOptions(outer, { conditions: { domain: "www" } }).options();

    expect(outer.options()).toEqual({ conditions: { method: "get" } });
  });
});

describe("a function on its own", () => {
  /**
   * A scope's body produces its options when it runs, so the defaults have to
   * reach the value it returns rather than sit beside it as an argument.
   */
  it("gets the defaults folded into what it returns", () => {
    const body = (): Record<string, unknown> => ({ scoped: true });
    const wrapped = withOptions(context, defaults).args(body)[0] as () => unknown;

    expect(wrapped()).toEqual({ hello: "world", scoped: true });
  });

  it("is passed its own arguments through", () => {
    const body = (id: number): Record<string, unknown> => ({ id });
    const wrapped = withOptions(context, defaults).args(body)[0] as (id: number) => unknown;

    expect(wrapped(7)).toEqual({ hello: "world", id: 7 });
  });

  /** With anything beside it, it is an ordinary argument again. */
  it("is left alone when it is not the only argument", () => {
    const body = (): void => {};
    const given = withOptions(context, defaults).args(body, { cool: true });

    expect(given[0]).toBe(body);
    expect(given[1]).toEqual({ hello: "world", cool: true });
  });
});

describe("the context", () => {
  it("reads non-method properties straight through", () => {
    const settings = { name: "reader", options: (o = {}) => o };

    expect(withOptions(settings, defaults).name).toBe("reader");
  });

  /**
   * Applied to the real object rather than to the proxy, or a method reading a
   * private field of its own throws `TypeError` on the first call.
   */
  it("keeps a method's own receiver", () => {
    class Counter {
      #count = 0;

      bump(options: Record<string, unknown> = {}): Record<string, unknown> {
        this.#count += 1;

        return { ...options, count: this.#count };
      }
    }

    const counter = new Counter();

    expect(withOptions(counter, defaults).bump()).toEqual({ hello: "world", count: 1 });
  });

  it("is what the call actually reaches", () => {
    const seen: unknown[] = [];
    const recorder = {
      record(options: Record<string, unknown> = {}): void {
        seen.push(options);
      },
    };

    withOptions(recorder, defaults).record({ cool: true });

    expect(seen).toEqual([{ hello: "world", cool: true }]);
  });
});
