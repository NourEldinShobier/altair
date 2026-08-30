/**
 * Reading what is inside a rich text body, ported from
 * `actiontext/test/unit/content_test.rb` — the `links`, `attachables` and
 * `attachable_*_representation` cases.
 */

import { describe, expect, it } from "bun:test";
import { Fragment } from "../src/fragment.js";
import {
  appendAttachables,
  attachableMarkdownRepresentation,
  attachablePlainTextRepresentation,
  contentAttachableSgids,
  contentAttachables,
  contentLinkUrls,
  contentLinks,
  isPreviewableAttachable,
} from "../src/content.js";

const BODY =
  '<p>Read <a href="https://example.com/one">the first</a> and ' +
  '<a href="https://example.com/two"><strong>the second</strong></a>.</p>';

const WITH_ATTACHMENTS =
  '<p>Look:</p><action-text-attachment sgid="abc" content-type="image/png" ' +
  'filename="cat.png" url="https://cdn.test/cat.png" caption="My cat">' +
  "</action-text-attachment>" +
  '<action-text-attachment sgid="def" content-type="application/pdf" filename="report.pdf">' +
  "</action-text-attachment>";

describe("links", () => {
  it("finds every link in order", () => {
    expect(contentLinkUrls(BODY)).toEqual(["https://example.com/one", "https://example.com/two"]);
  });

  it("gives the visible text with markup removed", () => {
    expect(contentLinks(BODY).map((link) => link.text)).toEqual(["the first", "the second"]);
  });

  /** "Links to the same domain nine times" is the shape a spam check reads. */
  it("keeps duplicates rather than collapsing them", () => {
    const repeated = '<a href="https://x.test">a</a><a href="https://x.test">b</a>';

    expect(contentLinkUrls(repeated)).toEqual(["https://x.test", "https://x.test"]);
  });

  /**
   * An href is compared against a host, put in a header, or followed, and an
   * `&amp;` left in place turns a query string into a different one.
   */
  it("decodes entities in the address", () => {
    const escaped = '<a href="https://x.test/?a=1&amp;b=2">go</a>';

    expect(contentLinkUrls(escaped)).toEqual(["https://x.test/?a=1&b=2"]);
  });

  it("finds none in a body with none", () => {
    expect(contentLinks("<p>Nothing here</p>")).toEqual([]);
  });

  it("takes a fragment as readily as a string", () => {
    expect(contentLinkUrls(Fragment.fromHtml(BODY))).toHaveLength(2);
  });

  it("survives an empty body", () => {
    expect(contentLinks("")).toEqual([]);
  });

  /** Non-greedy, or two links become one match swallowing everything between. */
  it("does not run two links together", () => {
    expect(contentLinks(BODY)).toHaveLength(2);
  });
});

describe("attachables", () => {
  it("finds every attachment", () => {
    expect(contentAttachables(WITH_ATTACHMENTS)).toHaveLength(2);
  });

  it("reads what each node says about itself", () => {
    const [first] = contentAttachables(WITH_ATTACHMENTS);

    expect(first?.sgid).toBe("abc");
    expect(first?.contentType).toBe("image/png");
    expect(first?.filename).toBe("cat.png");
    expect(first?.url).toBe("https://cdn.test/cat.png");
    expect(first?.caption).toBe("My cat");
  });

  it("keeps the whole node for anything else a caller needs", () => {
    expect(contentAttachables(WITH_ATTACHMENTS)[0]?.node).toContain("action-text-attachment");
  });

  it("leaves out what a node does not say", () => {
    const [, second] = contentAttachables(WITH_ATTACHMENTS);

    expect(second?.url).toBeUndefined();
    expect(second?.caption).toBeUndefined();
  });

  /**
   * The list a purge has to consult. A blob referenced only from inside a body
   * has no association row pointing at it, so deleting "unattached" blobs
   * without reading the bodies deletes images out of published posts.
   */
  it("gives the signed ids a reference check compares", () => {
    expect(contentAttachableSgids(WITH_ATTACHMENTS)).toEqual(["abc", "def"]);
  });

  /** Hand-edited markup: reporting it without an sgid beats dropping it. */
  it("still reports a node with no sgid", () => {
    const malformed = '<action-text-attachment content-type="image/png"></action-text-attachment>';

    expect(contentAttachables(malformed)).toHaveLength(1);
    expect(contentAttachableSgids(malformed)).toEqual([]);
  });

  it("finds none in a body with none", () => {
    expect(contentAttachables(BODY)).toEqual([]);
  });
});

describe("appendAttachables", () => {
  it("puts an attachment at the end", () => {
    const appended = appendAttachables("<p>Hello</p>", [{ sgid: "xyz" }]);

    expect(appended.source.startsWith("<p>Hello</p>")).toBe(true);
    expect(contentAttachableSgids(appended)).toEqual(["xyz"]);
  });

  it("keeps what was already there", () => {
    const appended = appendAttachables(WITH_ATTACHMENTS, [{ sgid: "xyz" }]);

    expect(contentAttachableSgids(appended)).toEqual(["abc", "def", "xyz"]);
  });

  it("adds several", () => {
    const appended = appendAttachables("", [{ sgid: "one" }, { sgid: "two" }]);

    expect(contentAttachableSgids(appended)).toEqual(["one", "two"]);
  });

  it("carries the attributes it was given", () => {
    const appended = appendAttachables("", [
      { sgid: "xyz", contentType: "image/png", filename: "a.png", caption: "A" },
    ]);
    const [attachable] = contentAttachables(appended);

    expect(attachable?.contentType).toBe("image/png");
    expect(attachable?.filename).toBe("a.png");
    expect(attachable?.caption).toBe("A");
  });

  /** A caption is author text; unescaped it closes the attribute and the tag. */
  it("escapes what goes into an attribute", () => {
    const appended = appendAttachables("", [
      { sgid: "xyz", caption: '"><script>alert(1)</script>' },
    ]);

    expect(appended.source).not.toContain("<script>");
    expect(contentAttachables(appended)).toHaveLength(1);
  });

  it("round-trips a caption through the escaping", () => {
    const caption = 'He said "hi" & left';
    const appended = appendAttachables("", [{ sgid: "xyz", caption }]);

    expect(contentAttachables(appended)[0]?.caption).toBe(caption);
  });

  it("adds nothing when given nothing", () => {
    expect(appendAttachables("<p>Hello</p>", []).source).toBe("<p>Hello</p>");
  });
});

describe("how an attachment reads without html", () => {
  /**
   * The quiet one. Strip the tags and every attachment becomes nothing: a
   * message that was a caption and a photo arrives as the caption, and the
   * recipient cannot tell a photo was meant.
   */
  it("prefers the caption", () => {
    expect(attachablePlainTextRepresentation({ caption: "My cat", node: "" })).toBe("[My cat]");
  });

  it("falls back to the filename", () => {
    expect(attachablePlainTextRepresentation({ filename: "cat.png", node: "" })).toBe("[cat.png]");
  });

  it("falls back to what kind of thing it is", () => {
    expect(attachablePlainTextRepresentation({ contentType: "image/png", node: "" })).toBe(
      "[Image]",
    );
    expect(attachablePlainTextRepresentation({ contentType: "video/mp4", node: "" })).toBe(
      "[Video]",
    );
    expect(attachablePlainTextRepresentation({ contentType: "audio/mpeg", node: "" })).toBe(
      "[Audio]",
    );
  });

  it("says something even for a node with nothing on it", () => {
    expect(attachablePlainTextRepresentation({ node: "" })).toBe("[Attachment]");
  });
});

describe("how an attachment reads as markdown", () => {
  it("writes an image as an image", () => {
    expect(
      attachableMarkdownRepresentation({
        caption: "My cat",
        contentType: "image/png",
        url: "https://cdn.test/cat.png",
        node: "",
      }),
    ).toBe("![My cat](https://cdn.test/cat.png)");
  });

  it("writes anything else as a link", () => {
    expect(
      attachableMarkdownRepresentation({
        filename: "report.pdf",
        contentType: "application/pdf",
        url: "https://cdn.test/report.pdf",
        node: "",
      }),
    ).toBe("[report.pdf](https://cdn.test/report.pdf)");
  });

  /** Nowhere to point, so the plain form is the honest one. */
  it("falls back to the plain form with no url", () => {
    expect(attachableMarkdownRepresentation({ caption: "My cat", node: "" })).toBe("[My cat]");
  });
});

describe("previewable attachments", () => {
  it("says yes to a pdf and a video", () => {
    expect(isPreviewableAttachable({ contentType: "application/pdf", node: "" })).toBe(true);
    expect(isPreviewableAttachable({ contentType: "video/mp4", node: "" })).toBe(true);
  });

  it("says no to an image, which needs no previewer", () => {
    expect(isPreviewableAttachable({ contentType: "image/png", node: "" })).toBe(false);
  });

  it("says no to a node with no type", () => {
    expect(isPreviewableAttachable({ node: "" })).toBe(false);
  });

  it("ignores parameters and case", () => {
    expect(isPreviewableAttachable({ contentType: "APPLICATION/PDF; x=1", node: "" })).toBe(true);
  });
});
