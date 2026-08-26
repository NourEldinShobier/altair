/**
 * The mirror service, ported from
 * `activestorage/test/service/mirror_service_test.rb`.
 *
 * Moving from one bucket to another is not done in one step. You write to both
 * for a while, copy the backlog across, and only then move reads — because the
 * moment reads move is the moment a file that never made it becomes a broken
 * page. Every case here is about that window.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskService } from "../src/service.js";
import { MirrorService, MirrorWriteFailed } from "../src/mirror.js";

let roots: string[] = [];
let primary: DiskService;
let first: DiskService;
let second: DiskService;

/** A service that refuses everything, for the failure cases. */
const broken = (name: string) =>
  ({
    name,
    async upload() {
      throw new Error("the bucket is gone");
    },
    async download(): Promise<Uint8Array> {
      throw new Error("the bucket is gone");
    },
    async delete() {
      throw new Error("the bucket is gone");
    },
    async exists() {
      return false;
    },
    async url() {
      return "";
    },
    async directUpload() {
      throw new Error("the bucket is gone");
    },
  }) as unknown as DiskService;

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);

beforeEach(async () => {
  roots = [];

  for (const _ of [0, 1, 2]) roots.push(await mkdtemp(join(tmpdir(), "altair-mirror-")));

  [primary, first, second] = roots.map(
    (root, index) => new DiskService({ root, secret: "a".repeat(32), name: `disk${index}` }),
  ) as [DiskService, DiskService, DiskService];
});

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

describe("writing", () => {
  it("puts the file in the primary and every mirror", async () => {
    const service = new MirrorService({ primary, mirrors: [first, second] });

    await service.upload("k", bytes("hello"));

    expect(text(await primary.download("k"))).toBe("hello");
    expect(text(await first.download("k"))).toBe("hello");
    expect(text(await second.download("k"))).toBe("hello");
  });

  /**
   * The primary first. If it refuses the file there is nothing to mirror, and
   * writing to the mirrors anyway leaves copies of a file the application does
   * not believe exists.
   */
  it("does not mirror a file the primary refused", async () => {
    const service = new MirrorService({ primary: broken("primary"), mirrors: [first] });

    await expect(service.upload("k", bytes("hello"))).rejects.toThrow("the bucket is gone");
    expect(await first.exists("k")).toBe(false);
  });

  /**
   * The default. The file is safely in the service that will be asked for it,
   * and failing the request would lose it for the sake of a copy.
   */
  it("keeps the upload when a mirror refuses it", async () => {
    const seen: unknown[] = [];
    const service = new MirrorService({
      primary,
      mirrors: [broken("cold"), second],
      onError: (error) => seen.push(error),
    });

    await service.upload("k", bytes("hello"));

    expect(text(await primary.download("k"))).toBe("hello");
    // And the mirror after the broken one still got it.
    expect(text(await second.download("k"))).toBe("hello");
    expect(seen).toHaveLength(1);
  });

  // A mirror that has quietly stopped taking writes is one you find out about
  // on the day you switch reads to it.
  it("never fails silently", async () => {
    const seen: unknown[] = [];
    const service = new MirrorService({
      primary,
      mirrors: [broken("cold")],
      onError: (error) => seen.push(error),
    });

    await service.upload("k", bytes("hello"));

    expect((seen[0] as Error).message).toContain("the bucket is gone");
  });

  // For the part of a migration where the copy is the point.
  it("can be told to fail the upload instead", async () => {
    const service = new MirrorService({
      primary,
      mirrors: [broken("cold")],
      onMirrorError: "raise",
    });

    await expect(service.upload("k", bytes("hello"))).rejects.toThrow(MirrorWriteFailed);
  });
});

describe("reading", () => {
  it("asks the primary alone", async () => {
    const service = new MirrorService({ primary, mirrors: [first] });

    await primary.upload("k", bytes("only here"));

    expect(text(await service.download("k"))).toBe("only here");
    expect(await service.exists("k")).toBe(true);
  });

  /**
   * The mirrors are being filled, not consulted. A read that fell through to
   * one would hide exactly the gap this service exists to close.
   */
  it("does not fall through to a mirror", async () => {
    const service = new MirrorService({ primary, mirrors: [first] });

    await first.upload("k", bytes("only in the mirror"));

    expect(await service.exists("k")).toBe(false);

    // Both, because they are separate methods and covering one left the other
    // free to fall through — which a control caught, and only after it was
    // pointed at `download` rather than `exists`.
    await expect(service.download("k")).rejects.toThrow();
  });
});

describe("deleting", () => {
  it("removes it everywhere", async () => {
    const service = new MirrorService({ primary, mirrors: [first, second] });
    await service.upload("k", bytes("hello"));

    await service.delete("k");

    for (const service of [primary, first, second]) expect(await service.exists("k")).toBe(false);
  });

  /**
   * The mirrors first. A mirror keeping a file the primary has dropped is a
   * file nothing will ever delete again — the record that named it is gone.
   */
  it("clears the mirrors even if the primary fails", async () => {
    const service = new MirrorService({ primary: broken("primary"), mirrors: [first] });
    await first.upload("k", bytes("hello"));

    await expect(service.delete("k")).rejects.toThrow("the bucket is gone");
    expect(await first.exists("k")).toBe(false);
  });
});

/**
 * The backlog a migration starts with: everything already in the primary
 * before the mirror was configured, plus anything a direct upload put there
 * without passing through this process.
 */
describe("catching a mirror up", () => {
  it("copies what the mirror is missing", async () => {
    const service = new MirrorService({ primary, mirrors: [first, second] });
    await primary.upload("k", bytes("from before"));

    const copied = await service.mirror("k");

    expect(copied).toEqual(["disk1", "disk2"]);
    expect(text(await first.download("k"))).toBe("from before");
  });

  // So running it over a whole bucket twice costs a HEAD per file rather than
  // a re-upload of everything.
  it("skips a mirror that already has it", async () => {
    const service = new MirrorService({ primary, mirrors: [first, second] });
    await service.upload("k", bytes("hello"));

    expect(await service.mirror("k")).toEqual([]);
  });
});
