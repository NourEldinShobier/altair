/**
 * Turning rich text back into markup, ported from
 * `actiontext/test/unit/content_test.rb` and
 * `actiontext/test/template/attachment_test.rb`.
 *
 * Two forms, and confusing them is the bug. The editor's form carries the
 * attachment's reference so a round trip keeps it; the page's form resolves
 * it. Writing the page's form back to the column replaces the reference with
 * its rendering, and the attachment can never be resolved again.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  GALLERY_MINIMUM,
  asCanonical,
  asEditable,
  clearAttachmentRenderers,
  editorName,
  isGallery,
  previewableAttachable,
  registerAttachmentRenderer,
  renderAttachment,
  renderAttachmentGalleries,
  rendererFor,
  resetRichTextRendering,
  setEditorName,
  setFallbackRenderer,
  toEditorAttachment,
  toEditorContentAttachmentPartialPath,
  toRenderedHtmlWithLayout,
  toTrixContentAttachmentPartialPath,
  toTrixHtml,
  withRenderer,
} from "../src/rich-text-rendering.js";
import type { RenderableAttachment } from "../src/rich-text-rendering.js";
import type { AttachedNode } from "../src/content.js";

afterEach(() => {
  resetRichTextRendering();
});

const picture: RenderableAttachment = {
  sgid: "sgid-1",
  contentType: "image/png",
  filename: "cat.png",
  url: "/files/cat.png",
};

const document = '<p>Look</p><figure data-trix-attachment-sgid="sgid-1"></figure><p>Nice</p>';

describe("choosing a renderer", () => {
  it("uses one registered for the exact type", () => {
    registerAttachmentRenderer("image/png", () => "<png/>");

    expect(renderAttachment(picture)).toBe("<png/>");
  });

  /**
   * A registry keyed only on the full type has to list every format, and the
   * one it forgets renders as a bare link on a page full of pictures.
   */
  it("falls back on the type's family", () => {
    registerAttachmentRenderer("image/", () => "<any image/>");

    expect(renderAttachment(picture)).toBe("<any image/>");
  });

  it("prefers the exact type over the family", () => {
    registerAttachmentRenderer("image/", () => "<any image/>");
    registerAttachmentRenderer("image/png", () => "<png/>");

    expect(renderAttachment(picture)).toBe("<png/>");
  });

  it("falls back to a link when nothing claims it", () => {
    expect(
      renderAttachment({ sgid: "s", contentType: "application/zip", filename: "a.zip" }),
    ).toContain("a.zip");
  });

  it("uses the fallback for an attachment with no type at all", () => {
    expect(rendererFor(undefined)).toBeInstanceOf(Function);
    expect(renderAttachment({ sgid: "s", filename: "unknown" })).toContain("unknown");
  });

  it("takes a fallback of its own", () => {
    setFallbackRenderer(() => "<nothing/>");

    expect(renderAttachment({ sgid: "s", contentType: "application/zip" })).toBe("<nothing/>");
  });

  it("runs something with a different fallback and puts it back", () => {
    const before = renderAttachment({ sgid: "s", filename: "a" });

    withRenderer(
      () => "<temporary/>",
      () => {
        expect(renderAttachment({ sgid: "s", filename: "a" })).toBe("<temporary/>");
      },
    );

    expect(renderAttachment({ sgid: "s", filename: "a" })).toBe(before);
  });

  it("puts it back even when the body throws", () => {
    const before = renderAttachment({ sgid: "s", filename: "a" });

    expect(() =>
      withRenderer(
        () => "<temporary/>",
        () => {
          throw new Error("boom");
        },
      ),
    ).toThrow("boom");

    expect(renderAttachment({ sgid: "s", filename: "a" })).toBe(before);
  });

  it("forgets what was registered", () => {
    registerAttachmentRenderer("image/png", () => "<png/>");
    clearAttachmentRenderers();

    expect(renderAttachment(picture)).not.toBe("<png/>");
  });
});

describe("what can be shown rather than linked", () => {
  it("says yes to an image", () => {
    expect(previewableAttachable(picture)).toBe(true);
  });

  it("says yes to a video", () => {
    expect(previewableAttachable({ sgid: "s", contentType: "video/mp4" })).toBe(true);
  });

  it("says no to a document", () => {
    expect(previewableAttachable({ sgid: "s", contentType: "application/pdf" })).toBe(false);
  });

  it("says no when nothing said what it is", () => {
    expect(previewableAttachable({ sgid: "s" })).toBe(false);
  });
});

describe("the editor's form", () => {
  /**
   * The reference has to survive the round trip. A placeholder that lost it
   * leaves the attachment unreachable the moment somebody edits the paragraph
   * next to it.
   */
  it("carries the reference", () => {
    expect(toEditorAttachment(picture)).toContain('data-trix-attachment-sgid="sgid-1"');
  });

  it("carries the content type", () => {
    expect(toEditorAttachment(picture)).toContain('data-trix-content-type="image/png"');
  });

  it("leaves the type out when there is none", () => {
    expect(toEditorAttachment({ sgid: "s" })).not.toContain("content-type");
  });

  it("shows the caption", () => {
    expect(toEditorAttachment({ sgid: "s", caption: "A cat" })).toContain("A cat");
  });

  it("falls back to the filename", () => {
    expect(toEditorAttachment(picture)).toContain("cat.png");
  });

  it("escapes what would otherwise be markup", () => {
    expect(toEditorAttachment({ sgid: "s", caption: '<script>"x"' })).toContain("&lt;script&gt;");
  });

  it("does not resolve anything", () => {
    registerAttachmentRenderer("image/png", () => "<resolved/>");

    expect(toEditorAttachment(picture)).not.toContain("<resolved/>");
  });
});

describe("a whole document", () => {
  it("gives the editor placeholders", () => {
    registerAttachmentRenderer("image/png", () => "<img/>");

    const editable = toTrixHtml(document, [picture]);

    expect(editable).toContain("data-trix-attachment-sgid");
    expect(editable).not.toContain("<img/>");
  });

  it("gives a page the rendered attachment", () => {
    registerAttachmentRenderer("image/png", () => "<img/>");

    const rendered = toRenderedHtmlWithLayout(document, [picture]);

    expect(rendered).toContain("<img/>");
  });

  /** The form that must never be written back to the column. */
  it("leaves no reference in the rendered form", () => {
    registerAttachmentRenderer("image/png", () => "<img/>");

    expect(toRenderedHtmlWithLayout(document, [picture])).not.toContain(
      "data-trix-attachment-sgid",
    );
  });

  it("keeps the surrounding text either way", () => {
    expect(toTrixHtml(document, [picture])).toContain("<p>Look</p>");
    expect(toRenderedHtmlWithLayout(document, [picture])).toContain("<p>Nice</p>");
  });

  it("wraps the page form in a layout", () => {
    expect(toRenderedHtmlWithLayout(document, [])).toContain('class="trix-content"');
  });

  it("takes a layout of its own", () => {
    expect(
      toRenderedHtmlWithLayout(document, [], (body) => `<article>${body}</article>`),
    ).toStartWith("<article>");
  });

  it("leaves a document with no attachments alone", () => {
    expect(toTrixHtml("<p>Just text</p>", [])).toBe("<p>Just text</p>");
  });

  it("names the two forms so a caller cannot mix them up", () => {
    registerAttachmentRenderer("image/png", () => "<img/>");

    expect(asEditable(document, [picture])).toBe(toTrixHtml(document, [picture]));
    expect(asCanonical(document, [picture])).toBe(toRenderedHtmlWithLayout(document, [picture]));
  });
});

describe("where a partial lives", () => {
  it("names one per family", () => {
    expect(toTrixContentAttachmentPartialPath("image/png")).toContain("image");
    expect(toEditorContentAttachmentPartialPath("video/mp4")).toContain("video");
  });

  it("keeps the two directions apart", () => {
    expect(toTrixContentAttachmentPartialPath("image/png")).not.toBe(
      toEditorContentAttachmentPartialPath("image/png"),
    );
  });

  it("has one for an attachment with no type", () => {
    expect(toTrixContentAttachmentPartialPath(undefined)).toContain("default");
    expect(toTrixContentAttachmentPartialPath("")).toContain("default");
  });
});

describe("galleries", () => {
  const image = (n: number): AttachedNode => ({
    sgid: `s${String(n)}`,
    contentType: "image/png",
    node: `<figure data-trix-attachment-sgid="s${String(n)}"></figure>`,
  });
  const file: AttachedNode = {
    sgid: "f",
    contentType: "application/pdf",
    node: '<figure data-trix-attachment-sgid="f"></figure>',
  };

  it("groups consecutive images together", () => {
    const groups = renderAttachmentGalleries([image(1), image(2)]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(2);
  });

  /** Two images either side of a paragraph are not a gallery, and grouping them moves it. */
  it("does not group across something else", () => {
    const groups = renderAttachmentGalleries([image(1), file, image(2)]);

    expect(groups).toHaveLength(3);
  });

  it("keeps a lone image on its own", () => {
    expect(renderAttachmentGalleries([image(1)])).toEqual([[image(1)]]);
  });

  it("gives nothing for nothing", () => {
    expect(renderAttachmentGalleries([])).toEqual([]);
  });

  it("closes a run at the end", () => {
    const groups = renderAttachmentGalleries([file, image(1), image(2)]);

    expect(groups).toHaveLength(2);
    expect(groups[1]).toHaveLength(2);
  });

  it("says which groups are big enough to lay out", () => {
    expect(isGallery([image(1), image(2)])).toBe(true);
    expect(isGallery([image(1)])).toBe(false);
    expect(GALLERY_MINIMUM).toBe(2);
  });

  it("does not call a group with something else in it a gallery", () => {
    expect(isGallery([image(1), file])).toBe(false);
  });
});

describe("the editor's name", () => {
  it("is trix by default", () => {
    expect(editorName()).toBe("trix");
  });

  it("can be changed", () => {
    setEditorName("prosemirror");

    expect(editorName()).toBe("prosemirror");
  });

  it("goes back on reset", () => {
    setEditorName("prosemirror");
    resetRichTextRendering();

    expect(editorName()).toBe("trix");
  });
});
