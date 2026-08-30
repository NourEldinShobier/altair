/**
 * stripTags and stripLinks, ported from the corresponding cases in
 * `actionview/test/template/sanitize_helper_test.rb`.
 */

import { describe, expect, it } from "bun:test";
import { stripLinks, stripTags } from "../src/text.js";

describe("stripTags", () => {
  it("removes the tags and keeps the text", () => {
    expect(stripTags("<p>Hello <strong>world</strong></p>")).toBe("Hello world");
  });

  it("removes a script and its contents", () => {
    expect(stripTags("<p>a</p><script>alert(1)</script>")).toBe("a");
  });

  it("removes a style block and its contents", () => {
    expect(stripTags("<style>p{color:red}</style><p>a</p>")).toBe("a");
  });

  /** Seeing &amp; in a subject line is the same bug as seeing <p>. */
  it("decodes entities", () => {
    expect(stripTags("<p>Fish &amp; Chips</p>")).toBe("Fish & Chips");
    expect(stripTags("<p>a&nbsp;b</p>")).toBe("a b");
  });

  it("leaves plain text alone", () => {
    expect(stripTags("Hello")).toBe("Hello");
  });

  it("copes with nothing", () => {
    expect(stripTags("")).toBe("");
  });

  it("removes a self-closing tag", () => {
    expect(stripTags("a<br/>b")).toBe("ab");
  });
});

describe("stripLinks", () => {
  /** The spam link becomes the words it was hiding behind. */
  it("keeps the text and drops the link", () => {
    expect(stripLinks('<a href="http://spam.test">click here</a>')).toBe("click here");
  });

  it("leaves other formatting alone", () => {
    expect(stripLinks('<p><strong>a</strong> <a href="/x">b</a></p>')).toBe(
      "<p><strong>a</strong> b</p>",
    );
  });

  it("handles several", () => {
    expect(stripLinks('<a href="/1">one</a> and <a href="/2">two</a>')).toBe("one and two");
  });

  it("keeps markup inside the link text", () => {
    expect(stripLinks('<a href="/x"><em>b</em></a>')).toBe("<em>b</em>");
  });

  it("leaves text with no links alone", () => {
    expect(stripLinks("<p>Hello</p>")).toBe("<p>Hello</p>");
  });
});
