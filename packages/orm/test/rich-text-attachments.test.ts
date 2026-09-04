/**
 * Attachments inside rich text, ported from
 * `actiontext/test/unit/content_test.rb`,
 * `actiontext/test/unit/attachment_test.rb` and the reflection cases in
 * `activestorage/test/models/reflection_test.rb`.
 *
 * The whole feature turns on storing a *reference* rather than a rendering, so
 * the cases are mostly about what gets dropped on the way in.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  actionControllerRenderer,
  addAttachmentReflection,
  attachmentReflectionsFor,
  createElement,
  deconstruct,
  fillInRichTextarea,
  fragmentByConvertingEditorAttachments,
  iamClient,
  links,
  mirrorLater,
  processor,
  renderIn,
  resetActionControllerRenderer,
  resetAttachmentReflections,
  updateMetadata,
  urlForDirectUpload,
} from "../src/rich-text-attachments.js";

afterEach(() => {
  resetAttachmentReflections();
  resetActionControllerRenderer();
});

describe("writing an attachment into a body", () => {
  it("keeps the reference and the caption", () => {
    expect(createElement({ sgid: "abc", contentType: "image/png", caption: "A cat" })).toBe(
      '<action-text-attachment sgid="abc" content-type="image/png" caption="A cat">' +
        "</action-text-attachment>",
    );
  });

  /**
   * An empty caption is one a user cleared, and writing it back would make the
   * tag claim a caption that renders as a blank line under the attachment.
   */
  it("leaves out a caption that is not there or was cleared", () => {
    expect(createElement({ sgid: "abc" })).toBe(
      '<action-text-attachment sgid="abc"></action-text-attachment>',
    );
    expect(createElement({ sgid: "abc", caption: "" })).not.toContain("caption");
  });

  /** A caption is text a user typed, so it is escaped rather than trusted. */
  it("escapes a caption", () => {
    expect(createElement({ sgid: "abc", caption: '"><script>' })).not.toContain("<script>");
  });

  /**
   * Everything the editor put inside is stale the moment it is saved — a file
   * renamed, a variant regenerated, a blob deleted — so only the reference
   * survives.
   */
  it("drops the editor's own markup", () => {
    const editor =
      '<action-text-attachment sgid="abc" caption="A cat">' +
      '<figure><img src="/expired/thumb.png"><figcaption>cat.png</figcaption></figure>' +
      "</action-text-attachment>";

    const stored = fragmentByConvertingEditorAttachments(editor);

    expect(stored).not.toContain("img");
    expect(stored).toContain('sgid="abc"');
    expect(stored).toContain('caption="A cat"');
  });

  /**
   * A tag with no reference is markup somebody pasted, and keeping it leaves
   * one the renderer will later try to resolve and fail on.
   */
  it("drops a tag with no reference", () => {
    expect(
      fragmentByConvertingEditorAttachments("<action-text-attachment></action-text-attachment>"),
    ).toBe("");
  });

  it("leaves the rest of the body alone", () => {
    const body =
      '<p>Before</p><action-text-attachment sgid="a"></action-text-attachment><p>After</p>';

    expect(fragmentByConvertingEditorAttachments(body)).toContain("<p>Before</p>");
    expect(fragmentByConvertingEditorAttachments(body)).toContain("<p>After</p>");
  });
});

describe("reading a body", () => {
  const body =
    '<action-text-attachment sgid="a" caption="One"></action-text-attachment>' +
    '<action-text-attachment sgid="b"></action-text-attachment>';

  /**
   * Read out of the stored form rather than tracked alongside it: a body
   * edited to remove an attachment would otherwise leave a tracked reference
   * keeping a blob alive forever.
   */
  it("lists the attachments", () => {
    expect(deconstruct(body)).toEqual([{ sgid: "a", caption: "One" }, { sgid: "b" }]);
  });

  it("lists none for a body with none", () => {
    expect(deconstruct("<p>Just text</p>")).toEqual([]);
  });

  /** A tag with no reference is markup somebody pasted, not an attachment. */
  it("skips a tag with no reference", () => {
    expect(
      deconstruct('<action-text-attachment caption="No sgid"></action-text-attachment>'),
    ).toEqual([]);
  });

  it("unescapes a caption on the way out", () => {
    expect(deconstruct('<action-text-attachment sgid="a" caption="A &amp; B">')[0]?.caption).toBe(
      "A & B",
    );
  });

  /**
   * The ampersand is decoded last, or `&amp;lt;` becomes `<` — a caption that
   * displayed the text `&lt;` would start displaying a tag instead.
   */
  it("does not double-decode an escaped entity", () => {
    expect(
      deconstruct('<action-text-attachment sgid="a" caption="&amp;lt;b&amp;gt;">')[0]?.caption,
    ).toBe("&lt;b&gt;");
  });

  /** A body linking one page from a heading and a footer is one destination. */
  it("lists each link once", () => {
    const linked = '<a href="/posts">One</a><a href="/posts">Two</a><a href="/other">Three</a>';

    expect(links(linked)).toEqual(["/posts", "/other"]);
  });

  it("lists no links for a body with none", () => {
    expect(links("<p>Text</p>")).toEqual([]);
  });
});

describe("rendering an attachment", () => {
  /** What makes a renamed file show its new name. */
  it("rebuilds from the record", () => {
    const rendered = renderIn(
      { sgid: "a", caption: "Cap" },
      () => ({ id: 1 }) as never,
      (attachable, caption) => `<figure>${JSON.stringify(attachable)}${caption}</figure>`,
    );

    expect(rendered).toContain("Cap");
    expect(rendered).toContain('"id":1');
  });

  /**
   * The document is still readable, and a missing attachment is a fact about
   * the data rather than an error in the page.
   */
  it("renders nothing for a reference that is gone", () => {
    expect(
      renderIn(
        { sgid: "a" },
        () => undefined,
        () => "<figure>",
      ),
    ).toBe("");
  });

  /**
   * A renderer carries the view paths and the compiled template cache, so one
   * per body would recompile the attachment partial for every attachment in
   * every document.
   */
  it("builds one renderer and keeps it", () => {
    let built = 0;
    const build = () => {
      built += 1;

      return {};
    };

    const first = actionControllerRenderer(build);

    expect(actionControllerRenderer(build)).toBe(first);
    expect(built).toBe(1);
  });

  /**
   * The editor keeps its own document model, so writing to the DOM leaves the
   * two disagreeing — and what gets submitted is whatever the model had.
   */
  it("types through the editor rather than into the DOM", () => {
    const { script } = fillInRichTextarea("#body", "<p>Hi</p>");

    expect(script).toContain("editor.loadHTML");
    expect(script).not.toContain("innerHTML");
  });
});

describe("attachments as an association", () => {
  /**
   * Without a reflection, every generic tool — a serializer, an admin
   * interface, a form builder — needs a special case for attachments, and each
   * gets it slightly wrong.
   */
  it("registers so generic code can find it", () => {
    addAttachmentReflection("Post", {
      name: "cover",
      macro: "hasOneAttached",
      blobAssociation: "cover_blob",
    });

    expect(attachmentReflectionsFor("Post")).toHaveLength(1);
    expect(attachmentReflectionsFor("Comment")).toEqual([]);
  });

  it("keeps several on one model", () => {
    addAttachmentReflection("Post", { name: "a", macro: "hasOneAttached", blobAssociation: "x" });
    addAttachmentReflection("Post", { name: "b", macro: "hasManyAttached", blobAssociation: "y" });

    expect(attachmentReflectionsFor("Post").map((each) => each.name)).toEqual(["a", "b"]);
  });
});

describe("uploading straight to storage", () => {
  const blob = { key: "abc", checksum: "md5==", byteSize: 10, contentType: "image/png" };

  it("carries the checksum and the size", () => {
    const upload = urlForDirectUpload(blob);

    expect(upload.headers["Content-MD5"]).toBe("md5==");
    expect(upload.headers["Content-Length"]).toBe("10");
    expect(upload.expiresIn).toBe(300);
  });

  /**
   * Without it the service accepts whatever bytes arrive, so a request
   * truncated in transit stores a corrupt file the application believes is the
   * one it authorised.
   */
  it("refuses to sign one with no checksum", () => {
    expect(() => urlForDirectUpload({ ...blob, checksum: "" })).toThrow("truncated in transit");
  });

  /**
   * A mirror is for durability rather than serving, so making the upload wait
   * for a slow secondary turns it into a failed upload — and the file is
   * already safely in the primary.
   */
  it("mirrors in the background", () => {
    expect(mirrorLater("abc", ["backup", "archive"])).toEqual({
      key: "abc",
      services: ["backup", "archive"],
    });
  });

  /**
   * A video probe after an image probe knows different things about the same
   * file, and replacing would leave the blob describing only whichever ran
   * last.
   */
  it("merges what analysis learned", () => {
    expect(updateMetadata({ width: 100 }, { duration: 5 })).toEqual({
      width: 100,
      duration: 5,
      analyzed: true,
    });
  });

  /**
   * The two produce different output for the same transformation, so a variant
   * generated by one and cached under a key that does not mention it is served
   * to somebody expecting the other.
   */
  it("names the processor rather than detecting it", () => {
    expect(processor()).toBe("vips");
    expect(processor("mini_magick")).toBe("mini_magick");
  });

  /**
   * IAM-signed URLs need a round trip to the signing service, so a page with
   * fifty thumbnails makes fifty of them — an application that can use a static
   * credential should, and one that cannot has to know it is paying.
   */
  it("says when signing needs a round trip", () => {
    expect(iamClient({ iamRole: "storage-signer" })).toBe(true);
    expect(iamClient({ credentials: {}, iamRole: "storage-signer" })).toBe(false);
    expect(iamClient({})).toBe(false);
  });
});
