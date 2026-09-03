/**
 * `escapeJavascript`, ported from `JS_ESCAPE_MAP` and `escape_javascript` in
 * `actionview/lib/action_view/helpers/javascript_helper.rb`.
 *
 * Three entries from Rails' map were missing, and one of them is the reason
 * the helper exists. A browser scans a script block for `</script` in the raw
 * bytes, without parsing the JavaScript around it, so a value holding that
 * sequence ends the tag from inside a string literal and everything after it
 * is markup the page runs.
 *
 * `javascriptTag` already refused a body containing `</script` outright, so
 * the framework knew about the hazard in one place and not in the other — and
 * this is the place for a value going into a script somebody else wrote,
 * which is the ordinary case.
 */

import { describe, expect, it } from "bun:test";
import { escapeJavascript } from "../src/meta_tags.js";

describe("ending the script tag", () => {
  it("cannot close it from inside a string", () => {
    const escaped = escapeJavascript("</script><script>alert(1)</script>");

    expect(escaped).not.toContain("</script");
    expect(escaped).toBe("<\\/script><script>alert(1)<\\/script>");
  });

  /** Any `</`, not just `</script`: a browser is not fussy about what follows. */
  it("escapes every closing sequence", () => {
    expect(escapeJavascript("a </b> c")).toBe("a <\\/b> c");
  });

  it("leaves a lone `<` alone, which is a comparison", () => {
    expect(escapeJavascript("a < b")).toBe("a < b");
  });
});

describe("a template literal's interpolation", () => {
  /**
   * `$` is literal in a quoted JavaScript string and not in a backtick one, so
   * a value written into a template literal carries `${…}` into an expression
   * its author never wrote.
   */
  it("cannot start one", () => {
    expect(escapeJavascript("${alert(1)}")).toBe("\\${alert(1)}");
  });

  it("escapes a backtick too, so the literal cannot be ended", () => {
    expect(escapeJavascript("a`b")).toBe("a\\`b");
  });
});

describe("newlines", () => {
  /** One escape for a CRLF, not two: Rails matches the pair before the parts. */
  it("reads a Windows newline as one", () => {
    expect(escapeJavascript("a\r\nb")).toBe("a\\nb");
  });

  it("reads a bare carriage return as one", () => {
    expect(escapeJavascript("a\rb")).toBe("a\\nb");
  });

  it("reads a bare newline as one", () => {
    expect(escapeJavascript("a\nb")).toBe("a\\nb");
  });

  it("keeps two real newlines as two", () => {
    expect(escapeJavascript("a\n\nb")).toBe("a\\n\\nb");
  });
});

describe("what was already handled", () => {
  it("escapes a backslash first, so nothing it produces is escaped again", () => {
    expect(escapeJavascript("a\\b")).toBe("a\\\\b");
    expect(escapeJavascript("a\\nb")).toBe("a\\\\nb");
  });

  it("escapes both quotes", () => {
    expect(escapeJavascript(`he said "no" and 'yes'`)).toBe(`he said \\"no\\" and \\'yes\\'`);
  });

  /**
   * Both are legal inside a JSON string and both end a JavaScript line, so a
   * value carrying one is a syntax error in the script that embeds it.
   */
  it("escapes the line separators", () => {
    expect(escapeJavascript("a b")).toBe("a&#x2028;b");
    expect(escapeJavascript("a b")).toBe("a&#x2029;b");
  });
});

describe("ordinary text", () => {
  it("passes through untouched", () => {
    expect(escapeJavascript("hello world")).toBe("hello world");
  });

  it("handles an empty string", () => {
    expect(escapeJavascript("")).toBe("");
  });
});
