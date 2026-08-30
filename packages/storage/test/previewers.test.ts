/**
 * The tools a preview needs, ported from
 * `activestorage/test/models/preview_test.rb` and the previewer cases in
 * `activestorage/test/previewer/`.
 *
 * `representable.ts` says a PDF is previewable, and its own comment says that
 * listing a type there is a promise a previewer exists for it. Nothing was
 * keeping that promise: a view that asked and believed the answer rendered an
 * image tag pointing at nothing.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  FFMPEG,
  MUTOOL,
  PDFTOPPM,
  canPreview,
  ffmpegExists,
  ffmpegPath,
  missingPreviewerFor,
  mutoolExists,
  mutoolPath,
  pdftoppmExists,
  pdftoppmPath,
  previewerExists,
  previewerFor,
  previewerPath,
  resetPreviewerPaths,
  setPreviewerPath,
} from "../src/previewers.js";
import { isPreviewable } from "../src/representable.js";

afterEach(() => {
  resetPreviewerPaths();
});

describe("finding a tool", () => {
  it("takes a path it is given", () => {
    setPreviewerPath(FFMPEG, "/opt/bin/ffmpeg");

    expect(ffmpegPath()).toBe("/opt/bin/ffmpeg");
    expect(ffmpegExists()).toBe(true);
  });

  /** A machine with two versions should not depend on how PATH was ordered. */
  it("prefers what it was configured with over what is on PATH", () => {
    setPreviewerPath(MUTOOL, "/opt/bin/mutool");

    expect(mutoolPath()).toBe("/opt/bin/mutool");
  });

  it("can be told a tool is not there", () => {
    setPreviewerPath(PDFTOPPM, null);

    expect(pdftoppmPath()).toBeNull();
    expect(pdftoppmExists()).toBe(false);
  });

  it("reports each tool's presence by its own name", () => {
    setPreviewerPath(MUTOOL, "/opt/bin/mutool");
    setPreviewerPath(PDFTOPPM, null);

    expect(mutoolExists()).toBe(true);
    expect(pdftoppmExists()).toBe(false);
  });

  it("forgets what it was told", () => {
    setPreviewerPath(FFMPEG, "/opt/bin/ffmpeg");
    resetPreviewerPaths();

    expect(ffmpegPath()).toBe(Bun.which("ffmpeg"));
  });

  it("looks each tool up separately", () => {
    setPreviewerPath(FFMPEG, "/opt/bin/ffmpeg");
    setPreviewerPath(MUTOOL, null);

    expect(previewerPath(FFMPEG)).toBe("/opt/bin/ffmpeg");
    expect(previewerExists(MUTOOL)).toBe(false);
  });

  /** Asked once per attachment on a page; thirty thumbnails is thirty walks. */
  it("answers the same thing twice without searching again", () => {
    const first = ffmpegPath();

    expect(ffmpegPath()).toBe(first);
  });
});

describe("choosing a previewer", () => {
  it("sends video to ffmpeg", () => {
    expect(previewerFor("video/mp4")).toBe(FFMPEG);
    expect(previewerFor("video/quicktime")).toBe(FFMPEG);
  });

  /** One binary, no rendering dependencies, so it goes first. */
  it("prefers mutool for a pdf when it is there", () => {
    setPreviewerPath(MUTOOL, "/opt/bin/mutool");
    setPreviewerPath(PDFTOPPM, "/opt/bin/pdftoppm");

    expect(previewerFor("application/pdf")).toBe(MUTOOL);
  });

  it("falls back to pdftoppm, which most linux images already have", () => {
    setPreviewerPath(MUTOOL, null);
    setPreviewerPath(PDFTOPPM, "/opt/bin/pdftoppm");

    expect(previewerFor("application/pdf")).toBe(PDFTOPPM);
  });

  /** Named anyway, so a caller can say which tool to install. */
  it("still names one when neither is installed", () => {
    setPreviewerPath(MUTOOL, null);
    setPreviewerPath(PDFTOPPM, null);

    expect(previewerFor("application/pdf")).toBe(MUTOOL);
  });

  it("has none for an image, which needs no previewer", () => {
    expect(previewerFor("image/jpeg")).toBeNull();
  });

  it("has none for a spreadsheet", () => {
    expect(previewerFor("application/vnd.ms-excel")).toBeNull();
  });

  it("ignores parameters and case on the content type", () => {
    expect(previewerFor("APPLICATION/PDF; charset=binary")).toBe(MUTOOL);
    expect(previewerFor("VIDEO/MP4")).toBe(FFMPEG);
  });

  it("has none for nothing at all", () => {
    expect(previewerFor(null)).toBeNull();
    expect(previewerFor("")).toBeNull();
  });
});

describe("canPreview", () => {
  /**
   * The distinction this file exists for. isPreviewable is about the format
   * and is the same on every machine, which is what a stored value wants.
   * canPreview is about this machine, which is what a view wants before it
   * renders an image tag a missing binary would leave broken.
   */
  it("is false for a previewable format with no tool installed", () => {
    setPreviewerPath(MUTOOL, null);
    setPreviewerPath(PDFTOPPM, null);

    expect(isPreviewable("application/pdf")).toBe(true);
    expect(canPreview("application/pdf")).toBe(false);
  });

  it("is true once the tool is there", () => {
    setPreviewerPath(MUTOOL, "/opt/bin/mutool");

    expect(canPreview("application/pdf")).toBe(true);
  });

  it("is true for a pdf when only the fallback is there", () => {
    setPreviewerPath(MUTOOL, null);
    setPreviewerPath(PDFTOPPM, "/opt/bin/pdftoppm");

    expect(canPreview("application/pdf")).toBe(true);
  });

  it("follows the video tool", () => {
    setPreviewerPath(FFMPEG, null);

    expect(canPreview("video/mp4")).toBe(false);

    setPreviewerPath(FFMPEG, "/opt/bin/ffmpeg");

    expect(canPreview("video/mp4")).toBe(true);
  });

  it("is false for something no previewer handles", () => {
    expect(canPreview("image/png")).toBe(false);
    expect(canPreview(null)).toBe(false);
  });
});

describe("saying what is missing", () => {
  it("names the tool to install", () => {
    setPreviewerPath(MUTOOL, null);
    setPreviewerPath(PDFTOPPM, null);

    expect(missingPreviewerFor("application/pdf")).toContain("mutool");
    expect(missingPreviewerFor("application/pdf")).toContain("PDF");
  });

  it("names ffmpeg for video", () => {
    setPreviewerPath(FFMPEG, null);

    expect(missingPreviewerFor("video/mp4")).toContain("ffmpeg");
  });

  it("says nothing when the tool is there", () => {
    setPreviewerPath(FFMPEG, "/opt/bin/ffmpeg");

    expect(missingPreviewerFor("video/mp4")).toBeNull();
  });

  it("says nothing for a format that needs no previewer", () => {
    expect(missingPreviewerFor("image/png")).toBeNull();
  });
});
