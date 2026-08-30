/**
 * Writing a file without anybody seeing it half-written, ported from
 * `ActiveSupport::atomic_write` and the path helpers around it.
 *
 * A plain write is not one operation. It truncates, then fills, and anything
 * reading in between gets a file that is empty or short — and the reader has
 * no way to tell that from a file that is genuinely empty or short. It matters
 * wherever something else watches the file: a schema dump a test run reads, a
 * manifest a server reloads, a cache another process shares, a pid file.
 *
 * Renaming is the fix, because a rename within a filesystem is atomic: the
 * name points at the old file or the new one and never at a partial one.
 */

import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { dirname, join, sep } from "node:path";
import { renameSync, unlinkSync, writeFileSync } from "node:fs";

/**
 * Writes a file by writing another and renaming it. Rails' `atomic_write`.
 *
 * The temporary file goes beside the target rather than in the system's temp
 * directory, and that is the point rather than an accident: a rename across
 * filesystems is not atomic, and `/tmp` is very often a different one. Beside
 * it, the rename is a directory entry swap and cannot be seen half-done.
 *
 * The temporary name carries a digest of the target, so two processes writing
 * the same file do not collide on the temporary one and then rename each
 * other's work.
 */
export function atomicWrite(path: string, contents: string | Uint8Array): void {
  const scratch = join(dirname(path), `.${basenameOf(path)}.${digestFor(path)}.tmp`);

  try {
    writeFileSync(scratch, contents);
    renameSync(scratch, path);
  } catch (error) {
    // The scratch file is ours and nobody else's; leaving it would put a
    // hidden file beside the target for every failed write, and a directory
    // slowly filling with them is harder to diagnose than the original error.
    try {
      unlinkSync(scratch);
    } catch {
      // Already gone, or never created. Either way the original error is the
      // one worth raising.
    }

    throw error;
  }
}

function basenameOf(path: string): string {
  return path.split(/[\\/]/u).pop() ?? "file";
}

function digestFor(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 8);
}

/**
 * The longest directory prefix a set of paths share. Rails' `common_path`.
 *
 * What shortens a backtrace to something readable, and what finds a project's
 * root from the files in it. Compared segment by segment rather than character
 * by character, or `/app/foo` and `/app/foobar` would share `/app/foo` — a
 * prefix that is not a directory either of them is in.
 */
export function commonPath(paths: readonly string[]): string {
  if (paths.length === 0) return "";

  const split = paths.map((path) => path.split(/[\\/]/u));
  const first = split[0] as string[];
  const shared: string[] = [];

  for (let index = 0; index < first.length; index += 1) {
    const segment = first[index];

    if (!split.every((parts) => parts[index] === segment)) break;

    shared.push(segment as string);
  }

  // A single path shares all of itself, which is not a *common* path — the
  // answer a caller wants is its directory.
  if (paths.length === 1) shared.pop();

  return shared.join(sep);
}

/**
 * Gzips some bytes. Rails' `compress`.
 *
 * Exposed because the cache and the storage layer both want it and neither
 * should reach for zlib directly — a compression choice made in two places is
 * a compression choice that will differ in two places.
 */
export function compress(data: string | Uint8Array): Uint8Array {
  return new Uint8Array(gzipSync(typeof data === "string" ? Buffer.from(data, "utf8") : data));
}

/** Ungzips them again. Rails' `decompress`. */
export function decompress(data: Uint8Array): Uint8Array {
  return new Uint8Array(gunzipSync(data));
}

/** The same, when what went in was text. */
export function decompressToString(data: Uint8Array): string {
  return Buffer.from(decompress(data)).toString("utf8");
}

/**
 * Whether compressing is worth it. Rails' `compress_threshold`, as a question.
 *
 * Below about a kilobyte the gzip header and trailer cost more than the
 * compression saves, and the result is a larger payload plus the time spent
 * making it larger.
 */
export function worthCompressing(data: string | Uint8Array, threshold = 1024): boolean {
  const size = typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.byteLength;

  return size > threshold;
}
