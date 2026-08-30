/**
 * DOM identifiers, cycling and absolute asset URLs, ported from
 * `actionview/test/template/record_identifier_test.rb`,
 * `text_helper_test.rb` and `asset_url_helper_test.rb`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { setAssetHost } from "../src/assets.js";
import {
  assetUrl,
  computeAssetExtname,
  computeAssetPath,
  imageUrl,
  setDefaultUrlHost,
  stylesheetUrl,
} from "../src/asset_urls.js";
import { currentCycle, cycle, domClass, domId, domTarget, resetCycle } from "../src/dom.js";

class Post {
  constructor(readonly id: number | null) {}
}
class BlogPost {
  constructor(readonly id: number | null) {}
}

describe("domClass", () => {
  it("underscores the model name", () => {
    expect(domClass(new Post(1))).toBe("post");
  });

  /** Singular, because it names one thing — not the table. */
  it("keeps a multi-word name singular", () => {
    expect(domClass(new BlogPost(1))).toBe("blog_post");
  });

  it("takes a prefix", () => {
    expect(domClass(new Post(1), "edit")).toBe("edit_post");
  });
});

describe("domId", () => {
  it("joins the class and the id", () => {
    expect(domId(new Post(1))).toBe("post_1");
  });

  it("takes a prefix", () => {
    expect(domId(new Post(1), "edit")).toBe("edit_post_1");
  });

  /**
   * A form for a new record and a form for record 1 must not collide, and
   * `post_` or `post_undefined` would be a worse answer than saying "new".
   */
  it("says new for an unsaved record", () => {
    expect(domId(new Post(null))).toBe("new_post");
  });

  it("prefixes a new record too", () => {
    expect(domId(new Post(null), "edit")).toBe("edit_new_post");
  });

  it("is what domTarget answers", () => {
    expect(domTarget(new Post(3))).toBe(domId(new Post(3)));
  });
});

describe("cycle", () => {
  afterEach(() => {
    resetCycle();
  });

  it("rotates through the values", () => {
    expect(cycle("odd", "even")).toBe("odd");
    expect(cycle("odd", "even")).toBe("even");
    expect(cycle("odd", "even")).toBe("odd");
  });

  it("copes with a single value", () => {
    expect(cycle("only")).toBe("only");
    expect(cycle("only")).toBe("only");
  });

  /** The bug in every hand-rolled version: two cycles advancing each other. */
  it("keeps separate cycles apart", () => {
    expect(cycle("a", "b")).toBe("a");
    expect(cycle("x", "y")).toBe("x");
    expect(cycle("a", "b")).toBe("b");
    expect(cycle("x", "y")).toBe("y");
  });

  it("reports the current value without advancing", () => {
    cycle("odd", "even");

    expect(currentCycle("odd", "even")).toBe("odd");
    expect(currentCycle("odd", "even")).toBe("odd");
    expect(cycle("odd", "even")).toBe("even");
  });

  it("has no current value before the first call", () => {
    expect(currentCycle("fresh", "values")).toBeUndefined();
  });

  /** Otherwise the striping carries its parity across a section break. */
  it("resets to the first value", () => {
    cycle("odd", "even");
    resetCycle("odd", "even");

    expect(cycle("odd", "even")).toBe("odd");
  });

  it("resets only the cycle named", () => {
    cycle("a", "b");
    cycle("x", "y");
    resetCycle("a", "b");

    expect(cycle("a", "b")).toBe("a");
    expect(cycle("x", "y")).toBe("y");
  });

  it("refuses an empty cycle", () => {
    expect(() => cycle()).toThrow(/at least one/);
  });
});

describe("absolute asset URLs", () => {
  beforeEach(() => {
    setAssetHost(undefined);
    setDefaultUrlHost("https://example.com");
  });

  afterEach(() => {
    setAssetHost(undefined);
    setDefaultUrlHost(undefined);
  });

  /** An email client cannot resolve a relative path; this is the whole point. */
  it("carries the host", () => {
    expect(imageUrl("logo.png")).toBe("https://example.com/images/logo.png");
  });

  it("does the same for stylesheets", () => {
    expect(stylesheetUrl("application.css")).toBe(
      "https://example.com/stylesheets/application.css",
    );
  });

  it("takes an explicit host", () => {
    expect(imageUrl("logo.png", "https://other.test")).toBe("https://other.test/images/logo.png");
  });

  it("leaves an already absolute source alone", () => {
    expect(imageUrl("https://cdn.test/logo.png")).toBe("https://cdn.test/logo.png");
  });

  it("leaves a data URI alone", () => {
    expect(imageUrl("data:image/gif;base64,R0lGOD")).toBe("data:image/gif;base64,R0lGOD");
  });

  /** Prefixing twice is the bug the absolute check exists for. */
  it("does not prefix a path an asset host already made absolute", () => {
    setAssetHost("https://cdn.example.com");

    expect(imageUrl("logo.png")).toBe("https://cdn.example.com/images/logo.png");
  });

  it("falls back to the path when no host is set", () => {
    setDefaultUrlHost(undefined);

    expect(imageUrl("logo.png")).toBe("/images/logo.png");
  });

  it("trims a trailing slash off the host", () => {
    expect(computeAssetPath("/a.png", "https://example.com/")).toBe("https://example.com/a.png");
  });

  it("builds a generic asset URL", () => {
    expect(assetUrl("robots.txt")).toBe("https://example.com/robots.txt");
  });
});

describe("computeAssetExtname", () => {
  it("adds the extension when there is none", () => {
    expect(computeAssetExtname("application", "css")).toBe(".css");
  });

  it("takes an extension already spelled with a dot", () => {
    expect(computeAssetExtname("application", ".css")).toBe(".css");
  });

  it("adds nothing when the source already has one", () => {
    expect(computeAssetExtname("application.css", "css")).toBe("");
  });

  it("adds nothing when no extension was asked for", () => {
    expect(computeAssetExtname("application")).toBe("");
  });

  it("sees through a query string", () => {
    expect(computeAssetExtname("application.css?v=2", "css")).toBe("");
  });
});
