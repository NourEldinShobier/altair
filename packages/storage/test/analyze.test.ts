/**
 * Reading what a blob is.
 *
 * Mirrors activestorage/test/analyzer/image_analyzer_test.rb.
 *
 * What it is for is answering questions about a file without fetching it
 * again. A page laying out a gallery needs every image's dimensions to reserve
 * space before they load, and the alternative to storing them is downloading a
 * hundred images to measure them.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connection, SchemaStatements, setConnection } from "@altair/orm";
import {
  DiskService,
  StorageBlob,
  analyze,
  analyzeBytes,
  configureStorage,
  createBlob,
  createStorageTables,
  isAnalyzable,
  resetStorage,
} from "../src/index.js";

/** A ten-by-five PNG, small enough to keep here. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAFCAYAAABPMor8AAAAFElEQVR4nGP8//8/AzJgYkAFVOMDAJK9AwUj9j8jAAAAAElFTkSuQmCC",
  "base64",
);

let root: string;
let connection: Connection;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "altair-analyze-"));
  configureStorage({
    services: { disk: new DiskService({ root, secret: "a".repeat(32) }) },
    default: "disk",
  });

  connection = new Connection("sqlite://:memory:");
  setConnection(connection);
  StorageBlob.columnCache = undefined;
  StorageBlob.columnTypeCache = undefined;

  await createStorageTables(new SchemaStatements(connection));
});

afterEach(async () => {
  resetStorage();
  await rm(root, { recursive: true, force: true });
});

describe("what it will read", () => {
  it("reads an image", () => {
    expect(isAnalyzable("image/png")).toBe(true);
    expect(isAnalyzable("image/jpeg")).toBe(true);
  });

  // Rails has analyzers for these too, and they need ffprobe. This has images,
  // which need nothing that is not already here.
  it("leaves anything else alone", () => {
    expect(isAnalyzable("text/plain")).toBe(false);
    expect(isAnalyzable("video/mp4")).toBe(false);
    expect(isAnalyzable(null)).toBe(false);
    expect(isAnalyzable(undefined)).toBe(false);
  });
});

describe("reading bytes", () => {
  it("finds the dimensions and the format", async () => {
    expect(await analyzeBytes(PNG, "image/png")).toEqual({
      width: 10,
      height: 5,
      format: "png",
      analyzed: true,
    });
  });

  it("says nothing about a file it cannot read", async () => {
    expect(await analyzeBytes(new TextEncoder().encode("hello"), "text/plain")).toBeNull();
  });

  /**
   * An upload that is not the image it claimed is the user's problem to see,
   * not the upload's to fail on — and marking it analysed stops every page
   * that renders it from trying again.
   */
  it("records a file that is not what it says it is", async () => {
    const analysis = await analyzeBytes(new TextEncoder().encode("not a png"), "image/png");

    expect(analysis).toEqual({ analyzed: true });
  });
});

describe("analysing a blob", () => {
  const upload = async (metadata?: Record<string, unknown>) =>
    await createBlob({
      filename: "picture.png",
      data: PNG,
      contentType: "image/png",
      metadata,
    });

  it("stores what it found", async () => {
    const blob = await upload();
    await analyze(blob);

    expect(blob.metadataObject()).toMatchObject({ width: 10, height: 5, format: "png" });
  });

  it("survives being read back", async () => {
    const blob = await upload();
    await analyze(blob);

    const again = (await StorageBlob.findBy({ id: blob.id })) as StorageBlob;

    expect(again.metadataObject()).toMatchObject({ width: 10, height: 5 });
  });

  // Whatever was put there at upload — a caption, an uploader id — is not this
  // function's to discard.
  it("keeps the metadata that was already there", async () => {
    const blob = await upload({ caption: "a small rectangle" });
    await analyze(blob);

    expect(blob.metadataObject()).toMatchObject({
      caption: "a small rectangle",
      width: 10,
    });
  });

  // What makes it safe to call from a view: the first render pays for it.
  it("does not do it twice", async () => {
    const blob = await upload();
    await analyze(blob);

    // Whatever it finds the second time, it must not go looking.
    let downloads = 0;
    const original = blob.download.bind(blob);
    blob.download = async () => {
      downloads += 1;
      return await original();
    };

    await analyze(blob);

    expect(downloads).toBe(0);
  });

  it("says nothing for a blob that is not an image", async () => {
    const blob = await createBlob({
      filename: "notes.txt",
      data: new TextEncoder().encode("hello"),
      contentType: "text/plain",
    });

    expect(await analyze(blob)).toBeNull();
    expect(blob.metadataObject().analyzed).toBeUndefined();
  });
});
