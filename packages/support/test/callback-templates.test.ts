/**
 * How a callback filter is called, and how a skip narrows one, ported from
 * `activesupport/test/callbacks_test.rb` — the object-filter, conditional and
 * `skip_callback` cases.
 *
 * `callbacks.test.ts` covers ordering, halting and inheritance. These are about
 * the two places the chain resolves something rather than runs it.
 */

import { describe, expect, it } from "bun:test";
import {
  callTemplate,
  callbackMethodName,
  defineCallbacks,
  expandCallTemplate,
  invertedLambda,
  makeLambda,
  mergeConditionalOptions,
  normalizeCallbackParams,
  runCallbacks,
  setCallback,
  skipCallback,
} from "../src/callbacks.js";

class Post {
  audited = false;
  draft = false;
  ran: string[] = [];

  audit(): void {
    this.audited = true;
    this.ran.push("audit");
  }

  isDraft(): boolean {
    return this.draft;
  }
}

describe("calling a filter", () => {
  it("calls a function with the target", async () => {
    const post = new Post();
    const seen: unknown[] = [];

    await makeLambda<Post>((target) => seen.push(target))(post);

    expect(seen).toEqual([post]);
  });

  it("calls a method by name, on the target", async () => {
    const post = new Post();
    await makeLambda<Post>("audit")(post);

    expect(post.audited).toBe(true);
  });

  /** An `around` callback declared as a method name still has to be yielded to. */
  it("passes the block to a method by name", async () => {
    class Wrapping extends Post {
      async wrap(_target: Wrapping, block: () => Promise<unknown>): Promise<void> {
        this.ran.push("in");
        await block();
        this.ran.push("out");
      }
    }

    const post = new Wrapping();
    await makeLambda<Wrapping>("wrap")(post, async () => {
      post.ran.push("body");
    });

    expect(post.ran).toEqual(["in", "body", "out"]);
  });

  it("says so when the named method is not there", async () => {
    await expect(makeLambda<Post>("missing" as never)(new Post())).rejects.toThrow(
      "not a method on the target",
    );
  });

  /**
   * The only filter that can hold state: a method name reaches the record's own
   * methods and a closure is written at the declaration, while an object can be
   * configured once and reused by several models.
   */
  it("calls an object's method named after the callback", async () => {
    const seen: unknown[] = [];
    const auditor = {
      beforeSave: (target: unknown) => seen.push(target),
    };
    const post = new Post();

    await makeLambda<Post>(auditor, "before", "save")(post);

    expect(seen).toEqual([post]);
  });

  it("derives the method name from the kind and the chain", () => {
    expect(callbackMethodName("before", "save")).toBe("beforeSave");
    expect(callbackMethodName("around", "action")).toBe("aroundAction");
  });

  /** One object registered for two callbacks answers each with its own method. */
  it("asks a different method for a different callback", async () => {
    const ran: string[] = [];
    const auditor = {
      beforeSave: () => ran.push("before"),
      afterSave: () => ran.push("after"),
    };

    await makeLambda<Post>(auditor, "before", "save")(new Post());
    await makeLambda<Post>(auditor, "after", "save")(new Post());

    expect(ran).toEqual(["before", "after"]);
  });

  /**
   * Called on the object, not on the record: an object filter exists to hold
   * state, and bound to the record it reads the record's fields instead of its
   * own — which usually finds `undefined` rather than failing.
   */
  it("keeps an object filter's own `this`", async () => {
    const auditor = {
      seen: 0,
      beforeSave(this: { seen: number }): void {
        this.seen += 1;
      },
    };

    await makeLambda<Post>(auditor, "before", "save")(new Post());

    expect(auditor.seen).toBe(1);
  });

  it("says which method an object filter is missing", async () => {
    await expect(makeLambda<Post>({}, "before", "save")(new Post())).rejects.toThrow(
      "must have a beforeSave method",
    );
  });
});

describe("the call, bound but not yet made", () => {
  /**
   * Returned rather than invoked, so one place resolves the filter and another
   * decides what happens around it.
   */
  it("does not run until it is called", async () => {
    const post = new Post();
    const call = expandCallTemplate<Post>("audit", post);

    expect(post.audited).toBe(false);

    await call();

    expect(post.audited).toBe(true);
  });

  it("is the same call each time", async () => {
    const post = new Post();
    const call = expandCallTemplate<Post>("audit", post);
    await call();
    await call();

    expect(post.ran).toEqual(["audit", "audit"]);
  });

  it("passes the block through", async () => {
    const seen: unknown[] = [];
    const block = async () => "inner";

    await expandCallTemplate<Post>((_target, given) => seen.push(given), new Post(), block)();

    expect(seen).toEqual([block]);
  });

  it("resolves once and can be reused", () => {
    const template = callTemplate<Post>("audit");
    const first = new Post();
    const second = new Post();
    template(first);
    template(second);

    expect([first.audited, second.audited]).toEqual([true, true]);
  });
});

describe("a filter, negated", () => {
  /**
   * Its own function rather than a `!` at each call site: a condition negated in
   * one place and not the other is a callback that runs exactly when it should
   * not.
   */
  it("is the opposite of the filter", async () => {
    const post = new Post();

    expect(await invertedLambda<Post>("isDraft")(post)).toBe(true);

    post.draft = true;

    expect(await invertedLambda<Post>("isDraft")(post)).toBe(false);
  });

  it("reads a truthy value as true before negating", async () => {
    expect(await invertedLambda<Post>(() => "yes")(new Post())).toBe(false);
    expect(await invertedLambda<Post>(() => 0)(new Post())).toBe(true);
  });
});

describe("separating filters from options", () => {
  /** A plain object is a legitimate filter, so the ambiguity is real. */
  it("takes a trailing object with option keys as options", () => {
    const condition = () => true;
    const { filters, options } = normalizeCallbackParams<Post>(["audit", { if: condition }]);

    expect(filters).toEqual(["audit"]);
    expect(options).toEqual({ if: condition });
  });

  it("takes an object filter as a filter", () => {
    const auditor = { beforeSave: () => undefined };
    const { filters, options } = normalizeCallbackParams<Post>([auditor], "before", "save");

    expect(filters).toEqual([auditor]);
    expect(options).toEqual({});
  });

  it("takes several filters", () => {
    const { filters } = normalizeCallbackParams<Post>(["audit", "isDraft"]);

    expect(filters).toEqual(["audit", "isDraft"]);
  });

  it("has no options when none were given", () => {
    expect(normalizeCallbackParams<Post>(["audit"]).options).toEqual({});
  });

  /** A trailing object with none of the option keys is a filter, not options. */
  it("does not take any trailing object as options", () => {
    const filter = { anything: 1 };

    expect(normalizeCallbackParams<Post>(["audit", filter])).toEqual({
      filters: ["audit", filter],
      options: {},
    });
  });

  /**
   * An object filter that also happens to carry an option-shaped key is still a
   * filter: it has the method for this callback, which options never do.
   */
  it("keeps an object filter that carries an option-shaped key", () => {
    const filter = { beforeSave: () => undefined, if: () => true };
    const { filters, options } = normalizeCallbackParams<Post>([filter], "before", "save");

    expect(filters).toEqual([filter]);
    expect(options).toEqual({});
  });

  it("takes nothing at all", () => {
    expect(normalizeCallbackParams<Post>([])).toEqual({ filters: [], options: {} });
  });
});

describe("the conditions of a conditional skip", () => {
  /**
   * The conditions swap sides. "Do not run this when it is a draft" is the same
   * callback with `unless: draft` added, and copying them across unchanged would
   * skip the callback exactly when it was meant to keep running.
   */
  it("turns the skip's if into the callback's unless", () => {
    const draft = () => true;

    expect(mergeConditionalOptions<Post>({ if: [], unless: [] }, { if: draft })).toEqual({
      if: [],
      unless: [draft],
    });
  });

  it("turns the skip's unless into the callback's if", () => {
    const published = () => true;

    expect(mergeConditionalOptions<Post>({ if: [], unless: [] }, { unless: published })).toEqual({
      if: [published],
      unless: [],
    });
  });

  it("keeps the conditions the callback already had", () => {
    const existing = () => true;
    const added = () => true;

    expect(mergeConditionalOptions<Post>({ if: [existing], unless: [] }, { if: added })).toEqual({
      if: [existing],
      unless: [added],
    });
  });

  it("takes a list", () => {
    const a = () => true;
    const b = () => true;

    expect(mergeConditionalOptions<Post>({ if: [], unless: [] }, { if: [a, b] }).unless).toEqual([
      a,
      b,
    ]);
  });
});

describe("skipping a callback", () => {
  const chainOn = (): typeof Post => {
    class Audited extends Post {}
    defineCallbacks(Audited, "save");
    setCallback<Post>(Audited, "save", "before", "audit");

    return Audited;
  };

  it("removes it outright when no condition is given", async () => {
    const klass = chainOn();
    skipCallback<Post>(klass, "save", "before", "audit");

    const post = new klass();
    await runCallbacks(post, "save");

    expect(post.audited).toBe(false);
  });

  /**
   * A narrowing, not a deletion: removing it outright would stop the auditing
   * in production because a test wanted it off.
   */
  it("keeps it for the cases the condition does not name", async () => {
    const klass = chainOn();
    skipCallback<Post>(klass, "save", "before", "audit", { if: "isDraft" });

    const draft = new klass();
    draft.draft = true;
    await runCallbacks(draft, "save");

    expect(draft.audited).toBe(false);

    const published = new klass();
    await runCallbacks(published, "save");

    expect(published.audited).toBe(true);
  });

  it("takes an unless the other way round", async () => {
    const klass = chainOn();
    skipCallback<Post>(klass, "save", "before", "audit", { unless: "isDraft" });

    const draft = new klass();
    draft.draft = true;
    await runCallbacks(draft, "save");

    expect(draft.audited).toBe(true);

    const published = new klass();
    await runCallbacks(published, "save");

    expect(published.audited).toBe(false);
  });

  it("still refuses to skip one that is not there", () => {
    const klass = chainOn();

    expect(() => skipCallback<Post>(klass, "save", "before", "isDraft")).toThrow("No before");
    expect(() =>
      skipCallback<Post>(klass, "save", "before", "isDraft", { raise: false }),
    ).not.toThrow();
  });
});

describe("an object as a callback", () => {
  it("runs through the chain", async () => {
    const ran: string[] = [];

    class Audited extends Post {}
    defineCallbacks(Audited, "save");
    setCallback<Post>(Audited, "save", "before", {
      beforeSave: () => ran.push("audited"),
    });

    await runCallbacks(new Audited(), "save");

    expect(ran).toEqual(["audited"]);
  });

  it("receives the record", async () => {
    const seen: unknown[] = [];

    class Audited extends Post {}
    defineCallbacks(Audited, "save");
    setCallback<Post>(Audited, "save", "before", {
      beforeSave: (target: unknown) => seen.push(target),
    });

    const post = new Audited();
    await runCallbacks(post, "save");

    expect(seen).toEqual([post]);
  });
});
