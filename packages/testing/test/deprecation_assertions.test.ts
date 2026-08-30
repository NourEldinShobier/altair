/**
 * Deprecation assertions, ported from the `assert_deprecated` /
 * `collect_deprecations` cases in
 * `activesupport/test/deprecation_test.rb`.
 */

import { describe, expect, it } from "bun:test";
import { AssertionFailed, Deprecator } from "@altair/support";
import {
  assertDeprecated,
  assertNotDeprecated,
  collectDeprecations,
} from "../src/deprecation_assertions.js";

describe("assertDeprecated", () => {
  /** Rails: "assert_deprecated" */
  it("passes on a matching pattern", () => {
    const deprecator = new Deprecator();

    expect(() =>
      assertDeprecated(deprecator, /fubar/, () => deprecator.warn("using fubar is deprecated")),
    ).not.toThrow();
  });

  it("passes on a matching substring", () => {
    const deprecator = new Deprecator();

    expect(() =>
      assertDeprecated(deprecator, "fubar", () => deprecator.warn("using fubar is deprecated")),
    ).not.toThrow();
  });

  /** Rails: "assert_deprecated without match argument" */
  it("passes on any warning when no match is given", () => {
    const deprecator = new Deprecator();

    expect(() => assertDeprecated(deprecator, () => deprecator.warn("whatever"))).not.toThrow();
  });

  /** Rails: "assert_deprecated raises when no deprecation warning" */
  it("fails when nothing was deprecated", () => {
    const deprecator = new Deprecator();

    expect(() => assertDeprecated(deprecator, () => 1 + 1)).toThrow(AssertionFailed);
  });

  it("fails when the warning does not match", () => {
    const deprecator = new Deprecator();

    expect(() =>
      assertDeprecated(deprecator, /nope/, () => deprecator.warn("something else")),
    ).toThrow(/No deprecation warning matched/);
  });

  /** Rails: "assert_deprecated matches any warning from block" */
  it("matches any one of several warnings", () => {
    const deprecator = new Deprecator();

    expect(() =>
      assertDeprecated(deprecator, /second/, () => {
        deprecator.warn("first thing");
        deprecator.warn("second thing");
      }),
    ).not.toThrow();
  });

  /** Rails: "assert_deprecated returns the result of the block" */
  it("returns the result of the block", () => {
    const deprecator = new Deprecator();
    const result = assertDeprecated(deprecator, () => {
      deprecator.warn();
      return 123;
    });

    expect(result).toBe(123);
  });

  /**
   * Rails scopes each assertion to one deprecator, which is what lets a test
   * assert its own code is clean while a dependency goes on warning.
   */
  it("ignores another deprecator's warnings", () => {
    const mine = new Deprecator();
    const theirs = new Deprecator();
    theirs.behavior = "silence";

    expect(() => assertDeprecated(mine, () => theirs.warn("not mine"))).toThrow(AssertionFailed);
  });
});

describe("assertNotDeprecated", () => {
  /** Rails: "assert_not_deprecated" */
  it("passes when nothing was deprecated", () => {
    const deprecator = new Deprecator();

    expect(() => assertNotDeprecated(deprecator, () => 1 + 1)).not.toThrow();
  });

  /** Rails: "assert_not_deprecated raises when some deprecation warning" */
  it("fails when something was", () => {
    const deprecator = new Deprecator();

    expect(() => assertNotDeprecated(deprecator, () => deprecator.warn("x"))).toThrow(
      AssertionFailed,
    );
  });

  it("names how many it saw", () => {
    const deprecator = new Deprecator();

    expect(() =>
      assertNotDeprecated(deprecator, () => {
        deprecator.warn("a");
        deprecator.warn("b");
      }),
    ).toThrow(/received 2/);
  });

  /** Rails: "assert_not_deprecated returns the result of the block" */
  it("returns the result of the block", () => {
    expect(assertNotDeprecated(new Deprecator(), () => 123)).toBe(123);
  });

  it("ignores another deprecator's warnings", () => {
    const mine = new Deprecator();
    const theirs = new Deprecator();
    theirs.behavior = "silence";

    expect(() => assertNotDeprecated(mine, () => theirs.warn("not mine"))).not.toThrow();
  });
});

describe("collectDeprecations", () => {
  /**
   * Rails: "collect_deprecations returns the return value of the block and the
   * deprecations collected".
   */
  it("gives back the result and the warnings", () => {
    const deprecator = new Deprecator();
    const { result, warnings } = collectDeprecations(deprecator, () => {
      deprecator.warn();
      return "result";
    });

    expect(result).toBe("result");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("deprecated");
  });

  it("collects nothing when nothing warned", () => {
    const deprecator = new Deprecator();

    expect(collectDeprecations(deprecator, () => 1).warnings).toEqual([]);
  });

  /**
   * Restored in a finally: otherwise one failing test leaves every later
   * deprecation collected into an array nobody reads, and the whole file goes
   * quiet.
   */
  it("restores the behavior after the block throws", () => {
    const deprecator = new Deprecator();
    const seen: string[] = [];
    deprecator.behavior = (message) => seen.push(message);

    expect(() =>
      collectDeprecations(deprecator, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");

    deprecator.warn("after");

    expect(seen).toHaveLength(1);
  });

  it("restores the behavior after a passing block too", () => {
    const deprecator = new Deprecator();
    const seen: string[] = [];
    deprecator.behavior = (message) => seen.push(message);

    collectDeprecations(deprecator, () => deprecator.warn("inside"));
    deprecator.warn("after");

    expect(seen).toEqual([expect.stringContaining("after")]);
  });
});
