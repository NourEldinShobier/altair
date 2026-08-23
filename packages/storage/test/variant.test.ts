/**
 * Image variants.
 *
 * Mirrors activestorage/test/models/variant_test.rb. Rails needs libvips or
 * ImageMagick on the machine; Bun 1.4 ships the codecs statically, so these
 * run against the real pipeline rather than a stub — a variant test that does
 * not actually decode an image is testing a filename.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { deflateSync, crc32 } from "node:zlib";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connection, SchemaStatements, setConnection } from "@altair/orm";
import {
  configureStorage,
  createBlob,
  createStorageTables,
  DiskService,
  isProcessable,
  resetStorage,
  StorageBlob,
  storageService,
  transform,
  UnprocessableImage,
  Variant,
  variantContentType,
  variantKey,
} from "../src/index.js";

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);

  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);

  return Buffer.concat([length, body, crc]);
}

/** A real PNG, so the decoder has something to decode. */
function makePng(width: number, height: number): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour

  const raw: number[] = [];
  for (let y = 0; y < height; y += 1) {
    raw.push(0); // no filter
    for (let x = 0; x < width; x += 1) raw.push((x * 8) % 256, (y * 8) % 256, 128);
  }

  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(Buffer.from(raw))),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

/** Reads a processed image back, so assertions are about pixels not promises. */
async function measure(
  bytes: Uint8Array,
): Promise<{ width: number; height: number; format: string }> {
  return (await new Bun.Image(bytes).metadata()) as {
    width: number;
    height: number;
    format: string;
  };
}

const source = makePng(64, 48);

let root: string;
let connection: Connection;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "altair-variant-"));
  configureStorage({ services: { disk: new DiskService({ root }) }, default: "disk" });

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

describe("what can be varied", () => {
  it("accepts the image types", () => {
    for (const type of ["image/jpeg", "image/png", "image/webp", "image/gif"]) {
      expect(isProcessable(type)).toBe(true);
    }
  });

  it("refuses anything else", () => {
    expect(isProcessable("application/pdf")).toBe(false);
    expect(isProcessable(null)).toBe(false);
  });
});

describe("variant keys", () => {
  // Asking for the same thumbnail twice must find the one already made, or an
  // image becomes a way to take a site down.
  it("are the same for the same transformations", () => {
    expect(variantKey("abc", { resize: [100, 100] })).toBe(
      variantKey("abc", { resize: [100, 100] }),
    );
  });

  it("differ for different transformations", () => {
    expect(variantKey("abc", { resize: [100, 100] })).not.toBe(
      variantKey("abc", { resize: [200, 200] }),
    );
  });

  it("differ per blob", () => {
    expect(variantKey("abc", { resize: [100] })).not.toBe(variantKey("xyz", { resize: [100] }));
  });

  // Two callers writing the options in a different order want one variant.
  it("ignore the order the options were written in", () => {
    expect(variantKey("abc", { resize: [100], format: "webp" })).toBe(
      variantKey("abc", { format: "webp", resize: [100] }),
    );
  });

  it("live under the blob they came from", () => {
    expect(variantKey("abc", {})).toStartWith("variants/abc/");
  });
});

describe("content types", () => {
  it("follow the format asked for", () => {
    expect(variantContentType({ format: "webp" }, "image/png")).toBe("image/webp");
  });

  it("keep the original when no format is asked for", () => {
    expect(variantContentType({ resize: [10] }, "image/png")).toBe("image/png");
  });
});

// Against the real pipeline: a variant test that does not decode an image is
// testing a filename.
describe("transforming", () => {
  it("resizes to the size asked for", async () => {
    const out = await transform(source, { resize: [32, 24] });
    expect(await measure(out)).toMatchObject({ width: 32, height: 24 });
  });

  it("keeps the aspect ratio when given one dimension", async () => {
    const out = await transform(source, { resize: [32] });
    expect(await measure(out)).toMatchObject({ width: 32, height: 24 });
  });

  it("changes format", async () => {
    expect((await measure(await transform(source, { format: "webp" }))).format).toBe("webp");
    expect((await measure(await transform(source, { format: "jpeg" }))).format).toBe("jpeg");
  });

  it("takes a quality", async () => {
    const high = await transform(source, { format: "jpeg", quality: 95 });
    const low = await transform(source, { format: "jpeg", quality: 20 });

    expect(low.byteLength).toBeLessThan(high.byteLength);
  });

  // Rails' `resize_to_limit`: a small image is left alone rather than blown up.
  it("does not enlarge when told not to", async () => {
    const out = await transform(source, {
      resize: [500, 500],
      fit: "inside",
      withoutEnlargement: true,
    });

    expect(await measure(out)).toMatchObject({ width: 64, height: 48 });
  });

  it("rotates", async () => {
    const out = await transform(source, { rotate: 90 });
    expect(await measure(out)).toMatchObject({ width: 48, height: 64 });
  });

  it("combines transformations", async () => {
    const out = await transform(source, { resize: [32, 24], format: "webp", quality: 70 });
    expect(await measure(out)).toMatchObject({ width: 32, height: 24, format: "webp" });
  });
});

describe("a blob's variant", () => {
  const upload = () =>
    createBlob({ filename: "photo.png", data: source, contentType: "image/png" });

  it("is not processed until it is asked for", async () => {
    const blob = await upload();
    const variant = blob.variant({ resize: [32] });

    expect(await variant.isProcessed()).toBe(false);
  });

  it("processes on demand", async () => {
    const blob = await upload();
    const variant = blob.variant({ resize: [32, 24] });

    expect(await measure(await variant.process())).toMatchObject({ width: 32, height: 24 });
    expect(await variant.isProcessed()).toBe(true);
  });

  // Processed once and stored: recomputing a thumbnail on every page view is
  // how an image becomes a denial of service.
  it("does the work once", async () => {
    const blob = await upload();
    const variant = blob.variant({ resize: [32] });

    const first = await variant.process();
    const second = await variant.process();

    expect(second).toEqual(first);
    expect(await storageService("disk").exists(variant.key)).toBe(true);
  });

  it("stores the variant beside the original", async () => {
    const blob = await upload();
    const variant = blob.variant({ resize: [32] });
    await variant.process();

    // The original is untouched.
    expect(await measure(await blob.download())).toMatchObject({ width: 64, height: 48 });
  });

  it("gives a url, processing first", async () => {
    const blob = await upload();
    const variant = blob.variant({ resize: [32], format: "webp" });

    expect(await variant.url()).toStartWith("/storage/");
    expect(await variant.isProcessed()).toBe(true);
  });

  it("names the file with the format it became", async () => {
    const blob = await upload();

    expect(blob.variant({ format: "webp" }).filename).toBe("photo.webp");
    expect(blob.variant({ resize: [32] }).filename).toBe("photo.png");
  });

  it("reports the content type it will be", async () => {
    const blob = await upload();
    expect(blob.variant({ format: "webp" }).contentType).toBe("image/webp");
  });

  it("can be purged and made again", async () => {
    const blob = await upload();
    const variant = blob.variant({ resize: [32] });

    await variant.process();
    await variant.purge();
    expect(await variant.isProcessed()).toBe(false);

    await variant.process();
    expect(await variant.isProcessed()).toBe(true);
  });

  it("refuses a file that is not an image", async () => {
    const blob = await createBlob({
      filename: "notes.txt",
      data: new TextEncoder().encode("hello"),
      contentType: "text/plain",
    });

    await expect(blob.variant({ resize: [32] }).process()).rejects.toThrow(UnprocessableImage);
  });

  it("is the same variant whichever way it was built", async () => {
    const blob = await upload();

    expect(blob.variant({ resize: [32] }).key).toBe(new Variant(blob, { resize: [32] }).key);
  });
});
