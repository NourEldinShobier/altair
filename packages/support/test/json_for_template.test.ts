/**
 * JSON on its way into a page, ported from
 * `activesupport/test/json/encoding_test.rb` and the `json_escape` cases in
 * `actionview/test/template/erb_util_test.rb`.
 *
 * Two different failures, escaped by two different rules: a value that closes
 * the script tag it is sitting in, and a value that stops the script parsing
 * at all.
 */

import { describe, expect, it } from "bun:test";
import { encodeForTemplate, escapeJsSeparators, htmlEscape } from "../src/json_encoding.js";

const SEPARATOR = "\u2028";
const PARAGRAPH = "\u2029";

describe("a value that could close the script tag", () => {
  it("escapes the characters that end one", () => {
    expect(htmlEscape('{"a":"</script>"}')).toBe('{"a":"\\u003c/script\\u003e"}');
  });

  it("escapes an ampersand too", () => {
    expect(htmlEscape('{"a":"&"}')).toBe('{"a":"\\u0026"}');
  });

  /**
   * Escaped as JSON unicode sequences rather than HTML entities: `&lt;` inside
   * a JSON string is four characters that parse back as `&lt;`, so the value
   * the page reads is no longer the value the server sent.
   */
  it("leaves the parsed value unchanged", () => {
    const json = JSON.stringify({ name: "</script><script>alert(1)</script>" });

    expect(JSON.parse(htmlEscape(json))).toEqual(JSON.parse(json));
  });
});

describe("a value that stops the script parsing", () => {
  /**
   * U+2028 and U+2029 are legal in a JSON string and illegal in a JavaScript
   * string literal, so inlined JSON stops parsing the moment a value contains
   * one — a syntax error on the whole page, from a character pasted out of a
   * word processor.
   */
  it("escapes the line separators", () => {
    expect(escapeJsSeparators(`a${SEPARATOR}b`)).toBe("a\\u2028b");
    expect(escapeJsSeparators(`a${PARAGRAPH}b`)).toBe("a\\u2029b");
  });

  it("leaves everything else alone", () => {
    expect(escapeJsSeparators('{"a":"<&>"}')).toBe('{"a":"<&>"}');
  });

  /**
   * Separate from the HTML escaping because the two answer different
   * questions, and an application that decided it does not need the first
   * still needs the second.
   */
  it("is not the html escaping", () => {
    expect(htmlEscape(`a${SEPARATOR}b`)).toBe(`a${SEPARATOR}b`);
  });
});

describe("json going into a document", () => {
  it("applies both escapes", () => {
    const json = JSON.stringify({ name: "</script>", note: `a${SEPARATOR}b` });

    expect(encodeForTemplate(json)).toBe('{"name":"\\u003c/script\\u003e","note":"a\\u2028b"}');
  });

  it("still parses back to the same value", () => {
    const json = JSON.stringify({ name: "</script>", note: `a${PARAGRAPH}b` });

    expect(JSON.parse(encodeForTemplate(json))).toEqual(JSON.parse(json));
  });

  /**
   * Applied to the encoded string, so escaping an already-escaped document
   * changes nothing — which is what lets a caller who does not know whether the
   * encoder escaped apply it anyway.
   */
  it("can be applied twice", () => {
    const json = JSON.stringify({ name: "</script>", note: `a${SEPARATOR}b` });
    const once = encodeForTemplate(json);

    expect(encodeForTemplate(once)).toBe(once);
  });

  /**
   * The quotation marks are still quotation marks: safe inside a script block
   * and not inside an attribute, which is why the result is not marked safe.
   */
  it("leaves the quotation marks alone", () => {
    expect(encodeForTemplate('{"a":1}')).toBe('{"a":1}');
  });

  it("has nothing to do to a document with none of them", () => {
    expect(encodeForTemplate('{"a":"plain"}')).toBe('{"a":"plain"}');
  });
});
