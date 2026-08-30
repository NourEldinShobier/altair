/**
 * Writing a file without anybody seeing it half-written, ported from
 * `activesupport/test/core_ext/file_test.rb`.
 *
 * A plain write is not one operation: it truncates, then fills, and anything
 * reading in between gets a file that is empty or short — with no way to tell
 * that from a file that is genuinely empty or short.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  atomicWrite,
  commonPath,
  compress,
  decompress,
  decompressToString,
  worthCompressing,
} from "../src/files.js";

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "altair-files-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("atomicWrite", () => {
  it("writes the contents", () => {
    const path = join(directory, "a.txt");

    atomicWrite(path, "hello");

    expect(readFileSync(path, "utf8")).toBe("hello");
  });

  it("replaces what was there", () => {
    const path = join(directory, "a.txt");

    writeFileSync(path, "old");
    atomicWrite(path, "new");

    expect(readFileSync(path, "utf8")).toBe("new");
  });

  it("writes bytes as readily as text", () => {
    const path = join(directory, "a.bin");

    atomicWrite(path, new Uint8Array([1, 2, 3]));

    expect([...readFileSync(path)]).toEqual([1, 2, 3]);
  });

  /**
   * A rename across filesystems is not atomic and /tmp is very often a
   * different one, so the scratch file has to be beside the target.
   */
  it("leaves nothing behind on success", () => {
    atomicWrite(join(directory, "a.txt"), "hello");

    expect(readdirSync(directory)).toEqual(["a.txt"]);
  });

  /**
   * A directory slowly filling with hidden scratch files is harder to diagnose
   * than the original error. The rename is what has to fail to reach the
   * cleanup at all — a failing write leaves nothing to clean up, so a test
   * that breaks the write proves nothing about it.
   */
  it("leaves nothing behind when the rename fails", () => {
    // A directory cannot be replaced by a file, so the write succeeds and the
    // rename does not.
    const path = join(directory, "occupied");

    mkdirSync(path);

    expect(() => {
      atomicWrite(path, "hello");
    }).toThrow();

    expect(readdirSync(directory)).toEqual(["occupied"]);
  });

  it("lets the original error through", () => {
    expect(() => {
      atomicWrite(join(directory, "missing", "a.txt"), "hello");
    }).toThrow(/ENOENT/);
  });

  it("writes two different files in one directory", () => {
    const first = join(directory, "a.txt");
    const second = join(directory, "b.txt");

    atomicWrite(first, "one");
    atomicWrite(second, "two");

    expect(readFileSync(first, "utf8")).toBe("one");
    expect(readFileSync(second, "utf8")).toBe("two");
  });

  it("writes an empty file when asked to", () => {
    const path = join(directory, "a.txt");

    atomicWrite(path, "");

    expect(readFileSync(path, "utf8")).toBe("");
  });
});

describe("commonPath", () => {
  it("finds the directory two paths share", () => {
    expect(commonPath(["/app/src/a.ts", "/app/src/b.ts"])).toBe(["", "app", "src"].join(sep()));
  });

  it("stops where they diverge", () => {
    expect(commonPath(["/app/src/a.ts", "/app/test/b.ts"])).toBe(["", "app"].join(sep()));
  });

  /**
   * Segment by segment, or `/app/foo` and `/app/foobar` would share
   * `/app/foo` — a prefix that is not a directory either of them is in.
   */
  it("does not share a partial segment", () => {
    expect(commonPath(["/app/foo/a.ts", "/app/foobar/b.ts"])).toBe(["", "app"].join(sep()));
  });

  it("gives the directory of a single path", () => {
    expect(commonPath(["/app/src/a.ts"])).toBe(["", "app", "src"].join(sep()));
  });

  it("gives nothing for no paths at all", () => {
    expect(commonPath([])).toBe("");
  });

  it("gives nothing when they share nothing", () => {
    expect(commonPath(["/app/a.ts", "/other/b.ts"])).toBe("");
  });

  it("handles more than two", () => {
    expect(commonPath(["/a/b/c/1", "/a/b/d/2", "/a/b/e/3"])).toBe(["", "a", "b"].join(sep()));
  });

  it("reads a windows path too", () => {
    expect(commonPath(["D:\\app\\src\\a.ts", "D:\\app\\src\\b.ts"])).toBe(
      ["D:", "app", "src"].join(sep()),
    );
  });
});

function sep(): string {
  return process.platform === "win32" ? "\\" : "/";
}

describe("compression", () => {
  it("round-trips text", () => {
    expect(decompressToString(compress("hello world"))).toBe("hello world");
  });

  it("round-trips bytes", () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);

    expect([...decompress(compress(bytes))]).toEqual([...bytes]);
  });

  it("actually makes something large smaller", () => {
    const repetitive = "x".repeat(10_000);

    expect(compress(repetitive).byteLength).toBeLessThan(repetitive.length);
  });

  it("round-trips an empty input", () => {
    expect(decompressToString(compress(""))).toBe("");
  });

  it("round-trips text that is not ascii", () => {
    expect(decompressToString(compress("héllo — 😀"))).toBe("héllo — 😀");
  });
});

describe("worthCompressing", () => {
  /**
   * Below about a kilobyte the header and trailer cost more than the
   * compression saves, so the result is a larger payload plus the time spent
   * making it larger.
   */
  it("says no to something small", () => {
    expect(worthCompressing("hello")).toBe(false);
  });

  it("says yes to something large", () => {
    expect(worthCompressing("x".repeat(2000))).toBe(true);
  });

  it("takes a different threshold", () => {
    expect(worthCompressing("hello", 2)).toBe(true);
  });

  it("measures bytes, not characters", () => {
    // Four bytes each, so a hundred of them is four hundred bytes.
    expect(worthCompressing("😀".repeat(100), 350)).toBe(true);
    expect(worthCompressing("a".repeat(100), 350)).toBe(false);
  });

  it("takes bytes as readily as text", () => {
    expect(worthCompressing(new Uint8Array(2000))).toBe(true);
  });
});
