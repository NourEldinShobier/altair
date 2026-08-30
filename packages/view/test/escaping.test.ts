/**
 * The escaping helpers, ported from
 * `actionview/test/template/output_safety_helper_test.rb` and
 * `activesupport/test/core_ext/string_ext_test.rb`.
 *
 * These four are not interchangeable, and every test here is about the seam
 * between them.
 */

import { describe, expect, it } from "bun:test";
import { escapeHtml, raw } from "../src/render.js";
import { htmlEscapeOnce, jsonEscape, safeJoin } from "../src/escaping.js";

describe("htmlEscapeOnce", () => {
  it("escapes what is not escaped yet", () => {
    expect(htmlEscapeOnce("1 < 2")).toBe("1 &lt; 2");
  });

  /** The reason it exists: plain escaping spells the entity out on the page. */
  it("leaves a named entity alone", () => {
    expect(htmlEscapeOnce("Fish &amp; Chips")).toBe("Fish &amp; Chips");
  });

  it("leaves a decimal numeric entity alone", () => {
    expect(htmlEscapeOnce("&#39;")).toBe("&#39;");
  });

  it("leaves a hex numeric entity alone", () => {
    expect(htmlEscapeOnce("&#x27;")).toBe("&#x27;");
  });

  it("escapes a bare ampersand that is not starting an entity", () => {
    expect(htmlEscapeOnce("Fish & Chips")).toBe("Fish &amp; Chips");
  });

  it("escapes an ampersand followed by an unterminated entity", () => {
    expect(htmlEscapeOnce("&amp")).toBe("&amp;amp");
  });

  it("still escapes angle brackets around an intact entity", () => {
    expect(htmlEscapeOnce("<b>&amp;</b>")).toBe("&lt;b&gt;&amp;&lt;/b&gt;");
  });

  /** Contrast with the plain escaper, which is the whole point of the pair. */
  it("differs from escapeHtml exactly on already-escaped text", () => {
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
    expect(htmlEscapeOnce("&amp;")).toBe("&amp;");
  });
});

describe("jsonEscape", () => {
  /**
   * The attack it stops: `</script>` survives JSON.stringify intact, closes
   * the tag early, and everything after it parses as markup.
   */
  it("neutralises a closing script tag", () => {
    const json = JSON.stringify({ bio: "</script><script>alert(1)</script>" });

    expect(jsonEscape(json)).not.toContain("</script>");
  });

  it("escapes the angle brackets", () => {
    expect(jsonEscape('"<>"')).toBe('"\\u003c\\u003e"');
  });

  it("escapes the ampersand", () => {
    expect(jsonEscape('"&"')).toBe('"\\u0026"');
  });

  /** U+2028 and U+2029 are legal in JSON but terminate a JavaScript line. */
  it("escapes the line and paragraph separators", () => {
    expect(jsonEscape('"\u2028\u2029"')).toBe('"\\u2028\\u2029"');
  });

  /** Escaping must not change what the JSON means. */
  it("parses back to the same value", () => {
    const original = { bio: "a </script> & b \u2028" };

    expect(JSON.parse(jsonEscape(JSON.stringify(original)))).toEqual(original);
  });

  it("leaves ordinary JSON untouched", () => {
    expect(jsonEscape('{"a":1}')).toBe('{"a":1}');
  });
});

describe("safeJoin", () => {
  it("escapes the plain strings", () => {
    expect(safeJoin(["<b>", "<i>"]).value).toBe("&lt;b&gt;&lt;i&gt;");
  });

  it("passes raw parts through untouched", () => {
    expect(safeJoin([raw("<b>bold</b>")]).value).toBe("<b>bold</b>");
  });

  /** The mix is the case that goes wrong with a plain join. */
  it("escapes the plain parts even when a raw one is present", () => {
    expect(safeJoin([raw("<b>"), "<script>"]).value).toBe("<b>&lt;script&gt;");
  });

  it("escapes a plain separator", () => {
    expect(safeJoin(["a", "b"], " & ").value).toBe("a &amp; b");
  });

  it("passes a raw separator through", () => {
    expect(safeJoin(["a", "b"], raw("<br>")).value).toBe("a<br>b");
  });

  it("gives an empty result for no parts", () => {
    expect(safeJoin([]).value).toBe("");
  });
});
