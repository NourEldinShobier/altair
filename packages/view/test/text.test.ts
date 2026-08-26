/**
 * Text helpers that produce markup.
 *
 * Mirrors actionview/test/template/text_helper_test.rb and
 * number_helper_test.rb's phone cases.
 *
 * The formatting is not the hard part. Each of these takes text from somewhere
 * and puts tags around it, which is an escaping problem wearing a formatting
 * problem's clothes: the text has to be escaped and the tags must not be, in
 * the same string. Most of what follows is about that.
 */

import { describe, expect, it } from "bun:test";
import { excerpt, highlight, numberToPhone, simpleFormat, wordWrap } from "../src/text.js";
import { renderToString } from "../src/render.js";

describe("simpleFormat", () => {
  it("makes a paragraph of each block", () => {
    expect(String(simpleFormat("one\n\ntwo"))).toBe("<p>one</p><p>two</p>");
  });

  it("makes a break of a single newline", () => {
    expect(String(simpleFormat("one\ntwo"))).toBe("<p>one<br>two</p>");
  });

  it("escapes the text and not its own tags", () => {
    expect(String(simpleFormat("a <b>x</b>"))).toBe("<p>a &lt;b&gt;x&lt;/b&gt;</p>");
  });

  it("escapes a class it is given", () => {
    expect(String(simpleFormat("x", { className: 'a" onload="y' }))).not.toContain('onload="y"');
  });

  it("drops the empty blocks a pasted document is full of", () => {
    expect(String(simpleFormat("one\n\n\n\ntwo"))).toBe("<p>one</p><p>two</p>");
  });

  // The renderer must not escape it a second time and show the tags.
  it("renders as markup rather than as text", async () => {
    expect(await renderToString(simpleFormat("hi") as never)).toBe("<p>hi</p>");
  });
});

describe("highlight", () => {
  it("wraps every occurrence", () => {
    expect(String(highlight("a b a", "a"))).toBe("<mark>a</mark> b <mark>a</mark>");
  });

  it("does not mind the case", () => {
    expect(String(highlight("Hello", "hello"))).toContain("<mark>");
  });

  it("takes a tag of its own", () => {
    expect(String(highlight("x", "x", { tag: "em" }))).toBe("<em>x</em>");
  });

  // The document is escaped and searched in that form, so the offsets line up.
  it("escapes the text around the match", () => {
    expect(String(highlight("say <b>hi</b>", "hi"))).toBe("say &lt;b&gt;<mark>hi</mark>&lt;/b&gt;");
  });

  // Both arguments come from outside: the text from a record, the phrase from
  // a search box.
  it("escapes the phrase as well", () => {
    const html = String(highlight("a <b> tag", "<b>"));

    expect(html).toBe("a <mark>&lt;b&gt;</mark> tag");
  });

  it("cannot be made to emit a tag by searching for one", () => {
    expect(String(highlight("<script>alert(1)</script>", "<script>"))).not.toContain("<script>");
  });

  /**
   * A phrase is a phrase. Building a pattern from it would let `.` match any
   * character and `(` throw — from a search box, which is where phrases come
   * from.
   */
  it("treats a regular expression character as itself", () => {
    expect(String(highlight("a.b and axb", "."))).toBe("a<mark>.</mark>b and axb");
  });

  it("does not throw on a phrase that is not a valid pattern", () => {
    expect(() => highlight("a(b", "(")).not.toThrow();
  });

  it("leaves the text alone when the phrase is empty", () => {
    expect(String(highlight("<i>x</i>", ""))).toBe("&lt;i&gt;x&lt;/i&gt;");
  });
});

describe("excerpt", () => {
  it("takes a window around the phrase", () => {
    expect(excerpt("the quick brown fox jumps", "brown", { radius: 5 })).toBe(
      "...uick brown fox ...",
    );
  });

  it("omits nothing at an edge", () => {
    expect(excerpt("brown fox", "brown", { radius: 5 })).toBe("brown fox");
  });

  it("takes an omission of its own", () => {
    expect(excerpt("aaaa target bbbb", "target", { radius: 2, omission: "…" })).toStartWith("…");
  });

  // A search results page has nothing to show for a document that does not
  // match, which is what Rails returns too.
  it("is empty when the phrase is not there", () => {
    expect(excerpt("nothing here", "zzz")).toBe("");
  });
});

describe("wordWrap", () => {
  it("breaks at the width", () => {
    expect(wordWrap("aaa bbb ccc ddd", 7)).toBe("aaa bbb\nccc ddd");
  });

  it("keeps the breaks that were already there", () => {
    expect(wordWrap("a\nb", 80)).toBe("a\nb");
  });

  // A URL split across two lines is worse than a line that runs over.
  it("leaves a word longer than the width whole", () => {
    expect(wordWrap("short https://a.very.long.example/path", 10)).toBe(
      "short\nhttps://a.very.long.example/path",
    );
  });
});

describe("numberToPhone", () => {
  it("formats seven digits", () => {
    expect(numberToPhone("5551234")).toBe("555-1234");
  });

  it("formats ten", () => {
    expect(numberToPhone("1235551234")).toBe("123-555-1234");
  });

  it("brackets the area code when asked", () => {
    expect(numberToPhone("1235551234", { areaCode: true })).toBe("(123) 555-1234");
  });

  it("takes a delimiter", () => {
    expect(numberToPhone("1235551234", { delimiter: "." })).toBe("123.555.1234");
  });

  it("takes a country code and an extension", () => {
    expect(numberToPhone("1235551234", { countryCode: 1 })).toBe("+1-123-555-1234");
    expect(numberToPhone("5551234", { extension: 99 })).toBe("555-1234 x 99");
  });

  // A number that arrives already punctuated comes out punctuated one way.
  it("reads only the digits", () => {
    expect(numberToPhone("(123) 555-1234")).toBe("123-555-1234");
  });

  it("has nothing to say about nothing", () => {
    expect(numberToPhone("")).toBe("");
    expect(numberToPhone("abc")).toBe("");
  });
});
