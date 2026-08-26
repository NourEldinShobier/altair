/**
 * Storage services and blobs.
 *
 * Mirrors activestorage/test/service/disk_service_test.rb and blob_test.rb.
 * The disk service is exercised against a real temporary directory rather than
 * a fake, because "did the bytes land" is the only question worth asking of a
 * storage service.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connection, SchemaStatements, setConnection } from "@altair/orm";
import {
  checksumFor,
  configureStorage,
  contentTypeFor,
  createBlob,
  createStorageTables,
  diskPath,
  UnsafeKey,
  DiskService,
  FileNotFound,
  generateKey,
  resetStorage,
  S3Service,
  serveDisk,
  StorageBlob,
  storageService,
} from "../src/index.js";

let root: string;
let disk: DiskService;
let connection: Connection;

const bytes = (text: string) => new TextEncoder().encode(text);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "altair-storage-"));
  disk = new DiskService({ root, secret: "a".repeat(32) });

  configureStorage({ services: { disk }, default: "disk" });

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

describe("keys", () => {
  // Every time, not usually: the key was built by stripping two characters
  // out of a base64 token, which left it short about once in 270 — and the
  // short ones are the guessable ones.
  it("are long enough not to be guessed", () => {
    for (let index = 0; index < 5_000; index += 1) {
      expect(generateKey()).toHaveLength(28);
    }
  });

  it("are different every time", () => {
    const keys = new Set(Array.from({ length: 100 }, () => generateKey()));
    expect(keys.size).toBe(100);
  });

  it("are safe in a path", () => {
    for (let index = 0; index < 50; index += 1) {
      expect(generateKey()).toMatch(/^[A-Za-z0-9]+$/);
    }
  });

  // A directory with a million files in it is one some filesystems will not
  // list, so Rails nests by the first four characters.
  it("nest on disk", () => {
    expect(diskPath("abcdefgh")).toBe("ab/cd/abcdefgh");
  });
});

describe("the disk service", () => {
  it("stores and reads bytes back", async () => {
    await disk.upload("abcdefgh", bytes("hello"));

    expect(new TextDecoder().decode(await disk.download("abcdefgh"))).toBe("hello");
  });

  it("reports what it holds", async () => {
    expect(await disk.exists("abcdefgh")).toBe(false);

    await disk.upload("abcdefgh", bytes("hello"));
    expect(await disk.exists("abcdefgh")).toBe(true);
  });

  it("names the key it could not find", async () => {
    await expect(disk.download("missing0")).rejects.toThrow(FileNotFound);
    await expect(disk.download("missing0")).rejects.toThrow('key "missing0"');
  });

  it("deletes", async () => {
    await disk.upload("abcdefgh", bytes("hello"));
    await disk.delete("abcdefgh");

    expect(await disk.exists("abcdefgh")).toBe(false);
  });

  // Deleting something already gone is the outcome that was asked for.
  it("does not complain about deleting nothing", async () => {
    await disk.delete("neverthere");
    expect(await disk.exists("neverthere")).toBe(false);
  });

  it("writes under the nested path", async () => {
    await disk.upload("abcdefgh", bytes("hello"));

    expect(await Bun.file(join(root, "ab", "cd", "abcdefgh")).exists()).toBe(true);
  });
});

describe("disk urls", () => {
  it("are signed, so a key alone is not access", async () => {
    const url = await disk.url("abcdefgh", { filename: "hello.txt" });

    expect(url.startsWith("/storage/")).toBe(true);
    expect(url).not.toContain("abcdefgh");
  });

  it("carry the key to whoever verifies them", async () => {
    const url = await disk.url("abcdefgh");
    const token = decodeURIComponent(url.split("/")[2]!);

    expect(disk.verify(token).key).toBe("abcdefgh");
  });

  it("refuse a tampered token", () => {
    expect(() => disk.verify("not-a-real-token")).toThrow();
  });

  it("expire when asked to", async () => {
    const url = await disk.url("abcdefgh", { expiresIn: -1 });
    const token = decodeURIComponent(url.split("/")[2]!);

    expect(() => disk.verify(token)).toThrow("expired");
  });

  it("fall back to a plain path with no secret", async () => {
    const unsigned = new DiskService({ root });
    expect(await unsigned.url("abcdefgh", { filename: "a.txt" })).toBe("/storage/abcdefgh/a.txt");
  });
});

describe("serving from disk", () => {
  const missing = () => new Response("next", { status: 418 });

  it("answers a signed url with the bytes", async () => {
    await disk.upload("abcdefgh", bytes("hello"));
    const url = await disk.url("abcdefgh", { filename: "hello.txt" });

    const response = await serveDisk(disk)(new Request(`https://example.com${url}`), missing);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello");
  });

  it("names the file in the disposition", async () => {
    await disk.upload("abcdefgh", bytes("hello"));
    const url = await disk.url("abcdefgh", { filename: "hello.txt", disposition: "attachment" });

    const response = await serveDisk(disk)(new Request(`https://example.com${url}`), missing);

    expect(response.headers.get("content-disposition")).toBe('attachment; filename="hello.txt"');
  });

  it("passes anything outside the prefix along", async () => {
    const response = await serveDisk(disk)(new Request("https://example.com/posts"), missing);
    expect(response.status).toBe(418);
  });

  // A tampered link is not a hint about what exists.
  it("gives nothing away for a bad token", async () => {
    const response = await serveDisk(disk)(
      new Request("https://example.com/storage/forged/hello.txt"),
      missing,
    );

    expect(response.status).toBe(404);
  });

  it("returns 404 when the bytes are gone", async () => {
    const url = await disk.url("abcdefgh", { filename: "hello.txt" });
    const response = await serveDisk(disk)(new Request(`https://example.com${url}`), missing);

    expect(response.status).toBe(404);
  });
});

describe("checksums and content types", () => {
  // The same digest S3 checks against its Content-MD5 header.
  it("hash the bytes", () => {
    expect(checksumFor(bytes("hello"))).toBe("XUFAKrxLKna5cZ2REBfFkg==");
  });

  it("differ for different bytes", () => {
    expect(checksumFor(bytes("hello"))).not.toBe(checksumFor(bytes("hellp")));
  });

  it("come from the filename", () => {
    expect(contentTypeFor("a.txt")).toStartWith("text/plain");
    expect(contentTypeFor("a.png")).toBe("image/png");
    expect(contentTypeFor("a.unknownext")).toBe("application/octet-stream");
  });
});

describe("blobs", () => {
  it("record what was uploaded", async () => {
    const blob = await createBlob({ filename: "hello.txt", data: bytes("hello") });

    expect(blob.filename).toBe("hello.txt");
    expect(blob.byte_size).toBe(5);
    expect(blob.service_name).toBe("disk");
    expect(blob.checksum).toBe(checksumFor(bytes("hello")));
    expect(blob.content_type).toStartWith("text/plain");
  });

  // A blob that exists always has bytes behind it, because the row is written
  // after the upload.
  it("have their bytes in the service", async () => {
    const blob = await createBlob({ filename: "hello.txt", data: bytes("hello") });

    expect(await storageService("disk").exists(blob.key)).toBe(true);
    expect(new TextDecoder().decode(await blob.download())).toBe("hello");
  });

  it("take a content type that was given", async () => {
    const blob = await createBlob({
      filename: "data",
      data: bytes("{}"),
      contentType: "application/json",
    });

    expect(blob.content_type).toBe("application/json");
  });

  it("keep metadata", async () => {
    const blob = await createBlob({
      filename: "a.png",
      data: bytes("x"),
      metadata: { width: 100, height: 50 },
    });

    expect(blob.metadataObject()).toEqual({ width: 100, height: 50 });
  });

  it("treat unreadable metadata as none", async () => {
    const blob = await createBlob({ filename: "a.png", data: bytes("x") });
    blob.metadata = "not json";

    expect(blob.metadataObject()).toEqual({});
  });

  it("produce a url through their own service", async () => {
    const blob = await createBlob({ filename: "hello.txt", data: bytes("hello") });
    expect(await blob.url()).toStartWith("/storage/");
  });

  // Purging has to take the bytes with it, or a bucket fills with files no row
  // remembers.
  it("purge the bytes and the row", async () => {
    const blob = await createBlob({ filename: "hello.txt", data: bytes("hello") });
    const key = blob.key as string;

    await blob.purge();

    expect(await storageService("disk").exists(key)).toBe(false);
    expect(await StorageBlob.count()).toBe(0);
  });
});

describe("configuring services", () => {
  it("says when none is configured", () => {
    resetStorage();
    expect(() => storageService()).toThrow("No storage service configured");
  });

  it("names the ones it knows", () => {
    expect(() => storageService("nope")).toThrow("Configured: disk");
  });

  it("hands back the default when asked for nothing", () => {
    expect(storageService()).toBe(disk);
  });
});

// Presigning is local computation, so the S3 service can be exercised without
// a bucket. Everything past this needs one, and is left to an application.
describe("the S3 service", () => {
  const s3 = new S3Service({
    bucket: "my-bucket",
    region: "us-east-1",
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "secret",
  });

  it("addresses the object in the bucket", async () => {
    const url = await s3.url("abcdefgh");
    expect(url.split("?")[0]).toBe("https://s3.us-east-1.amazonaws.com/my-bucket/abcdefgh");
  });

  it("signs the url", async () => {
    expect(await s3.url("abcdefgh")).toContain("X-Amz-Signature");
  });

  it("expires it", async () => {
    expect(await s3.url("abcdefgh", { expiresIn: 60 })).toContain("X-Amz-Expires=60");
  });

  it("defaults to the five minutes Rails uses", async () => {
    expect(await s3.url("abcdefgh")).toContain("X-Amz-Expires=300");
  });

  it("names itself", () => {
    expect(s3.name).toBe("s3");
    expect(new S3Service({ bucket: "b", name: "archive" }).name).toBe("archive");
  });

  describe("direct uploads", () => {
    const upload = () =>
      s3.directUpload("abcdefgh", {
        contentType: "image/png",
        contentLength: 1024,
        checksum: "Q2hlY2tzdW0=",
      });

    it("points at the same object", async () => {
      const { url } = await upload();
      expect(url.split("?")[0]).toBe("https://s3.us-east-1.amazonaws.com/my-bucket/abcdefgh");
    });

    // A signature for a GET is not a signature for a PUT, which is what stops
    // a read link being turned into a write one.
    it("signs the method, not just the object", async () => {
      const write = new URL((await upload()).url).searchParams.get("X-Amz-Signature");
      const read = new URL(await s3.url("abcdefgh")).searchParams.get("X-Amz-Signature");

      expect(write).not.toBe(read);
    });

    // Found by looking at the URL: Bun's presigner turns `type` into
    // `response-content-type`, which is a GET response override and means
    // nothing on a PUT. Sending it would have put a stray parameter in every
    // upload URL.
    it("carries no response overrides", async () => {
      expect((await upload()).url).not.toContain("response-content-type");
    });

    it("sends the type and the digest as headers", async () => {
      expect((await upload()).headers).toEqual({
        "content-type": "image/png",
        "content-md5": "Q2hlY2tzdW0=",
      });
    });
  });
});

/**
 * Keys that name something other than a file in the root.
 *
 * A key is a single path segment. Everything the framework generates is 28
 * alphanumeric characters, and the tokens `serveDisk` reads are signed, so
 * none of this is reachable through the framework's own paths today. It is
 * worth holding anyway: an application that keeps its own keys and calls
 * `download(key)` with one it was handed is doing an ordinary thing, and the
 * failure there is reading or writing any file the process can reach.
 *
 * Both of these were found by building the path and looking at it, not by
 * reading the function.
 */
describe("a key that tries to leave the root", () => {
  it("cannot climb", () => {
    for (const key of ["../../../../etc/passwd", "ab/../../../secret", "variants/../../x"]) {
      expect(() => diskPath(key)).toThrow(UnsafeKey);
    }
  });

  // Nesting is legitimate: a variant lives under `variants/<key>/<digest>`, and
  // a first version of this guard barred separators outright and broke every
  // variant in the suite. What a key may not do is climb.
  it("may nest, which is what variants do", () => {
    expect(() => diskPath("variants/abcdefgh/deadbeef")).not.toThrow();
  });

  it("cannot use a Windows separator, which would nest there and not here", () => {
    expect(() => diskPath("a\\b")).toThrow(UnsafeKey);
    expect(() => diskPath("..\\..\\etc")).toThrow(UnsafeKey);
  });

  it("cannot be absolute", () => {
    expect(() => diskPath("/etc/passwd")).toThrow(UnsafeKey);
  });

  it("cannot hold an empty segment", () => {
    expect(() => diskPath("variants//x")).toThrow(UnsafeKey);
  });

  // The first hole: the path nests by the key's first two characters, so a key
  // beginning `..` makes `..` a directory — `root/../` — without the key ever
  // containing a separator. `..%2F..%2Fetc` went one level up on that alone.
  it("cannot start with a dot", () => {
    for (const key of ["..%2F..%2Fetc", "..", ".", ".hidden", "..abcd"]) {
      expect(() => diskPath(key)).toThrow(UnsafeKey);
    }
  });

  it("cannot be empty", () => {
    expect(() => diskPath("")).toThrow(UnsafeKey);
  });

  it("cannot carry a control character", () => {
    expect(() => diskPath("ab\u0000cd")).toThrow(UnsafeKey);
    expect(() => diskPath("ab\ncd")).toThrow(UnsafeKey);
  });

  it("cannot be absurdly long", () => {
    expect(() => diskPath("a".repeat(2000))).toThrow(UnsafeKey);
  });

  it("says which key it refused", () => {
    expect(() => diskPath("../etc")).toThrow(/\.\.\/etc/);
  });

  // The guard has to leave the keys the framework actually makes alone.
  it("lets an ordinary key through", () => {
    expect(diskPath("abcdefgh")).toBe("ab/cd/abcdefgh");
    expect(diskPath(generateKey())).toContain("/");
  });

  it("lets a key with a dot inside it through", () => {
    expect(diskPath("avatar.2024.png")).toBe("av/at/avatar.2024.png");
  });

  // The second hole: a key shorter than four characters has no second folder,
  // and joining blindly gave `a//a` — a segment naming nothing.
  it("leaves no empty segment for a short key", () => {
    expect(diskPath("a")).toBe("a/a");
    expect(diskPath("abc")).toBe("ab/c/abc");
  });

  it("refuses to write outside the root", async () => {
    expect(disk.upload("../../escaped.txt", bytes("owned"))).rejects.toThrow(UnsafeKey);
  });

  it("refuses to read outside the root", async () => {
    expect(disk.download("../../../etc/passwd")).rejects.toThrow(UnsafeKey);
  });

  it("refuses to delete outside the root", async () => {
    expect(disk.delete("../../something")).rejects.toThrow(UnsafeKey);
  });
});
