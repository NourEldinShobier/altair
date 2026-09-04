/**
 * Measuring a blob when it arrives, ported from
 * `activestorage/test/models/blob_test.rb` and `analyzer/image_analyzer_test.rb`.
 *
 * Rails defers this to a background job because by then it holds only the blob
 * and would have to download the bytes again. An upload through `createBlob`
 * still has them in hand, so it measures them there and the job is not needed
 * at all.
 *
 * Nothing called the analyser before this: it was written, exported, and never
 * reached, so an uploaded image never knew its own dimensions.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SchemaStatements, setConnection } from "@altair/orm";
import {
  analyzeLater,
  configureAnalysis,
  configureStorage,
  createBlob,
  createStorageTables,
  DiskService,
  resetStorage,
  StorageBlob,
} from "../src/index.js";
import { releaseConnection, storageConnection } from "./support/database.js";

let root: string;
let connection: Awaited<ReturnType<typeof storageConnection>>;

/** A real one-pixel PNG, so there is something to measure. */
const PIXEL = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (character) => character.charCodeAt(0),
);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "altair-analyze-"));
  configureStorage({ services: { disk: new DiskService({ root }) }, default: "disk" });

  connection = await storageConnection();
  setConnection(connection);
  StorageBlob.resetColumnInformation();

  await createStorageTables(new SchemaStatements(connection));
});

afterEach(async () => {
  configureAnalysis({ queue: undefined });
  resetStorage();
  await releaseConnection(connection);
  await rm(root, { recursive: true, force: true });
});

describe("a blob that has just been uploaded", () => {
  it("knows its own dimensions", async () => {
    const blob = await createBlob({ filename: "pixel.png", data: PIXEL });

    expect(blob.metadataObject()).toMatchObject({ width: 1, height: 1 });
  });

  it("is marked analysed, so nothing measures it twice", async () => {
    const blob = await createBlob({ filename: "pixel.png", data: PIXEL });

    expect(blob.metadataObject().analyzed).toBe(true);
  });

  /**
   * The measurement is the truth about the file; a caller's guess is not. But
   * anything the caller supplied that the analyser has no opinion on — a
   * caption, an uploader id — is not the analyser's to discard.
   */
  it("keeps what the caller supplied alongside it", async () => {
    const blob = await createBlob({
      filename: "pixel.png",
      data: PIXEL,
      metadata: { caption: "a pixel" },
    });

    expect(blob.metadataObject()).toMatchObject({ caption: "a pixel", width: 1 });
  });

  it("leaves a file with nothing to measure alone", async () => {
    const blob = await createBlob({
      filename: "notes.txt",
      data: new TextEncoder().encode("hello"),
      contentType: "text/plain",
    });

    expect(blob.metadataObject().width).toBeUndefined();
  });

  /**
   * An upload that is not the image it claimed is the uploader's problem to
   * see, not the upload's to fail on.
   */
  it("does not fail on bytes that are not the image they claim", async () => {
    const blob = await createBlob({
      filename: "lying.png",
      data: new TextEncoder().encode("not a png"),
    });

    expect(blob.metadataObject().analyzed).toBe(true);
    expect(blob.metadataObject().width).toBeUndefined();
  });
});

/**
 * For a direct upload, where the bytes went from the browser to the service and
 * this process never saw them.
 */
describe("analysing out of band", () => {
  it("hands the blob to the queue when there is one", async () => {
    const seen: unknown[] = [];
    configureAnalysis({ queue: (blob) => void seen.push(blob.id) });

    const blob = await createBlob({ filename: "pixel.png", data: PIXEL });
    await analyzeLater(blob);

    expect(seen).toEqual([blob.id]);
  });

  /**
   * Silently doing nothing is how a feature ends up shipped and unused — which
   * is precisely what happened to the analyser before this.
   */
  it("analyses inline when there is no queue", async () => {
    const blob = await createBlob({
      filename: "notes.txt",
      data: new TextEncoder().encode("x"),
      contentType: "text/plain",
    });

    // Cleared, so there is something for the call to do.
    blob.metadata = null;
    await blob.save();

    await analyzeLater(blob);

    expect(blob.metadataObject().analyzed).toBeUndefined();
  });

  it("does nothing to a blob already measured", async () => {
    configureAnalysis({ queue: undefined });

    const blob = await createBlob({ filename: "pixel.png", data: PIXEL });
    const before = blob.metadataObject();

    await analyzeLater(blob);

    expect(blob.metadataObject()).toEqual(before);
  });
});
