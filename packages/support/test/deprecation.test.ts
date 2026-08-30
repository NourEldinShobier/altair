/**
 * Deprecation, ported case-for-case from
 * `activesupport/test/deprecation_test.rb`.
 *
 * The Ruby cases that have no counterpart here are noted where they would have
 * gone rather than quietly dropped: the constant and object proxies need
 * `method_missing`, and `Module::deprecate` needs Ruby's open classes.
 */

import { describe, expect, it } from "bun:test";
import { notifications } from "../src/notifications.js";
import { Deprecator, Deprecators, DeprecationException } from "../src/deprecation.js";

function collect(deprecator: Deprecator, body: () => void): string[] {
  const warnings: string[] = [];
  deprecator.behavior = (message) => warnings.push(message);
  body();
  return warnings;
}

describe("warn", () => {
  it("emits through the configured behavior", () => {
    const deprecator = new Deprecator();

    expect(collect(deprecator, () => deprecator.warn("using fubar is deprecated"))).toHaveLength(1);
  });

  it("includes the message", () => {
    const deprecator = new Deprecator();
    const [warning] = collect(deprecator, () => deprecator.warn("using fubar is deprecated"));

    expect(warning).toContain("using fubar is deprecated");
  });

  it("names the horizon and the library", () => {
    const deprecator = new Deprecator("3.0", "MyGem");
    const [warning] = collect(deprecator, () => deprecator.warn("gone soon"));

    expect(warning).toContain("MyGem");
    expect(warning).toContain("3.0");
  });

  it("has a default message", () => {
    const deprecator = new Deprecator();
    const [warning] = collect(deprecator, () => deprecator.warn());

    expect(warning).toContain("deprecated");
  });

  it("runs every behavior in the list", () => {
    const deprecator = new Deprecator();
    const seen: string[] = [];
    deprecator.behavior = [() => seen.push("one"), () => seen.push("two")];
    deprecator.warn("x");

    expect(seen).toEqual(["one", "two"]);
  });
});

describe("behavior", () => {
  /** Rails: "nil behavior is ignored" — unset config must not silence. */
  it("ignores null rather than treating it as silence", () => {
    const deprecator = new Deprecator();
    const warnings = collect(deprecator, () => {});
    deprecator.behavior = null;
    deprecator.warn("fubar");

    expect(warnings).toHaveLength(1);
  });

  /** Rails: ":raise behavior" */
  it("raises on the raise behavior", () => {
    const deprecator = new Deprecator();
    deprecator.behavior = "raise";

    expect(() => deprecator.warn("Revise this deprecated stuff now!")).toThrow(
      DeprecationException,
    );
  });

  it("carries the message on the raised error", () => {
    const deprecator = new Deprecator();
    deprecator.behavior = "raise";

    expect(() => deprecator.warn("Revise this now!")).toThrow(/Revise this now!/);
  });

  /** Rails: ":silence behavior" */
  it("emits nothing on the silence behavior", () => {
    const deprecator = new Deprecator();
    const logged: string[] = [];
    deprecator.logger = (message) => logged.push(message);
    deprecator.behavior = "silence";
    deprecator.warn("Some error!");

    expect(logged).toEqual([]);
  });

  /** Rails: ":log behavior" */
  it("writes to the logger on the log behavior", () => {
    const deprecator = new Deprecator();
    const logged: string[] = [];
    deprecator.logger = (message) => logged.push(message);
    deprecator.behavior = "log";
    deprecator.warn("Some error!");

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("DEPRECATION WARNING");
  });

  /** Rails: ":notify behavior" */
  it("publishes on the notify behavior", () => {
    const deprecator = new Deprecator("horizon", "MyGem::Custom");
    deprecator.behavior = "notify";

    const seen: unknown[] = [];
    const subscription = notifications.subscribe("deprecation.my_gem_custom", (event) =>
      seen.push(event.payload),
    );

    try {
      deprecator.warn("Some error!");
    } finally {
      subscription.unsubscribe();
    }

    expect(seen).toHaveLength(1);
  });

  /** Rails derives the event name from the gem name the same way. */
  it("derives the event name from the library name", () => {
    expect(new Deprecator("h", "MyGem::Custom").eventName).toBe("my_gem_custom");
  });

  /** Rails: "invalid behavior" raises ArgumentError. */
  it("refuses a behavior it does not know", () => {
    const deprecator = new Deprecator();

    expect(() => {
      deprecator.behavior = "invalid" as never;
    }).toThrow(/Unknown deprecation behavior/);
  });

  it("takes a plain function", () => {
    const deprecator = new Deprecator();
    let called = false;
    deprecator.behavior = () => {
      called = true;
    };
    deprecator.warn("x");

    expect(called).toBe(true);
  });

  it("hands the behavior the deprecator itself", () => {
    const deprecator = new Deprecator("2.0", "Lib");
    let seen: Deprecator | undefined;
    deprecator.behavior = (_message, _stack, from) => {
      seen = from;
    };
    deprecator.warn("x");

    expect(seen).toBe(deprecator);
  });
});

describe("silence", () => {
  /** Rails: "silence" */
  it("starts unsilenced", () => {
    expect(new Deprecator().silenced).toBe(false);
  });

  it("silences within the block", () => {
    const deprecator = new Deprecator();
    const warnings: string[] = [];
    deprecator.behavior = (message) => warnings.push(message);

    deprecator.silence(() => deprecator.warn());

    expect(warnings).toEqual([]);
  });

  it("warns again after the block", () => {
    const deprecator = new Deprecator();
    const warnings: string[] = [];
    deprecator.behavior = (message) => warnings.push(message);

    deprecator.silence(() => deprecator.warn());
    deprecator.warn();

    expect(warnings).toHaveLength(1);
  });

  /** Rails: "silence returns the result of the block" */
  it("returns the result of the block", () => {
    expect(new Deprecator().silence(() => 123)).toBe(123);
  });

  /**
   * Rails: "silence ensures silencing is reverted after an error is raised".
   * A flag you set and unset would leave the process silent for good.
   */
  it("reverts after the block throws", () => {
    const deprecator = new Deprecator();
    const warnings: string[] = [];
    deprecator.behavior = (message) => warnings.push(message);

    expect(() =>
      deprecator.silence(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");

    deprecator.warn();

    expect(warnings).toHaveLength(1);
  });

  it("silences when the flag is set directly", () => {
    const deprecator = new Deprecator();
    const warnings: string[] = [];
    deprecator.behavior = (message) => warnings.push(message);
    deprecator.silenced = true;
    deprecator.warn();

    expect(deprecator.silenced).toBe(true);
    expect(warnings).toEqual([]);
  });

  /**
   * Rails scopes silence to the thread. The counterpart here is the async call
   * chain: without it, an await inside a silenced block would leak the silence
   * to whatever ran while it was suspended.
   */
  it("does not leak to work running outside the block", async () => {
    const deprecator = new Deprecator();
    const warnings: string[] = [];
    deprecator.behavior = (message) => warnings.push(message);

    const outside = new Promise<void>((resolve) => {
      setTimeout(() => {
        deprecator.warn();
        resolve();
      }, 0);
    });

    deprecator.silence(() => deprecator.warn());
    await outside;

    expect(warnings).toHaveLength(1);
  });
});

describe("disallowed warnings", () => {
  /** The escalation path: name the ones whose time is up, not all of them. */
  it("takes the disallowed behavior when it matches", () => {
    const deprecator = new Deprecator();
    deprecator.behavior = "silence";
    deprecator.disallowedBehavior = "raise";
    deprecator.disallowedWarnings = ["fubar"];

    expect(() => deprecator.warn("using fubar is deprecated")).toThrow(DeprecationException);
  });

  it("leaves the rest on the ordinary behavior", () => {
    const deprecator = new Deprecator();
    const warnings: string[] = [];
    deprecator.behavior = (message) => warnings.push(message);
    deprecator.disallowedBehavior = "raise";
    deprecator.disallowedWarnings = ["fubar"];

    deprecator.warn("something else");

    expect(warnings).toHaveLength(1);
  });

  it("matches a pattern too", () => {
    const deprecator = new Deprecator();
    deprecator.behavior = "silence";
    deprecator.disallowedBehavior = "raise";
    deprecator.disallowedWarnings = [/fub.r/];

    expect(() => deprecator.warn("using fubar")).toThrow(DeprecationException);
  });

  it("is still silenced by silence", () => {
    const deprecator = new Deprecator();
    deprecator.disallowedBehavior = "raise";
    deprecator.disallowedWarnings = ["fubar"];

    expect(() => deprecator.silence(() => deprecator.warn("fubar"))).not.toThrow();
  });
});

describe("deprecateMethods", () => {
  /** Rails: "Module::deprecate with method name only" */
  it("warns when the method is called", () => {
    const deprecator = new Deprecator();
    const warnings: string[] = [];
    deprecator.behavior = (message) => warnings.push(message);

    const target = {
      old(): number {
        return 1;
      },
    };
    deprecator.deprecateMethods(target, ["old"]);
    target.old();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("old");
  });

  /** The difference from a removal: the method still works. */
  it("keeps the method working", () => {
    const deprecator = new Deprecator();
    deprecator.behavior = "silence";

    const target = {
      old(a: number, b: number): number {
        return a + b;
      },
    };
    deprecator.deprecateMethods(target, ["old"]);

    expect(target.old(2, 3)).toBe(5);
  });

  /** Rails: "Module::deprecate with alternative method" */
  it("names the replacement", () => {
    const deprecator = new Deprecator();
    const warnings: string[] = [];
    deprecator.behavior = (message) => warnings.push(message);

    const target = {
      old(): number {
        return 1;
      },
    };
    deprecator.deprecateMethods(target, { old: "fresh" });
    target.old();

    expect(warnings[0]).toContain("fresh");
  });

  it("leaves a name that is not a method alone", () => {
    const deprecator = new Deprecator();
    const target = { value: 1 };

    expect(() => deprecator.deprecateMethods(target, ["value"])).not.toThrow();
    expect(target.value).toBe(1);
  });
});

describe("Deprecators", () => {
  /** What makes one policy possible across libraries that each ship their own. */
  it("applies a behavior to every registered deprecator", () => {
    const registry = new Deprecators();
    const one = new Deprecator();
    const two = new Deprecator();
    registry.set("one", one);
    registry.set("two", two);

    registry.behavior = "raise";

    expect(() => one.warn()).toThrow(DeprecationException);
    expect(() => two.warn()).toThrow(DeprecationException);
  });

  it("silences every registered deprecator", () => {
    const registry = new Deprecators();
    const one = new Deprecator();
    registry.set("one", one);

    registry.silenced = true;

    expect(one.silenced).toBe(true);
  });

  it("looks one up by name", () => {
    const registry = new Deprecators();
    const one = new Deprecator();
    registry.set("one", one);

    expect(registry.get("one")).toBe(one);
    expect(registry.get("missing")).toBeUndefined();
    expect(registry.names).toEqual(["one"]);
  });
});
