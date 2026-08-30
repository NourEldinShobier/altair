/**
 * "Did you mean?", ported from the `did_you_mean` cases Rails exercises
 * through `activerecord/test/cases/attribute_methods_test.rb` and
 * `activesupport/test/core_ext/`.
 *
 * The alternative error is `unknown attribute 'titel'` — correct, unhelpful,
 * and identical whether the caller made a typo, used the wrong model, or is
 * reading a column that was renamed three migrations ago.
 */

import { describe, expect, it } from "bun:test";
import { corrections, didYouMean, editDistance, hasCorrections } from "../src/suggestions.js";

const COLUMNS = ["title", "body", "author_id", "published_at", "created_at"];

describe("editDistance", () => {
  it("is zero for the same word", () => {
    expect(editDistance("title", "title")).toBe(0);
  });

  it("counts a substitution", () => {
    expect(editDistance("title", "tttle")).toBe(1);
  });

  it("counts an insertion and a deletion", () => {
    expect(editDistance("title", "titles")).toBe(1);
    expect(editDistance("titles", "title")).toBe(1);
  });

  /**
   * The reason this is Damerau rather than plain Levenshtein. A swap is what
   * typing produces, and counted as two edits it scores the same as two
   * unrelated substitutions — enough to push the right answer out of range.
   */
  it("counts a swap of neighbours as one edit", () => {
    expect(editDistance("titel", "title")).toBe(1);
    expect(editDistance("recieve", "receive")).toBe(1);
  });

  it("handles an empty word either way", () => {
    expect(editDistance("", "title")).toBe(5);
    expect(editDistance("title", "")).toBe(5);
    expect(editDistance("", "")).toBe(0);
  });

  it("counts unrelated words as far apart", () => {
    expect(editDistance("title", "body")).toBeGreaterThan(3);
  });

  /** Once a row's best is past the limit, nothing later comes back under it. */
  it("gives up past a limit rather than computing an exact distance", () => {
    expect(editDistance("title", "completely different", 2)).toBeGreaterThan(2);
  });

  it("still answers exactly inside the limit", () => {
    expect(editDistance("titel", "title", 5)).toBe(1);
  });

  it("is the same either way round", () => {
    expect(editDistance("titel", "title")).toBe(editDistance("title", "titel"));
  });
});

describe("corrections", () => {
  it("finds the word that was meant", () => {
    expect(corrections("titel", COLUMNS)).toEqual(["title"]);
  });

  it("finds one with a letter missing", () => {
    expect(corrections("tile", COLUMNS)).toEqual(["title"]);
  });

  it("finds one with a letter too many", () => {
    expect(corrections("titlee", COLUMNS)).toEqual(["title"]);
  });

  it("ignores case", () => {
    expect(corrections("Titel", COLUMNS)).toEqual(["title"]);
  });

  it("finds a longer name", () => {
    expect(corrections("published_ad", COLUMNS)).toEqual(["published_at"]);
  });

  /** If the word were in the list there would be no error to explain. */
  it("does not suggest the word itself", () => {
    expect(corrections("title", COLUMNS)).toEqual([]);
  });

  it("suggests nothing for something unrelated", () => {
    expect(corrections("elephant", COLUMNS)).toEqual([]);
  });

  it("puts the closest first", () => {
    const found = corrections("creaed_at", ["created_at", "published_at"]);

    expect(found[0]).toBe("created_at");
  });

  it("names at most a few", () => {
    const many = ["aaaaab", "aaaaac", "aaaaad", "aaaaae"];

    expect(corrections("aaaaaa", many, { limit: 2 })).toHaveLength(2);
  });

  /**
   * Proportional, because one wrong letter in `id` is a different word and one
   * wrong letter in `authenticated_at` is a typo. A fixed threshold either
   * rejects the second or accepts nonsense for the first.
   */
  it("is stricter about short words than long ones", () => {
    // `ad` is one edit from `id`, and a different column rather than a typo.
    expect(corrections("ad", ["id"])).toEqual([]);
    expect(corrections("authenticaded_at", ["authenticated_at"])).toEqual(["authenticated_at"]);
  });

  /**
   * A typo that dropped a character is measured against the real word rather
   * than against itself: `ip` gets the allowance `zip` deserves, not the none
   * a two-letter word would have on its own.
   */
  it("sizes the allowance against the longer of the two", () => {
    expect(corrections("ip", ["zip"])).toEqual(["zip"]);
  });

  /** Still not a licence to match anything: the distance has to be small. */
  it("does not reach a long candidate from a short word", () => {
    expect(corrections("ip", ["published_at"])).toEqual([]);
  });

  it("takes any iterable, since a caller may hold a set", () => {
    expect(corrections("titel", new Set(COLUMNS))).toEqual(["title"]);
  });

  it("suggests nothing from an empty list", () => {
    expect(corrections("titel", [])).toEqual([]);
  });
});

describe("hasCorrections", () => {
  it("says whether anything is close enough", () => {
    expect(hasCorrections("titel", COLUMNS)).toBe(true);
    expect(hasCorrections("elephant", COLUMNS)).toBe(false);
  });
});

describe("didYouMean", () => {
  it("gives a sentence to append", () => {
    expect(didYouMean("titel", COLUMNS)).toBe(" Did you mean `title`?");
  });

  it("joins a couple readably", () => {
    expect(didYouMean("aaaaaa", ["aaaaab", "aaaaac"])).toBe(" Did you mean `aaaaab` or `aaaaac`?");
  });

  /**
   * Empty rather than "no suggestions": a clause that is always there teaches
   * people to stop reading it, and the whole value is that its presence means
   * something.
   */
  it("gives nothing when there is nothing to say", () => {
    expect(didYouMean("elephant", COLUMNS)).toBe("");
  });

  it("reads correctly appended to a message", () => {
    expect(`Invalid column name: titel.${didYouMean("titel", COLUMNS)}`).toBe(
      "Invalid column name: titel. Did you mean `title`?",
    );
  });
});
