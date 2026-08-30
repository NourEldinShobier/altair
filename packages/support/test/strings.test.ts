/**
 * The String helpers, ported from
 * `activesupport/test/core_ext/string_ext_test.rb` and
 * `activesupport/test/secure_random_test.rb`.
 */

import { describe, expect, it } from "bun:test";
import {
  base32,
  base36,
  base58,
  bytesize,
  isUtf8,
  remove,
  stripHeredoc,
  transliterate,
  truncateWords,
} from "../src/index.js";

describe("stripHeredoc", () => {
  it("removes the common indentation", () => {
    expect(stripHeredoc("    SELECT 1\n    FROM posts")).toBe("SELECT 1\nFROM posts");
  });

  /** Relative nesting has to survive, or it ruins the YAML this usually holds. */
  it("keeps the relative nesting", () => {
    expect(stripHeredoc("    a:\n      b: 1")).toBe("a:\n  b: 1");
  });

  it("measures by the smallest indentation, not the first line", () => {
    expect(stripHeredoc("      a\n    b")).toBe("  a\nb");
  });

  /** A blank line reports zero indentation and would defeat the whole thing. */
  it("ignores blank lines when measuring", () => {
    expect(stripHeredoc("    a\n\n    b")).toBe("a\n\nb");
  });

  it("leaves unindented text alone", () => {
    expect(stripHeredoc("a\nb")).toBe("a\nb");
  });

  it("copes with an empty string", () => {
    expect(stripHeredoc("")).toBe("");
  });

  it("handles tabs", () => {
    expect(stripHeredoc("\t\ta\n\t\tb")).toBe("a\nb");
  });
});

describe("truncateWords", () => {
  it("keeps the first few words", () => {
    expect(truncateWords("one two three four", 2)).toBe("one two...");
  });

  /** Never mid-word, which is the reason to pick this over a character cut. */
  it("does not cut a word in half", () => {
    expect(truncateWords("internationalisation matters", 1)).toBe("internationalisation...");
  });

  it("leaves text that is already short enough untouched", () => {
    expect(truncateWords("one two", 5)).toBe("one two");
  });

  it("does not append the omission when nothing was removed", () => {
    expect(truncateWords("one two", 2)).toBe("one two");
  });

  it("takes a custom omission", () => {
    expect(truncateWords("one two three", 1, { omission: " (more)" })).toBe("one (more)");
  });

  it("takes a custom separator", () => {
    expect(truncateWords("one-two-three", 2, { separator: "-" })).toBe("one two...");
  });
});

describe("bytesize", () => {
  it("agrees with length for ASCII", () => {
    expect(bytesize("hello")).toBe(5);
  });

  /** The disagreement is the point: a column limit counts bytes. */
  it("counts UTF-8 bytes, not code units", () => {
    expect(bytesize("é")).toBe(2);
    expect("é".length).toBe(1);
  });

  it("counts an emoji as four", () => {
    expect(bytesize("😀")).toBe(4);
  });

  it("is zero for an empty string", () => {
    expect(bytesize("")).toBe(0);
  });
});

describe("isUtf8", () => {
  it("accepts ordinary text", () => {
    expect(isUtf8("hello")).toBe(true);
  });

  it("accepts a well-formed surrogate pair", () => {
    expect(isUtf8("😀")).toBe(true);
  });

  /** A bad slice leaves half a character behind, and it throws downstream. */
  it("rejects a lone high surrogate", () => {
    expect(isUtf8("\uD800")).toBe(false);
  });

  it("rejects a lone low surrogate", () => {
    expect(isUtf8("\uDC00")).toBe(false);
  });

  it("rejects the half left by slicing an emoji", () => {
    expect(isUtf8("😀".slice(0, 1))).toBe(false);
  });
});

describe("transliterate", () => {
  it("folds accents to ASCII", () => {
    expect(transliterate("résumé")).toBe("resume");
  });

  it("leaves ASCII alone", () => {
    expect(transliterate("resume")).toBe("resume");
  });

  /** Unlike parameterize, it does not otherwise mangle the string. */
  it("keeps spaces and case", () => {
    expect(transliterate("Café Noir")).toBe("Cafe Noir");
  });
});

describe("remove", () => {
  it("removes a literal", () => {
    expect(remove("draft: hello", "draft: ")).toBe("hello");
  });

  it("removes every occurrence", () => {
    expect(remove("a-b-c", "-")).toBe("abc");
  });

  it("removes a pattern", () => {
    expect(remove("a1b2c3", /\d/)).toBe("abc");
  });

  it("removes several in order", () => {
    expect(remove("[draft] hello!", "[draft] ", "!")).toBe("hello");
  });

  it("leaves the string alone when nothing matches", () => {
    expect(remove("hello", "xyz")).toBe("hello");
  });
});

describe("the random alphabets", () => {
  it("gives the requested length", () => {
    expect(base58(21)).toHaveLength(21);
    expect(base36(10)).toHaveLength(10);
    expect(base32(16)).toHaveLength(16);
  });

  it("stays inside its alphabet", () => {
    expect(base58(200)).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    expect(base36(200)).toMatch(/^[0-9a-z]+$/);
    expect(base32(200)).toMatch(/^[0-9abcdefghjkmnpqrstvwxyz]+$/);
  });

  /** The characters people transcribe wrongly, which is base58's whole point. */
  it("keeps 0, O, I and l out of base58", () => {
    expect(base58(500)).not.toMatch(/[0OIl]/);
  });

  it("does not repeat itself", () => {
    expect(base58(21)).not.toBe(base58(21));
  });

  /**
   * Modulo bias would favour the first 24 characters, because 256 leaves a
   * remainder of 24 when divided by 58: those get five of the 256 byte values
   * and the other 34 get four. Unbiased that block is 24/58 of draws, biased
   * it is 120/256 — five and a half points apart, which a sample this size
   * separates by a wide margin.
   */
  it("draws uniformly rather than favouring the alphabet's first block", () => {
    const drawn = base58(20_000);
    const head = (drawn.match(/[123456789ABCDEFGHJKLMNPQ]/g) ?? []).length;

    expect(head / drawn.length).toBeGreaterThan(0.39);
    expect(head / drawn.length).toBeLessThan(0.44);
  });
});
