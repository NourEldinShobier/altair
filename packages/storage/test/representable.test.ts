/**
 * Blob representability, ported from
 * `activestorage/test/models/representation_test.rb`.
 */

import { describe, expect, it } from "bun:test";
import {
  isAudio,
  isImage,
  isPreviewable,
  isRepresentable,
  isText,
  isVariable,
  isVideo,
  previewableTypes,
  registerPreviewableType,
  representationFor,
} from "../src/representable.js";

describe("variable", () => {
  it("says yes to an image the processor handles", () => {
    expect(isVariable("image/jpeg")).toBe(true);
    expect(isVariable("image/png")).toBe(true);
  });

  it("says no to a PDF", () => {
    expect(isVariable("application/pdf")).toBe(false);
  });

  it("says no to nothing at all", () => {
    expect(isVariable(null)).toBe(false);
    expect(isVariable(undefined)).toBe(false);
  });
});

describe("previewable", () => {
  it("says yes to a PDF", () => {
    expect(isPreviewable("application/pdf")).toBe(true);
  });

  it("says yes to a video", () => {
    expect(isPreviewable("video/mp4")).toBe(true);
    expect(isPreviewable("video/quicktime")).toBe(true);
  });

  it("says no to an image, which needs no previewer", () => {
    expect(isPreviewable("image/jpeg")).toBe(false);
  });

  it("says no to a spreadsheet", () => {
    expect(isPreviewable("application/vnd.ms-excel")).toBe(false);
  });

  it("ignores parameters on the content type", () => {
    expect(isPreviewable("application/pdf; charset=binary")).toBe(true);
  });

  it("ignores case", () => {
    expect(isPreviewable("APPLICATION/PDF")).toBe(true);
  });

  it("says no to nothing at all", () => {
    expect(isPreviewable(null)).toBe(false);
    expect(isPreviewable("")).toBe(false);
  });
});

describe("representable", () => {
  /**
   * The one a view should ask. A template that assumes every attachment is
   * variable throws on the first PDF; one that assumes none is shows a file
   * icon next to a photo.
   */
  it("covers both routes", () => {
    expect(isRepresentable("image/png")).toBe(true);
    expect(isRepresentable("application/pdf")).toBe(true);
  });

  it("says no to something neither", () => {
    expect(isRepresentable("application/zip")).toBe(false);
    expect(isRepresentable("text/csv")).toBe(false);
  });
});

describe("representationFor", () => {
  /** Running an image through a previewer would re-encode it for nothing. */
  it("prefers a variant for an image", () => {
    expect(representationFor("image/jpeg")).toBe("variant");
  });

  it("falls back to a preview", () => {
    expect(representationFor("application/pdf")).toBe("preview");
    expect(representationFor("video/mp4")).toBe("preview");
  });

  it("gives null when there is no route", () => {
    expect(representationFor("application/zip")).toBeNull();
    expect(representationFor(null)).toBeNull();
  });
});

describe("the broad classifications", () => {
  it("recognises images, video and audio", () => {
    expect(isImage("image/gif")).toBe(true);
    expect(isVideo("video/webm")).toBe(true);
    expect(isAudio("audio/mpeg")).toBe(true);

    expect(isImage("video/mp4")).toBe(false);
    expect(isVideo("image/png")).toBe(false);
  });

  /** An image can be one this processor cannot transform — SVG, say. */
  it("keeps image separate from variable", () => {
    expect(isImage("image/svg+xml")).toBe(true);
    expect(isVariable("image/svg+xml")).toBe(false);
  });

  it("recognises text in its many spellings", () => {
    expect(isText("text/plain")).toBe(true);
    expect(isText("text/html; charset=utf-8")).toBe(true);
    expect(isText("application/json")).toBe(true);
    expect(isText("application/ld+json")).toBe(true);
    expect(isText("application/xml")).toBe(true);
    expect(isText("image/png")).toBe(false);
  });

  it("says no to nothing at all", () => {
    expect(isImage(null)).toBe(false);
    expect(isText(undefined)).toBe(false);
  });
});

describe("registering a type", () => {
  /** Registering is the honest way to extend the promise a previewer exists. */
  it("takes a previewable type of its own", () => {
    expect(isPreviewable("application/vnd.custom")).toBe(false);

    registerPreviewableType("application/vnd.custom");

    expect(isPreviewable("application/vnd.custom")).toBe(true);
    expect(isRepresentable("application/vnd.custom")).toBe(true);
    expect(previewableTypes()).toContain("application/vnd.custom");
  });

  it("lists what it knows", () => {
    expect(previewableTypes()).toContain("application/pdf");
  });
});
