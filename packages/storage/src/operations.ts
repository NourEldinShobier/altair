/**
 * The service operations beyond one file at a time, ported from
 * `ActiveStorage::Service`.
 *
 * Deleting everything under a prefix, joining parts into one blob, and reading
 * a range rather than the whole thing. Each is something a service either does
 * natively or does not do at all, so each says which rather than pretending.
 */

import type { StorageService } from "./service.js";

/** A service that can list what it holds, which not all of them can. */
export interface ListableService extends StorageService {
  keys(prefix?: string): Promise<string[]>;
}

function listable(service: StorageService): service is ListableService {
  return typeof (service as ListableService).keys === "function";
}

/**
 * Everything under a prefix. Rails' `delete_prefixed`.
 *
 * What removes a blob's variants along with it: they are stored under the
 * blob's key, so one call takes the thumbnail, the hero image and anything
 * else that was derived without needing a list of what was made.
 */
export async function deletePrefixed(service: StorageService, prefix: string): Promise<number> {
  if (!listable(service)) {
    throw new Error(
      `The ${service.name} service cannot list its keys, so it cannot delete by prefix. Delete the keys you know about instead.`,
    );
  }

  const keys = await service.keys(prefix);

  await Promise.all(keys.map((key) => service.delete(key)));

  return keys.length;
}

/**
 * Joins several stored blobs into one. Rails' `compose`.
 *
 * What a direct upload of a large file needs: the browser sends it in parts,
 * and the parts have to become a file. Done by reading and rewriting here
 * rather than by asking the service, because only S3 has a native compose and
 * the disk service is what most applications run in development.
 */
export async function compose(
  service: StorageService,
  sourceKeys: readonly string[],
  destinationKey: string,
): Promise<number> {
  if (sourceKeys.length === 0) {
    throw new Error("Nothing to compose. Pass at least one key.");
  }

  const parts = await Promise.all(sourceKeys.map((key) => service.download(key)));
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const joined = new Uint8Array(total);

  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.byteLength;
  }

  await service.upload(destinationKey, joined);

  return total;
}

/**
 * Part of a file. Rails' `download_chunk`.
 *
 * For a range request — a video seeking, a PDF viewer asking for one page —
 * where sending the whole file to answer for a fragment of it is the
 * difference between a page that works on a phone and one that does not.
 */
export async function downloadChunk(
  service: StorageService,
  key: string,
  from: number,
  length: number,
): Promise<Uint8Array> {
  if (from < 0 || length < 0) throw new Error("A range starts at zero and runs forwards.");

  // Read whole and sliced. A service with a native ranged read should override
  // this; the point here is that the caller's contract is the same either way.
  const whole = await service.download(key);

  return whole.slice(from, from + length);
}

/** The digest a service compares an upload against. Rails' `compute_checksum`. */
export function computeChecksum(data: Uint8Array): string {
  return new Bun.CryptoHasher("md5").update(data).digest("base64");
}

/** Whether two blobs hold the same bytes, without comparing them byte by byte. */
export function sameContent(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && computeChecksum(left) === computeChecksum(right);
}
