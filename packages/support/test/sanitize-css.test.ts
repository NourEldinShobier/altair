/**
 * Cleaning a style attribute, ported from the `sanitize_css` cases in
 * `rails-html-sanitizer`'s scrubber tests.
 *
 * A rich text editor that lets people set a colour produces inline styles.
 * Dropping them all means the formatting somebody applied silently does not
 * survive being saved; keeping them means keeping only what cannot do
 * anything.
 */

import { describe, expect, it } from "bun:test";
import {
  DEFAULT_ALLOWED_STYLES,
  isAllowedStyleProperty,
  isDangerousStyleValue,
  sanitizeCss,
} from "../src/sanitize-css.js";

describe("what it keeps", () => {
  it("keeps a colour", () => {
    expect(sanitizeCss("color: red")).toBe("color: red");
  });

  it("keeps several", () => {
    expect(sanitizeCss("color: red; font-weight: bold")).toBe("color: red; font-weight: bold");
  });

  it("normalises the property's case and spacing", () => {
    expect(sanitizeCss("  COLOR :  red  ")).toBe("color: red");
  });

  it("keeps a value with a comma in it", () => {
    expect(sanitizeCss("font-family: Helvetica, Arial, sans-serif")).toBe(
      "font-family: Helvetica, Arial, sans-serif",
    );
  });

  it("survives a trailing semicolon", () => {
    expect(sanitizeCss("color: red;")).toBe("color: red");
  });

  it("gives an empty string for an empty attribute", () => {
    expect(sanitizeCss("")).toBe("");
    expect(sanitizeCss("   ")).toBe("");
  });

  it("ignores a declaration with no colon", () => {
    expect(sanitizeCss("color: red; nonsense")).toBe("color: red");
  });

  it("ignores one with no value", () => {
    expect(sanitizeCss("color: ; font-weight: bold")).toBe("font-weight: bold");
  });
});

describe("what it refuses", () => {
  /** Still runs in browsers people use. */
  it("refuses a url", () => {
    expect(sanitizeCss("background-color: url(javascript:alert(1))")).toBe("");
  });

  it("refuses a url however it is spaced", () => {
    expect(sanitizeCss("background-color: url ( x )")).toBe("");
  });

  /** Internet Explorer's own scripting hooks: dead, and free to refuse. */
  it("refuses an expression", () => {
    expect(sanitizeCss("color: expression(alert(1))")).toBe("");
  });

  it("refuses a behavior", () => {
    expect(sanitizeCss("color: behavior: url(x.htc)")).toBe("");
  });

  it("refuses an import", () => {
    expect(sanitizeCss("color: @import 'evil.css'")).toBe("");
  });

  /**
   * `\75 rl(...)` is `url(...)` to a browser and is not `url` to any check
   * looking for the word.
   */
  it("refuses an escape, which can spell anything", () => {
    expect(sanitizeCss("background-color: \\75 rl(evil)")).toBe("");
  });

  /** A closing brace lets a value open a selector of its own. */
  it("refuses a brace", () => {
    expect(sanitizeCss("color: red} body {display: none")).toBe("");
  });

  /**
   * Not script execution, and just as effective: an overlay over the page is
   * how a comment becomes a clickjacking frame.
   */
  it("refuses positioning", () => {
    expect(sanitizeCss("position: fixed; top: 0; width: 100vw")).toBe("");
  });

  it("refuses anything not on the list", () => {
    expect(sanitizeCss("display: none")).toBe("");
    expect(sanitizeCss("z-index: 9999")).toBe("");
    expect(sanitizeCss("opacity: 0")).toBe("");
  });

  /**
   * One bad property must not lose the colour somebody chose, and one good one
   * must not carry a bad one through.
   */
  it("drops only the declaration, not the attribute", () => {
    expect(sanitizeCss("color: red; position: fixed; font-weight: bold")).toBe(
      "color: red; font-weight: bold",
    );
  });

  it("drops an allowed property carrying a dangerous value", () => {
    expect(sanitizeCss("color: red; border: 1px url(evil)")).toBe("color: red");
  });

  it("ignores case when refusing", () => {
    expect(sanitizeCss("color: EXPRESSION(alert(1))")).toBe("");
    expect(sanitizeCss("color: URL(x)")).toBe("");
  });
});

describe("the list itself", () => {
  /** A deny list is a list somebody has to keep up with. */
  it("is a list of what is allowed, not of what is not", () => {
    expect(DEFAULT_ALLOWED_STYLES.has("color")).toBe(true);
    expect(DEFAULT_ALLOWED_STYLES.has("position")).toBe(false);
    expect(DEFAULT_ALLOWED_STYLES.has("background-image")).toBe(false);
  });

  it("can be replaced", () => {
    expect(sanitizeCss("display: none", { allowedStyles: new Set(["display"]) })).toBe(
      "display: none",
    );
  });

  it("still refuses a dangerous value under a custom list", () => {
    expect(sanitizeCss("display: url(evil)", { allowedStyles: new Set(["display"]) })).toBe("");
  });

  it("says whether a property is allowed", () => {
    expect(isAllowedStyleProperty("Color")).toBe(true);
    expect(isAllowedStyleProperty("position")).toBe(false);
  });
});

describe("isDangerousStyleValue", () => {
  /** A form that silently drops half of what somebody typed is one they fight. */
  it("says which values would be refused", () => {
    expect(isDangerousStyleValue("url(x)")).toBe(true);
    expect(isDangerousStyleValue("expression(x)")).toBe(true);
    expect(isDangerousStyleValue("red")).toBe(false);
  });
});
