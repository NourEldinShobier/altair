/**
 * Checking that the bytes are the bytes, ported from
 * `ActiveStorage::Service#upload` with `checksum:`, and
 * `ActiveStorage::Blob#service_upload` / `service_download`.
 *
 * A checksum was already being recorded on every blob and never once compared
 * against anything. That makes it a fact stored about a file rather than a
 * check on it, and the difference shows up in the two places a file goes
 * wrong:
 *
 *   - **A direct upload.** The browser declares a checksum, then PUTs the
 *     bytes to the service without passing through the application. Nothing
 *     compared what arrived against what was promised, so a truncated upload —
 *     a dropped connection, a proxy that buffered badly — was recorded as a
 *     complete file. It reads back short, months later, to somebody who cannot
 *     tell whether it was ever right.
 *   - **A download.** Bit-rot, a mirror that fell behind, a key collision after
 *     a bad migration. The bytes come back and nothing notices they are not
 *     the ones that went in.
 *
 * The raw `service*` calls are kept beside the checked ones on purpose. Rails
 * has the same pair, because a mirror copying a file it has already verified
 * should not verify it twice, and re-hashing every byte on every copy is the
 * cost that makes people turn checking off altogether.
 */

import type { StorageService, UploadOptions } from "./service.js";

/** Raised when bytes do not match the checksum recorded for them. */
export class ChecksumMismatch extends Error {
  constructor(
    readonly key: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `Checksum mismatch for ${key}: expected ${expected}, got ${actual}. ` +
        `The bytes are not the ones that were recorded.`,
    );
    this.name = "ChecksumMismatch";
  }
}

/** How a checksum is computed. Rails' `checksum_implementation`. */
export type ChecksumImplementation = (data: Uint8Array) => string;

/**
 * MD5, base64 encoded, as Rails records.
 *
 * Not a security claim and never was: it answers "did the bytes arrive
 * intact", which is what S3's Content-MD5 header checks too. Anything relying
 * on a checksum to prove a file was not *deliberately* replaced wants a
 * signature, not a digest — swap the implementation and the storage stays the
 * same, but say so out loud rather than assuming MD5 covers it.
 */
export const md5Checksum: ChecksumImplementation = (data) =>
  new Bun.CryptoHasher("md5").update(data).digest("base64");

let implementation: ChecksumImplementation = md5Checksum;

/** The digest in use. Rails' `checksum_implementation`. */
export function checksumImplementation(): ChecksumImplementation {
  return implementation;
}

/**
 * Changes the digest.
 *
 * Note what this does not do: files already stored keep the checksums they
 * were written with, and comparing a new digest against an old one fails for
 * every one of them. Changing this on a store with data in it means recomputing
 * what is there, not flipping a switch.
 */
export function setChecksumImplementation(next: ChecksumImplementation): void {
  implementation = next;
}

/** Puts the digest back to the default. For a test, and for a reload. */
export function resetChecksumImplementation(): void {
  implementation = md5Checksum;
}

/** The checksum of some bytes, under whatever digest is configured. */
export function checksumOf(data: Uint8Array): string {
  return implementation(data);
}

/** Whether bytes match a recorded checksum. */
export function checksumMatches(data: Uint8Array, expected: string): boolean {
  return checksumOf(data) === expected;
}

/** Stores bytes without checking them. Rails' `service_upload`. */
export async function serviceUpload(
  service: StorageService,
  key: string,
  data: Uint8Array,
  options?: UploadOptions,
): Promise<void> {
  await service.upload(key, data, options);
}

/** Reads bytes without checking them. Rails' `service_download`. */
export async function serviceDownload(service: StorageService, key: string): Promise<Uint8Array> {
  return await service.download(key);
}

/** Removes a file. Rails' `service_delete`. */
export async function serviceDelete(service: StorageService, key: string): Promise<void> {
  await service.delete(key);
}

/**
 * Stores bytes only if they match the checksum promised for them.
 *
 * Checked before the upload rather than after, so bad bytes never reach the
 * store: a file written and then found wrong has to be deleted, and a delete
 * that fails leaves the bad file behind under a key something may already
 * have handed out.
 */
export async function uploadWithChecksum(
  service: StorageService,
  key: string,
  data: Uint8Array,
  expected: string,
  options?: UploadOptions,
): Promise<void> {
  const actual = checksumOf(data);

  if (actual !== expected) throw new ChecksumMismatch(key, expected, actual);

  await service.upload(key, data, options);
}

/**
 * Reads bytes and checks them against what was recorded.
 *
 * The failure it catches is the quiet one. Without it, corrupted bytes are
 * served as though they were right, and the first person to notice is whoever
 * opens the file — by which point there is nothing to compare against.
 */
export async function downloadVerified(
  service: StorageService,
  key: string,
  expected: string,
): Promise<Uint8Array> {
  const data = await service.download(key);
  const actual = checksumOf(data);

  if (actual !== expected) throw new ChecksumMismatch(key, expected, actual);

  return data;
}

/** What a blob needs to be checkable. */
export interface CheckableBlob {
  key: string;
  checksum: string | null;
  byte_size?: number;
}

/** The result of checking one stored file. */
export interface IntegrityResult {
  key: string;
  /** False only when the bytes disagree; a blob with no checksum is not a failure. */
  intact: boolean;
  /** Why it could not be judged, when it could not. */
  reason?: "no-checksum" | "missing";
  expected?: string;
  actual?: string;
}

/**
 * Checks one stored file against its recorded checksum.
 *
 * Reports rather than throws, because the caller is normally sweeping a store
 * and wants the list of what is wrong — a throw on the first bad file means
 * finding them one deploy at a time.
 *
 * A blob with no checksum is reported as intact with a reason. It predates the
 * checksum being recorded, and calling that corruption would bury the real
 * failures in a list of files nobody can do anything about.
 */
export async function verifyBlobIntegrity(
  service: StorageService,
  blob: CheckableBlob,
): Promise<IntegrityResult> {
  if (blob.checksum === null) return { key: blob.key, intact: true, reason: "no-checksum" };

  let data: Uint8Array;

  try {
    data = await service.download(blob.key);
  } catch {
    return { key: blob.key, intact: false, reason: "missing", expected: blob.checksum };
  }

  const actual = checksumOf(data);

  return actual === blob.checksum
    ? { key: blob.key, intact: true }
    : { key: blob.key, intact: false, expected: blob.checksum, actual };
}

/** Checks a set of blobs, returning only what is wrong. */
export async function findCorruptedBlobs(
  service: StorageService,
  blobs: readonly CheckableBlob[],
): Promise<IntegrityResult[]> {
  const results: IntegrityResult[] = [];

  for (const blob of blobs) {
    const result = await verifyBlobIntegrity(service, blob);

    if (!result.intact) results.push(result);
  }

  return results;
}
