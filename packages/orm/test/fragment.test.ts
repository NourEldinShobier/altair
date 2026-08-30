/**
 * Rich text fragments, ported from `actiontext/test/unit/fragment_test.rb`,
 * `plain_text_conversion_test.rb` and the content canonicalization cases in
 * `actiontext/test/unit/content_test.rb`.
 */

import { describe, expect, it } from "bun:test";
import {
  ATTACHMENT_SELECTOR,
  Fragment,
  attributeOf,
  fragmentByCanonicalizingAttachmentGalleries,
  fragmentByCanonicalizingAttachments,
  fragmentByCanonicalizingContent,
  fragmentByConvertingTrixAttachments,
  fragmentByMinifyingAttachments,
  fragmentByReplacingAttachmentGalleryNodes,
  fragmentForHtml,
  nodeToHtml,
  nodeToMarkdown,
  nodeToPlainText,
} from "../src/fragment.js";

describe("wrapping", () => {
  it("takes HTML", () => {
    expect(Fragment.fromHtml("<p>Hi</p>").toHtml()).toBe("<p>Hi</p>");
  });

  it("trims the source", () => {
    expect(Fragment.fromHtml("  <p>Hi</p>  ").toHtml()).toBe("<p>Hi</p>");
  });

  /** Rails: wrap returns the fragment unchanged when it already is one. */
  it("passes a fragment through", () => {
    const fragment = Fragment.fromHtml("<p>Hi</p>");

    expect(Fragment.wrap(fragment)).toBe(fragment);
  });

  it("stringifies to its HTML", () => {
    expect(String(Fragment.fromHtml("<p>Hi</p>"))).toBe("<p>Hi</p>");
    expect(nodeToHtml("<p>Hi</p>")).toBe("<p>Hi</p>");
    expect(fragmentForHtml("<p>Hi</p>").toHtml()).toBe("<p>Hi</p>");
  });

  it("copes with nothing", () => {
    expect(Fragment.fromHtml("").toHtml()).toBe("");
  });
});

describe("findAll and replace", () => {
  const body = `<p>a</p><${ATTACHMENT_SELECTOR} sgid="one"></${ATTACHMENT_SELECTOR}><${ATTACHMENT_SELECTOR} sgid="two"></${ATTACHMENT_SELECTOR}>`;

  /** The bug every hand-written tag regex has: one match swallowing both. */
  it("finds each node separately rather than one greedy match", () => {
    expect(Fragment.fromHtml(body).findAll(ATTACHMENT_SELECTOR)).toHaveLength(2);
  });

  it("finds nothing when there is nothing", () => {
    expect(Fragment.fromHtml("<p>a</p>").findAll(ATTACHMENT_SELECTOR)).toEqual([]);
  });

  it("replaces each node", () => {
    const replaced = Fragment.fromHtml(body).replace(ATTACHMENT_SELECTOR, () => "X");

    expect(replaced.toHtml()).toBe("<p>a</p>XX");
  });

  it("hands the node to the replacement", () => {
    const seen: string[] = [];
    Fragment.fromHtml(body).replace(ATTACHMENT_SELECTOR, (node) => {
      seen.push(attributeOf(node, "sgid") ?? "");
      return node;
    });

    expect(seen).toEqual(["one", "two"]);
  });

  it("removes nodes", () => {
    expect(Fragment.fromHtml(body).remove(ATTACHMENT_SELECTOR).toHtml()).toBe("<p>a</p>");
  });

  /** A new fragment, so the stored body and the rendered body can both exist. */
  it("leaves the original alone", () => {
    const original = Fragment.fromHtml(body);
    original.remove(ATTACHMENT_SELECTOR);

    expect(original.findAll(ATTACHMENT_SELECTOR)).toHaveLength(2);
  });

  it("reads an attribute off a node", () => {
    expect(attributeOf('<a href="/x" class="y">', "href")).toBe("/x");
    expect(attributeOf("<a>", "href")).toBeUndefined();
  });
});

describe("plain text", () => {
  it("strips the tags", () => {
    expect(nodeToPlainText("<p>Hello <strong>world</strong></p>")).toBe("Hello world");
  });

  /**
   * The reason blocks become newlines first: stripping alone runs the last
   * word of one paragraph into the first word of the next, and a search index
   * then matches phrases nobody wrote.
   */
  it("keeps paragraphs apart", () => {
    expect(nodeToPlainText("<p>One</p><p>Two</p>")).toBe("One\n\nTwo");
  });

  it("breaks on br", () => {
    expect(nodeToPlainText("<p>One<br>Two</p>")).toBe("One\n\nTwo");
  });

  it("breaks on list items", () => {
    expect(nodeToPlainText("<ul><li>One</li><li>Two</li></ul>")).toBe("One\n\nTwo");
  });

  it("unescapes entities", () => {
    expect(nodeToPlainText("<p>Fish &amp; Chips</p>")).toBe("Fish & Chips");
    expect(nodeToPlainText("<p>a&nbsp;b</p>")).toBe("a b");
  });

  it("drops empty lines", () => {
    expect(nodeToPlainText("<p>One</p><p></p><p>Two</p>")).toBe("One\n\nTwo");
  });

  it("gives an empty string for empty markup", () => {
    expect(nodeToPlainText("")).toBe("");
  });

  it("reads off a fragment too", () => {
    expect(Fragment.fromHtml("<p>Hi</p>").toPlainText()).toBe("Hi");
  });
});

describe("markdown", () => {
  it("converts bold and italic", () => {
    expect(nodeToMarkdown("<p><strong>a</strong> <em>b</em></p>")).toBe("**a** _b_");
  });

  it("converts a link", () => {
    expect(nodeToMarkdown('<p><a href="/x">text</a></p>')).toBe("[text](/x)");
  });

  it("converts a heading", () => {
    expect(nodeToMarkdown("<h2>Title</h2>")).toBe("## Title");
  });

  it("converts code", () => {
    expect(nodeToMarkdown("<p><code>x</code></p>")).toBe("`x`");
  });

  it("converts list items", () => {
    expect(nodeToMarkdown("<ul><li>One</li><li>Two</li></ul>")).toBe("- One\n\n- Two");
  });

  it("reads off a fragment too", () => {
    expect(Fragment.fromHtml("<p><strong>a</strong></p>").toMarkdown()).toBe("**a**");
  });
});

describe("canonicalizing attachments", () => {
  /** Trix writes a figure; the stored body holds Action Text's own tag. */
  it("turns a Trix figure into an attachment", () => {
    const html = '<figure data-trix-attachment-sgid="abc"></figure>';

    expect(fragmentByCanonicalizingAttachments(html).toHtml()).toBe(
      `<${ATTACHMENT_SELECTOR} sgid="abc"></${ATTACHMENT_SELECTOR}>`,
    );
  });

  it("reads the sgid out of the JSON blob", () => {
    const html = '<figure data-trix-attachment="{&quot;sgid&quot;:&quot;abc&quot;}"></figure>';

    expect(fragmentByCanonicalizingAttachments(html).toHtml()).toContain('sgid="abc"');
  });

  it("keeps a caption", () => {
    const html = '<figure data-trix-attachment-sgid="abc" data-trix-caption="Hi"></figure>';

    expect(fragmentByCanonicalizingAttachments(html).toHtml()).toContain('caption="Hi"');
  });

  /** A figure that is not an attachment is just a figure. */
  it("leaves a figure with no sgid alone", () => {
    const html = "<figure><img src=/x></figure>";

    expect(fragmentByCanonicalizingAttachments(html).toHtml()).toBe(html);
  });

  it("converts back the other way", () => {
    const html = `<${ATTACHMENT_SELECTOR} sgid="abc"></${ATTACHMENT_SELECTOR}>`;

    expect(fragmentByConvertingTrixAttachments(html).toHtml()).toBe(
      '<figure data-trix-attachment-sgid="abc"></figure>',
    );
  });
});

describe("galleries", () => {
  const gallery = `<div class="attachment-gallery attachment-gallery--2"><${ATTACHMENT_SELECTOR} sgid="a"></${ATTACHMENT_SELECTOR}></div>`;

  it("unwraps a gallery when canonicalizing", () => {
    expect(fragmentByCanonicalizingAttachmentGalleries(gallery).toHtml()).toBe(
      `<${ATTACHMENT_SELECTOR} sgid="a"></${ATTACHMENT_SELECTOR}>`,
    );
  });

  it("leaves other divs alone", () => {
    const html = '<div class="note">text</div>';

    expect(fragmentByCanonicalizingAttachmentGalleries(html).toHtml()).toBe(html);
  });

  it("replaces a gallery with something else", () => {
    const replaced = fragmentByReplacingAttachmentGalleryNodes(
      gallery,
      (inner) => `<section>${inner}</section>`,
    );

    expect(replaced.toHtml()).toContain("<section>");
  });

  it("hands the inner markup to the replacement", () => {
    const seen: string[] = [];
    fragmentByReplacingAttachmentGalleryNodes(gallery, (inner) => {
      seen.push(inner);
      return inner;
    });

    expect(seen[0]).toContain('sgid="a"');
  });
});

describe("minifying", () => {
  /**
   * The renderer decides how an attachment looks each time, so a stored copy
   * of last year's markup renders differently from a new one for no visible
   * reason.
   */
  it("keeps only the sgid", () => {
    const html = `<${ATTACHMENT_SELECTOR} sgid="abc" width="100" caption="Hi" url="/x"></${ATTACHMENT_SELECTOR}>`;

    expect(fragmentByMinifyingAttachments(html).toHtml()).toBe(
      `<${ATTACHMENT_SELECTOR} sgid="abc"></${ATTACHMENT_SELECTOR}>`,
    );
  });

  it("leaves an attachment with no sgid alone", () => {
    const html = `<${ATTACHMENT_SELECTOR} width="100"></${ATTACHMENT_SELECTOR}>`;

    expect(fragmentByMinifyingAttachments(html).toHtml()).toBe(html);
  });

  it("leaves the surrounding text alone", () => {
    const html = `<p>before</p><${ATTACHMENT_SELECTOR} sgid="a" width="1"></${ATTACHMENT_SELECTOR}><p>after</p>`;

    expect(fragmentByMinifyingAttachments(html).toHtml()).toContain("<p>before</p>");
    expect(fragmentByMinifyingAttachments(html).toHtml()).toContain("<p>after</p>");
  });
});

describe("canonicalizing content", () => {
  /** The stored body is the one shape everything else is derived from. */
  it("does both conversions", () => {
    const html =
      '<div class="attachment-gallery"><figure data-trix-attachment-sgid="a"></figure></div>';

    expect(fragmentByCanonicalizingContent(html).toHtml()).toBe(
      `<${ATTACHMENT_SELECTOR} sgid="a"></${ATTACHMENT_SELECTOR}>`,
    );
  });

  it("leaves ordinary markup alone", () => {
    expect(fragmentByCanonicalizingContent("<p>Hi</p>").toHtml()).toBe("<p>Hi</p>");
  });
});
