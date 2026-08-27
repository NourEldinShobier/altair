/**
 * The service operations beyond one file at a time, ported from
 * `activestorage/test/service/shared_service_tests.rb`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskService } from "../src/service.js";
import {
  compose,
  computeChecksum,
  deletePrefixed,
  downloadChunk,
  sameContent,
} from "../src/operations.js";

let root: string;
let disk: DiskService;

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "altair-ops-"));
  disk = new DiskService({ root, secret: "a".repeat(32) });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * What removes a blob's variants along with it: they are stored under the
 * blob's key, so one call takes the thumbnail, the hero image and anything
 * else derived, without needing a list of what was made.
 */
describe("deleting under a prefix", () => {
  it("takes everything that starts with it", async () => {
    await disk.upload("abc123", bytes("original"));
    await disk.upload("abc123thumb", bytes("small"));
    await disk.upload("zzz999", bytes("other"));

    expect(await deletePrefixed(disk, "abc123")).toBe(2);

    expect(await disk.exists("abc123")).toBe(false);
    expect(await disk.exists("abc123thumb")).toBe(false);
    expect(await disk.exists("zzz999")).toBe(true);
  });

  it("takes nothing when nothing matches", async () => {
    await disk.upload("abc123", bytes("x"));

    expect(await deletePrefixed(disk, "nothing")).toBe(0);
    expect(await disk.exists("abc123")).toBe(true);
  });

  it("says so on a service that cannot list its keys", async () => {
    const blind = { name: "s3", delete: async () => undefined } as never;

    await expect(deletePrefixed(blind, "a")).rejects.toThrow(/cannot list its keys/);
  });
});

/**
 * What a direct upload of a large file needs: the browser sends it in parts,
 * and the parts have to become a file.
 */
describe("joining parts", () => {
  it("makes one file out of several, in order", async () => {
    await disk.upload("part1", bytes("hello "));
    await disk.upload("part2", bytes("there "));
    await disk.upload("part3", bytes("world"));

    const size = await compose(disk, ["part1", "part2", "part3"], "whole");

    expect(text(await disk.download("whole"))).toBe("hello there world");
    expect(size).toBe(17);
  });

  it("takes a single part", async () => {
    await disk.upload("only", bytes("x"));

    await compose(disk, ["only"], "whole");

    expect(text(await disk.download("whole"))).toBe("x");
  });

  it("refuses to compose nothing", async () => {
    await expect(compose(disk, [], "whole")).rejects.toThrow(/at least one key/);
  });

  it("leaves the parts where they are", async () => {
    await disk.upload("part1", bytes("a"));
    await compose(disk, ["part1"], "whole");

    expect(await disk.exists("part1")).toBe(true);
  });
});

/**
 * For a range request — a video seeking, a PDF viewer asking for one page —
 * where sending the whole file to answer for a fragment is the difference
 * between a page that works on a phone and one that does not.
 */
describe("reading part of a file", () => {
  it("takes the range asked for", async () => {
    await disk.upload("k", bytes("hello world"));

    expect(text(await downloadChunk(disk, "k", 6, 5))).toBe("world");
    expect(text(await downloadChunk(disk, "k", 0, 5))).toBe("hello");
  });

  it("stops at the end rather than past it", async () => {
    await disk.upload("k", bytes("short"));

    expect(text(await downloadChunk(disk, "k", 3, 100))).toBe("rt");
  });

  it("refuses a range that runs backwards", async () => {
    await expect(downloadChunk(disk, "k", -1, 5)).rejects.toThrow(/starts at zero/);
  });
});

describe("checksums", () => {
  it("is the digest a bucket compares an upload against", () => {
    expect(computeChecksum(bytes("hello"))).toBe(
      new Bun.CryptoHasher("md5").update(bytes("hello")).digest("base64"),
    );
  });

  it("tells the same bytes from different ones", () => {
    expect(sameContent(bytes("a"), bytes("a"))).toBe(true);
    expect(sameContent(bytes("a"), bytes("b"))).toBe(false);
    expect(sameContent(bytes("a"), bytes("ab"))).toBe(false);
  });
});
