/**
 * What has to happen when per-request state ends, ported from
 * `activesupport/test/current_attributes_test.rb` — the `before_reset`,
 * `resets` and `clear_all` cases.
 *
 * `current.test.ts` covers the scope itself. These are about the state that
 * lives *outside* it and has to be put back, which is the part whose absence
 * produces a wrong answer rather than an error.
 */

import { describe, expect, it } from "bun:test";
import {
  currentAttributes,
  currentAttributesInstances,
  resetAllCurrentAttributes,
} from "../src/current.js";

interface State {
  user?: string;
  timeZone?: string;
}

describe("hooks around a reset", () => {
  /** "Remember who this was for" cannot be answered after the answer is gone. */
  it("runs a before hook while the values are still readable", async () => {
    const Current = currentAttributes<State>();
    const seen: (string | undefined)[] = [];
    Current.beforeReset(() => seen.push(Current.get("user")));

    await Current.run({ user: "ada" }, () => {
      Current.reset();
    });

    expect(seen).toEqual(["ada"]);
  });

  /**
   * The reason this is not simply "clear the object": setting `Current.user`
   * often sets something outside it — a time zone, a locale, a logger tag — and
   * that is what has to be put back.
   */
  it("runs an after hook once they are gone", async () => {
    const Current = currentAttributes<State>();
    const seen: string[] = [];
    Current.resets(() => seen.push(String(Current.get("user"))));

    await Current.run({ user: "ada" }, () => {
      Current.reset();
    });

    expect(seen).toEqual(["undefined"]);
  });

  it("runs them in that order", async () => {
    const Current = currentAttributes<State>();
    const order: string[] = [];
    Current.beforeReset(() => order.push("before"));
    Current.resets(() => order.push("after"));

    await Current.run({}, () => {
      Current.reset();
    });

    expect(order).toEqual(["before", "after"]);
  });

  it("runs every hook of each kind, in the order they were added", async () => {
    const Current = currentAttributes<State>();
    const order: string[] = [];
    Current.resets(() => order.push("first"));
    Current.resets(() => order.push("second"));

    await Current.run({}, () => {
      Current.reset();
    });

    expect(order).toEqual(["first", "second"]);
  });

  /**
   * Unconditional: a hook that puts back a time zone has to run whether or not
   * this request set one, because the request before it may have.
   */
  it("runs an after hook even when nothing was set", async () => {
    const Current = currentAttributes<State>();
    let ran = 0;
    Current.resets(() => {
      ran += 1;
    });

    await Current.run({}, () => {
      Current.reset();
    });

    expect(ran).toBe(1);
  });
});

describe("being told an attribute was written", () => {
  /**
   * For something that mirrors the value rather than reading it on demand: a
   * log formatter holding the request id, an error reporter's context. Copied
   * once, those keep whatever the attribute held when they were built.
   */
  it("fires on a direct write", async () => {
    const Current = currentAttributes<State>();
    const seen: (string | undefined)[] = [];
    Current.afterChange(() => seen.push(Current.get("user")));

    await Current.run({}, () => {
      (Current as unknown as State).user = "ada";
    });

    expect(seen).toEqual(["ada"]);
  });

  it("fires on a set of several values", async () => {
    const Current = currentAttributes<State>();
    let changes = 0;
    Current.afterChange(() => {
      changes += 1;
    });

    await Current.run({}, () => {
      Current.set({ user: "ada", timeZone: "UTC" });
    });

    expect(changes).toBe(1);
  });

  /** A reset is a change too: whatever mirrored the value has to drop it. */
  it("fires on a reset", async () => {
    const Current = currentAttributes<State>();
    // Recorded as text rather than as the value itself: an array holding one
    // `undefined` compares equal to an empty one, so a hook that never ran
    // would look the same as one that ran and saw nothing.
    const seen: string[] = [];
    Current.afterChange(() => seen.push(String(Current.get("user"))));

    await Current.run({ user: "ada" }, () => {
      Current.reset();
    });

    expect(seen).toEqual(["undefined"]);
  });

  it("does not fire for a class that was not written to", async () => {
    const Current = currentAttributes<State>();
    let changes = 0;
    Current.afterChange(() => {
      changes += 1;
    });

    await Current.run({ user: "ada" }, () => undefined);

    expect(changes).toBe(0);
  });
});

describe("every one of them", () => {
  /**
   * A registry, because whatever ends a request does not know what the
   * application declared: three of these and a server that resets only the ones
   * the framework knows about leaks the other two into the next request.
   */
  it("is remembered as it is built", () => {
    const before = currentAttributesInstances().length;
    currentAttributes<State>();

    expect(currentAttributesInstances().length).toBe(before + 1);
  });

  it("is reset together", async () => {
    const First = currentAttributes<State>();
    const Second = currentAttributes<State>();

    await First.run({ user: "ada" }, async () => {
      await Second.run({ user: "grace" }, () => {
        resetAllCurrentAttributes();

        expect(First.get("user")).toBeUndefined();
        expect(Second.get("user")).toBeUndefined();
      });
    });
  });

  it("runs each one's hooks", async () => {
    const Current = currentAttributes<State>();
    const order: string[] = [];
    Current.beforeReset(() => order.push("before"));
    Current.resets(() => order.push("after"));

    await Current.run({ user: "ada" }, () => {
      resetAllCurrentAttributes();
    });

    expect(order).toEqual(["before", "after"]);
  });

  /**
   * A job that finished before it started a scope should not fail in its
   * teardown.
   */
  it("does nothing for one with no scope", () => {
    currentAttributes<State>();

    expect(() => resetAllCurrentAttributes()).not.toThrow();
  });
});
