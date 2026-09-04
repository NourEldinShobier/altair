/**
 * Accept headers that name a family rather than a type, ported from
 * `actionpack/test/dispatch/mime_type_test.rb`.
 *
 * Every case is a header that was satisfiable and got a 406, or one that was
 * answered with a document the client cannot read — both with a status that
 * says nothing went wrong.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  MIME_TYPES,
  type AcceptEntry,
  findItemByName,
  negotiateFormat,
  onChange,
  parseAccept,
  parseDataWithTrailingStar,
  parseTrailingStar,
  registerCallback,
  registerMimeType,
  resetMimeCallbacks,
  sortAcceptEntries,
  unregisterMimeType,
} from "../src/mime.js";

afterEach(() => {
  resetMimeCallbacks();
  unregisterMimeType("mobile");
});

describe("the formats in a media family", () => {
  it("is every format sent as that media type", () => {
    expect(parseDataWithTrailingStar("text")).toContain("html");
    expect(parseDataWithTrailingStar("text")).toContain("csv");
    expect(parseDataWithTrailingStar("text")).not.toContain("json");
  });

  it("is the other family for application", () => {
    expect(parseDataWithTrailingStar("application")).toContain("json");
    expect(parseDataWithTrailingStar("application")).not.toContain("html");
  });

  /** A question about the registry, so a registered format is there for free. */
  it("includes a format the application registered", () => {
    registerMimeType("mobile", "text/mobile");

    expect(parseDataWithTrailingStar("text")).toContain("mobile");
  });

  it("does not care about case", () => {
    expect(parseDataWithTrailingStar("TEXT")).toContain("html");
  });

  /** The family is the part before the slash, not a prefix of the whole type. */
  it("is not everything whose type merely starts with the name", () => {
    registerMimeType("mobile", "textual/thing");

    expect(parseDataWithTrailingStar("text")).not.toContain("mobile");
  });
});

describe("a family in an accept header", () => {
  it("expands to the formats it covers", () => {
    expect(parseTrailingStar("text/*")).toContain("html");
    expect(parseTrailingStar("application/*")).toContain("json");
  });

  /**
   * `image/*` is a family this negotiates nothing in, and a bare wildcard is
   * "anything" rather than a family — the negotiation already handles that as a
   * last resort.
   */
  it("is nothing for anything else", () => {
    expect(parseTrailingStar("text/html")).toBeUndefined();
    expect(parseTrailingStar("image/*")).toBeUndefined();
    expect(parseTrailingStar("*/*")).toBeUndefined();
  });

  /**
   * Matched literally the header matches nothing the application declares, and
   * a satisfiable request gets a 406.
   */
  it("is answered rather than refused", () => {
    expect(
      negotiateFormat(new Request("http://x/posts", { headers: { accept: "text/*" } }), {
        available: ["html", "json"],
      }),
    ).toBe("html");
  });

  it("keeps the quality it was written with", () => {
    const entries = parseAccept("application/*;q=0.5, text/html");

    expect(entries[0]?.type).toBe("text/html");
    expect(entries.every((entry) => entry.type !== "application/*")).toBe(true);
  });

  it("leaves a concrete type alone", () => {
    expect(parseAccept("application/json")).toEqual([{ type: "application/json", quality: 1 }]);
  });

  /** The xml fix-ups apply to a parsed header, not only to a hand-built list. */
  it("folds the xml spellings on the way through", () => {
    expect(parseAccept("text/xml")).toEqual([{ type: "application/xml", quality: 1 }]);
  });
});

describe("finding a type in a parsed list", () => {
  /** By index, because the fix-ups that use it reorder the list. */
  it("is where it sits", () => {
    const entries: AcceptEntry[] = [
      { type: "text/html", quality: 1 },
      { type: "application/xml", quality: 0.9 },
    ];

    expect(findItemByName(entries, "application/xml")).toBe(1);
    expect(findItemByName(entries, "text/csv")).toBe(-1);
  });
});

describe("the two orderings a quality sort gets wrong", () => {
  /**
   * `text/xml` and `application/xml` are the same thing. Left as two entries the
   * weaker spelling can outrank a genuinely different format between them.
   */
  it("folds text/xml into application/xml", () => {
    const sorted = sortAcceptEntries([
      { type: "text/xml", quality: 0.9 },
      { type: "application/xml", quality: 0.5 },
    ]);

    expect(sorted).toEqual([{ type: "application/xml", quality: 0.9 }]);
  });

  it("renames a lone text/xml", () => {
    expect(sortAcceptEntries([{ type: "text/xml", quality: 0.8 }])).toEqual([
      { type: "application/xml", quality: 0.8 },
    ]);
  });

  it("leaves a list with neither alone", () => {
    const entries: AcceptEntry[] = [{ type: "text/html", quality: 1 }];

    expect(sortAcceptEntries(entries)).toEqual(entries);
  });

  /**
   * A feed reader sends both and means the specific one. Answering generic XML
   * gives it a document it cannot read, with a 200.
   */
  it("puts a more specific xml type ahead of the generic one", () => {
    const sorted = sortAcceptEntries([
      { type: "application/xml", quality: 1 },
      { type: "application/atom+xml", quality: 1 },
    ]);

    expect(sorted.map((entry) => entry.type)).toEqual(["application/atom+xml", "application/xml"]);
  });

  /** Only at the same quality or better: a weaker preference is still weaker. */
  it("leaves a weaker specific type where it is", () => {
    const sorted = sortAcceptEntries([
      { type: "application/xml", quality: 1 },
      { type: "application/atom+xml", quality: 0.5 },
    ]);

    expect(sorted.map((entry) => entry.type)).toEqual(["application/xml", "application/atom+xml"]);
  });

  /** Only an xml dialect: an unrelated type at the same quality stays put. */
  it("does not promote something that is not xml", () => {
    const sorted = sortAcceptEntries([
      { type: "application/xml", quality: 1 },
      { type: "text/html", quality: 1 },
    ]);

    expect(sorted.map((entry) => entry.type)).toEqual(["application/xml", "text/html"]);
  });

  it("does not reorder something that is already ahead", () => {
    const sorted = sortAcceptEntries([
      { type: "application/atom+xml", quality: 1 },
      { type: "application/xml", quality: 1 },
    ]);

    expect(sorted.map((entry) => entry.type)).toEqual(["application/atom+xml", "application/xml"]);
  });

  it("does not alter the list it was given", () => {
    const entries: AcceptEntry[] = [{ type: "text/xml", quality: 1 }];
    sortAcceptEntries(entries);

    expect(entries).toEqual([{ type: "text/xml", quality: 1 }]);
  });
});

describe("being told the registry changed", () => {
  /**
   * The registry is read into other structures — a router's format constraint,
   * a renderer's table — which are built once and would otherwise never learn
   * about a format an initializer added.
   */
  it("says what was registered", () => {
    const seen: [string, boolean][] = [];
    onChange((format, registered) => seen.push([format, registered]));
    registerMimeType("mobile", "text/mobile");

    expect(seen).toEqual([["mobile", true]]);
  });

  it("says what was removed", () => {
    registerMimeType("mobile", "text/mobile");

    const seen: [string, boolean][] = [];
    onChange((format, registered) => seen.push([format, registered]));
    unregisterMimeType("mobile");

    expect(seen).toEqual([["mobile", false]]);
    expect(MIME_TYPES["mobile"]).toBeUndefined();
  });

  it("says nothing for a format that was not there", () => {
    const seen: unknown[] = [];
    onChange((...args) => seen.push(args));
    unregisterMimeType("nothing");

    expect(seen).toEqual([]);
  });

  it("tells a registration-only listener about registrations alone", () => {
    const seen: string[] = [];
    registerCallback((format) => seen.push(format));
    registerMimeType("mobile", "text/mobile");
    unregisterMimeType("mobile");

    expect(seen).toEqual(["mobile"]);
  });

  it("tells every listener", () => {
    const seen: string[] = [];
    onChange(() => seen.push("first"));
    onChange(() => seen.push("second"));
    registerMimeType("mobile", "text/mobile");

    expect(seen).toEqual(["first", "second"]);
  });
});
