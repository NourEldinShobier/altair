/**
 * Laying out a plain-text mail body, ported from
 * `actionmailer/test/mail_helper_test.rb`.
 *
 * HTML reflows to whatever width the reader has; plain text does not. An
 * unwrapped paragraph arrives as one very long line and what happens next
 * depends on the client — some wrap it, some scroll sideways, some truncate.
 */

import { describe, expect, it } from "bun:test";
import {
  DEFAULT_LINE_WIDTH,
  blockFormat,
  formatParagraph,
  quoteText,
  wordWrap,
} from "../src/text-format.js";

const LONG = "The quick brown fox jumps over the lazy dog and keeps going well past the margin";

function widest(text: string): number {
  return Math.max(...text.split("\n").map((line) => line.length));
}

describe("wordWrap", () => {
  it("breaks at the width", () => {
    expect(widest(wordWrap(LONG, { width: 20 }))).toBeLessThanOrEqual(20);
  });

  it("does not break words", () => {
    for (const line of wordWrap(LONG, { width: 20 }).split("\n")) {
      expect(LONG).toContain(line);
    }
  });

  it("keeps every word", () => {
    expect(wordWrap(LONG, { width: 20 }).split(/\s+/)).toEqual(LONG.split(" "));
  });

  /**
   * Splitting one would break exactly the things that must not break — a URL,
   * a token, an order reference — and a line four characters too long is a
   * smaller problem than a link that no longer works.
   */
  it("leaves a word longer than the width whole", () => {
    const url = "https://example.test/a/very/long/path/that/exceeds/the/margin";

    expect(wordWrap(`See ${url} now`, { width: 20 })).toContain(url);
  });

  /** Reflowing everything would run a list of three items into one paragraph. */
  it("keeps the author's own line breaks", () => {
    expect(wordWrap("one\ntwo\nthree", { width: 40 })).toBe("one\ntwo\nthree");
  });

  it("puts a prefix on every line", () => {
    const wrapped = wordWrap(LONG, { width: 30, prefix: "> " });

    for (const line of wrapped.split("\n")) expect(line.startsWith("> ")).toBe(true);
  });

  it("counts the prefix against the width", () => {
    expect(widest(wordWrap(LONG, { width: 30, prefix: "> " }))).toBeLessThanOrEqual(30);
  });

  it("leaves a blank line blank", () => {
    expect(wordWrap("one\n\ntwo", { width: 40 })).toBe("one\n\ntwo");
  });

  it("survives an empty string", () => {
    expect(wordWrap("", { width: 20 })).toBe("");
  });

  it("wraps at 72 by default", () => {
    const text = Array.from({ length: 40 }, () => "word").join(" ");

    expect(widest(wordWrap(text))).toBeLessThanOrEqual(DEFAULT_LINE_WIDTH);
  });

  /** 72 leaves room for three levels of `> ` before a reply breaks. */
  it("defaults to a width a reply can survive", () => {
    expect(DEFAULT_LINE_WIDTH).toBe(72);
  });
});

describe("formatParagraph", () => {
  it("wraps and trims", () => {
    expect(formatParagraph("  hello there  ", 40)).toBe("hello there");
  });

  it("indents with spaces", () => {
    expect(formatParagraph("hello", 40, 4)).toBe("    hello");
  });

  it("counts the indent against the width", () => {
    expect(widest(formatParagraph(LONG, 30, 4))).toBeLessThanOrEqual(30);
  });

  /** A tab is eight columns in one client and four in another. */
  it("does not indent with a tab", () => {
    expect(formatParagraph("hello", 40, 2)).not.toContain("\t");
  });
});

describe("blockFormat", () => {
  it("keeps paragraphs apart", () => {
    expect(blockFormat("one\n\ntwo", 40)).toBe("one\n\ntwo");
  });

  it("wraps each paragraph", () => {
    expect(widest(blockFormat(`${LONG}\n\n${LONG}`, 30))).toBeLessThanOrEqual(30);
  });

  it("collapses a run of blank lines to one gap", () => {
    expect(blockFormat("one\n\n\n\ntwo", 40)).toBe("one\n\ntwo");
  });

  /**
   * It is somebody else's text, and reflowing it silently changes what they
   * appear to have written.
   */
  it("indents a quoted block rather than rewrapping it", () => {
    const quoted = "> they said something\n> that ran on a while";

    expect(blockFormat(quoted, 20)).toBe("  > they said something\n  > that ran on a while");
  });

  it("wraps a paragraph beside a quoted one", () => {
    const body = `> quoted line\n\n${LONG}`;
    const [first, ...rest] = blockFormat(body, 30).split("\n\n");

    expect(first).toBe("  > quoted line");
    expect(widest(rest.join("\n\n"))).toBeLessThanOrEqual(30);
  });

  it("survives an empty body", () => {
    expect(blockFormat("", 40)).toBe("");
  });

  it("survives a body that is only blank lines", () => {
    expect(blockFormat("\n\n\n", 40)).toBe("");
  });
});

describe("quoteText", () => {
  it("marks every line", () => {
    expect(quoteText("one\ntwo")).toBe("> one\n> two");
  });

  /**
   * A gap with no marker reads as the end of the quotation; a marker with a
   * space on the end is trailing whitespace every diff complains about.
   */
  it("marks a blank line without leaving a trailing space", () => {
    expect(quoteText("one\n\ntwo")).toBe("> one\n>\n> two");
  });

  it("takes a different marker", () => {
    expect(quoteText("one", "| ")).toBe("| one");
  });

  it("survives an empty string", () => {
    expect(quoteText("")).toBe(">");
  });
});
