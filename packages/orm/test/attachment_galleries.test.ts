/**
 * Runs of attachments laid out as a set, ported from
 * `actiontext/test/unit/attachment_gallery_test.rb`.
 *
 * Two images in a row are a gallery and should lay out side by side; one image
 * is an image. That distinction lives on the server rather than in the editor
 * because the stored body is the canonical form, and a body written by an API
 * client, a script or an import has no editor to have added a wrapper.
 */

import { describe, expect, it } from "bun:test";
import {
  attachmentGalleriesIn,
  hasAttachmentGalleries,
  withAttachmentGalleries,
  withoutAttachmentGalleries,
} from "../src/attachables.js";

const attachment = (sgid: string) =>
  `<action-text-attachment sgid="${sgid}"></action-text-attachment>`;

describe("wrapping a run", () => {
  it("wraps two neighbours", () => {
    const wrapped = withAttachmentGalleries(attachment("a") + attachment("b"));

    expect(wrapped).toContain('class="attachment-gallery attachment-gallery--2"');
  });

  /**
   * The count is in the class because the stylesheet needs to know how many are
   * in the row to size them, and CSS cannot count its own children well enough
   * to do it for four different cases.
   */
  it("says how many are in it", () => {
    const wrapped = withAttachmentGalleries(attachment("a") + attachment("b") + attachment("c"));

    expect(wrapped).toContain("attachment-gallery--3");
  });

  /** A run of one is an image, not a gallery. That is the whole rule. */
  it("leaves a lone attachment alone", () => {
    const html = `<p>Look</p>${attachment("a")}<p>at that</p>`;

    expect(withAttachmentGalleries(html)).toBe(html);
  });

  it("keeps the attachments inside", () => {
    const wrapped = withAttachmentGalleries(attachment("a") + attachment("b"));

    expect(wrapped).toContain('sgid="a"');
    expect(wrapped).toContain('sgid="b"');
  });

  it("allows whitespace between them", () => {
    const wrapped = withAttachmentGalleries(`${attachment("a")}\n  ${attachment("b")}`);

    expect(wrapped).toContain("attachment-gallery--2");
  });

  /**
   * Attachments that happen to be near each other are not a set. Anything
   * between them — a paragraph, a heading, a sentence — ends the run.
   */
  it("does not join two separated by prose", () => {
    const html = `${attachment("a")}<p>and later</p>${attachment("b")}`;

    expect(withAttachmentGalleries(html)).not.toContain("attachment-gallery");
  });

  it("wraps each run separately", () => {
    const html =
      attachment("a") + attachment("b") + "<p>then</p>" + attachment("c") + attachment("d");

    const wrapped = withAttachmentGalleries(html);

    expect(wrapped.match(/attachment-gallery--2/g)).toHaveLength(2);
  });

  it("leaves a body with no attachments untouched", () => {
    expect(withAttachmentGalleries("<p>Just words</p>")).toBe("<p>Just words</p>");
  });
});

/**
 * What is stored is the canonical form. Storing the wrapper would freeze one
 * version of the markup into every body ever written, so a change to how a
 * gallery is laid out would reach new content and leave the archive alone.
 */
describe("taking the wrapper back off", () => {
  it("leaves the attachments where they were", () => {
    const wrapped = withAttachmentGalleries(attachment("a") + attachment("b"));

    expect(withoutAttachmentGalleries(wrapped)).toBe(attachment("a") + attachment("b"));
  });

  it("round-trips", () => {
    const canonical = `<p>Before</p>${attachment("a")}${attachment("b")}<p>After</p>`;

    expect(withoutAttachmentGalleries(withAttachmentGalleries(canonical))).toBe(canonical);
  });

  it("does nothing to a body that has none", () => {
    const html = `<p>Words</p>${attachment("a")}`;

    expect(withoutAttachmentGalleries(html)).toBe(html);
  });

  it("takes off more than one", () => {
    const html =
      attachment("a") + attachment("b") + "<p>then</p>" + attachment("c") + attachment("d");

    expect(withoutAttachmentGalleries(withAttachmentGalleries(html))).toBe(html);
  });
});

describe("asking what is there", () => {
  it("knows a body carries galleries", () => {
    expect(hasAttachmentGalleries(withAttachmentGalleries(attachment("a") + attachment("b")))).toBe(
      true,
    );
  });

  it("knows one does not", () => {
    expect(hasAttachmentGalleries(attachment("a"))).toBe(false);
  });

  it("hands back the attachments of each gallery, in order", () => {
    const html = withAttachmentGalleries(
      attachment("a") + attachment("b") + "<p>then</p>" + attachment("c") + attachment("d"),
    );

    const galleries = attachmentGalleriesIn(html);

    expect(galleries).toHaveLength(2);
    expect(galleries[0]?.map((one) => one.sgid)).toEqual(["a", "b"]);
    expect(galleries[1]?.map((one) => one.sgid)).toEqual(["c", "d"]);
  });

  it("finds none in a body with none", () => {
    expect(attachmentGalleriesIn(attachment("a"))).toEqual([]);
  });
});
