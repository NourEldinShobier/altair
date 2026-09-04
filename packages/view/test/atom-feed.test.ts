/**
 * An Atom feed, ported from
 * `actionview/test/template/atom_feed_helper_test.rb`.
 *
 * A feed is read by a strict XML parser, not a browser, so most of what is
 * asserted here is the difference between a feed that works and a feed that no
 * subscriber's reader will parse at all.
 */

import { describe, expect, it } from "bun:test";
import { type AtomEntry, atomEntry, atomFeed, tagUri } from "../src/atom-feed.js";

const UPDATED = new Date("2026-06-01T12:00:00.000Z");
const OLDER = new Date("2026-05-01T12:00:00.000Z");

const entry: AtomEntry = {
  id: "tag:example.com,2005:Post/7",
  title: "Hello",
  url: "https://example.com/posts/7",
  updated: UPDATED,
};

/** The part before the first entry, so a feed-level assertion cannot be satisfied by an entry. */
function header(xml: string): string {
  return xml.split("<entry>")[0] ?? "";
}

const MIDDLE = new Date("2026-05-15T12:00:00.000Z");

const feed = {
  title: "Example",
  url: "https://example.com/posts.atom",
  alternateUrl: "https://example.com/posts",
};

describe("the tag URI an entry is identified by", () => {
  /**
   * A post that moves keeps its id. A reader that used the URL shows the
   * moved post as new, and every subscriber sees the archive arrive again.
   */
  it("is built from a host, a fixed date and a path", () => {
    expect(tagUri("example.com", "2005", "Post/7")).toBe("tag:example.com,2005:Post/7");
  });
});

describe("the feed document", () => {
  it("starts with the XML declaration", () => {
    expect(atomFeed(feed, [entry]).startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(
      true,
    );
  });

  it("declares the Atom namespace and a language", () => {
    expect(atomFeed(feed, [entry])).toContain(
      '<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en-US">',
    );
    expect(atomFeed({ ...feed, language: "fr" }, [entry])).toContain('xml:lang="fr"');
  });

  /**
   * Without `rel="self"` an aggregator handed the document — rather than
   * fetching it — has no base to resolve relative URLs against, and some
   * refuse it outright.
   */
  it("links to the page and to itself", () => {
    const xml = atomFeed(feed, [entry]);

    expect(xml).toContain(
      '<link rel="alternate" type="text/html" href="https://example.com/posts"/>',
    );
    expect(xml).toContain(
      '<link rel="self" type="application/atom+xml" href="https://example.com/posts.atom"/>',
    );
  });

  it("carries the title and the subtitle", () => {
    const xml = atomFeed({ ...feed, subtitle: "Everything" }, [entry]);

    expect(xml).toContain("<title>Example</title>");
    expect(xml).toContain("<subtitle>Everything</subtitle>");
  });

  it("leaves the subtitle out when there is none", () => {
    expect(atomFeed(feed, [entry])).not.toContain("<subtitle>");
  });

  it("uses its own url as its id unless given one", () => {
    expect(atomFeed(feed, [entry])).toContain("<id>https://example.com/posts.atom</id>");
    expect(atomFeed({ ...feed, id: "tag:example.com,2005:/posts" }, [entry])).toContain(
      "<id>tag:example.com,2005:/posts</id>",
    );
  });

  /** A feed older than its own entries is one a cache serves stale forever. */
  it("takes its updated from the newest entry, wherever it sits", () => {
    const xml = atomFeed(feed, [
      { ...entry, id: "a", updated: MIDDLE },
      { ...entry, id: "b", updated: OLDER },
    ]);

    expect(header(xml)).toContain(`<updated>${MIDDLE.toISOString()}</updated>`);
  });

  it("prefers an updated it was given", () => {
    expect(header(atomFeed({ ...feed, updated: OLDER }, [entry]))).toContain(
      `<updated>${OLDER.toISOString()}</updated>`,
    );
  });

  /**
   * Stamping an empty feed with the current time would make every response
   * different, defeating every cache between here and the reader.
   */
  it("refuses an empty feed with no updated", () => {
    expect(() => atomFeed(feed, [])).toThrow(TypeError);
    expect(() => atomFeed(feed, [])).toThrow("no entries");
    expect(() => atomFeed({ ...feed, updated: UPDATED }, [])).not.toThrow();
  });

  it("carries an author when there is one", () => {
    const xml = atomFeed({ ...feed, author: { name: "Ada", email: "ada@example.com" } }, [entry]);

    expect(xml).toContain("<name>Ada</name>");
    expect(xml).toContain("<email>ada@example.com</email>");
    expect(xml).not.toContain("<uri>");
  });

  it("leaves out the parts of an author it was not given", () => {
    const xml = atomFeed({ ...feed, author: { name: "Ada" } }, [entry]);

    expect(xml).toContain("<name>Ada</name>");
    expect(xml).not.toContain("<email>");
    expect(xml).not.toContain("<uri>");
  });

  it("keeps the entries in the order it was given them", () => {
    const xml = atomFeed(feed, [
      { ...entry, id: "first" },
      { ...entry, id: "second" },
    ]);

    expect(xml.indexOf("<id>first</id>")).toBeLessThan(xml.indexOf("<id>second</id>"));
  });
});

describe("an entry", () => {
  it("carries its id, title, timestamp and link", () => {
    const xml = atomEntry(entry);

    expect(xml).toContain("<id>tag:example.com,2005:Post/7</id>");
    expect(xml).toContain("<title>Hello</title>");
    expect(xml).toContain(`<updated>${UPDATED.toISOString()}</updated>`);
    expect(xml).toContain(
      '<link rel="alternate" type="text/html" href="https://example.com/posts/7"/>',
    );
  });

  it("carries a published time only when there is one", () => {
    expect(atomEntry({ ...entry, published: OLDER })).toContain(
      `<published>${OLDER.toISOString()}</published>`,
    );
    expect(atomEntry(entry)).not.toContain("<published>");
  });

  it("leaves out a link when the entry has no page", () => {
    expect(atomEntry({ ...entry, url: undefined })).not.toContain("<link");
  });

  it("carries a summary when there is one", () => {
    expect(atomEntry({ ...entry, summary: "A greeting" })).toContain(
      "<summary>A greeting</summary>",
    );
    expect(atomEntry(entry)).not.toContain("<summary>");
  });
});

describe("an entry's content", () => {
  it("is left out when there is none", () => {
    expect(atomEntry(entry)).not.toContain("<content");
  });

  it("is html by default, and escaped", () => {
    expect(atomEntry({ ...entry, content: "<p>Hi & bye</p>" })).toContain(
      '<content type="html">&lt;p&gt;Hi &amp; bye&lt;/p&gt;</content>',
    );
  });

  it("is escaped as text too", () => {
    expect(atomEntry({ ...entry, content: "Hi & bye", contentType: "text" })).toContain(
      '<content type="text">Hi &amp; bye</content>',
    );
  });

  /**
   * Without the namespaced wrapper a reader cannot tell the entry's markup
   * from Atom's own elements, and the well-behaved ones drop the content
   * rather than guess.
   */
  it("is wrapped in a namespaced div when it is xhtml", () => {
    const xml = atomEntry({ ...entry, content: "<p>Hi</p>", contentType: "xhtml" });

    expect(xml).toContain('<content type="xhtml">');
    expect(xml).toContain('<div xmlns="http://www.w3.org/1999/xhtml"><p>Hi</p></div>');
  });
});

describe("escaping", () => {
  /**
   * One unescaped `&` does not break one entry — it takes down the whole
   * feed, for every subscriber, and the only symptom is that nobody's reader
   * updates any more.
   */
  it("escapes text content", () => {
    expect(atomEntry({ ...entry, title: "Tom & Jerry <3" })).toContain(
      "<title>Tom &amp; Jerry &lt;3</title>",
    );
  });

  it("escapes attributes", () => {
    expect(atomEntry({ ...entry, url: "https://example.com/?a=1&b=2" })).toContain(
      'href="https://example.com/?a=1&amp;b=2"',
    );
  });

  it("escapes the feed's own title", () => {
    expect(atomFeed({ ...feed, title: "A & B" }, [entry])).toContain("<title>A &amp; B</title>");
  });

  /** An attribute closed early is a document no parser will accept. */
  it("escapes the language attribute", () => {
    expect(atomFeed({ ...feed, language: 'en"x' }, [entry])).toContain('xml:lang="en&quot;x"');
  });
});
