/**
 * Checking that the bytes are the bytes, ported from the `checksum:` cases in
 * `activestorage/test/service/shared_service_tests.rb` and
 * `activestorage/test/models/blob_test.rb`.
 *
 * A checksum was already recorded on every blob and never compared against
 * anything — a fact stored about a file rather than a check on it.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { checksumFor } from "../src/blob.js";
import type { StorageService } from "../src/service.js";
import {
  ChecksumMismatch,
  checksumImplementation,
  checksumMatches,
  checksumOf,
  downloadVerified,
  findCorruptedBlobs,
  md5Checksum,
  resetChecksumImplementation,
  serviceDelete,
  serviceDownload,
  serviceUpload,
  setChecksumImplementation,
  uploadWithChecksum,
  verifyBlobIntegrity,
} from "../src/integrity.js";

/** A service that keeps bytes in a map, so a test can corrupt one. */
function memoryService(): StorageService & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();

  return {
    name: "memory",
    files,
    upload: async (key: string, data: Uint8Array) => {
      files.set(key, data);
    },
    download: async (key: string) => {
      const found = files.get(key);

      if (!found) throw new Error(`No such key: ${key}`);

      return found;
    },
    delete: async (key: string) => {
      files.delete(key);
    },
    exists: async (key: string) => files.has(key),
    url: async (key: string) => `memory://${key}`,
  } as unknown as StorageService & { files: Map<string, Uint8Array> };
}

const BYTES = new Uint8Array([1, 2, 3, 4]);
const OTHER = new Uint8Array([9, 9, 9, 9]);

afterEach(() => {
  resetChecksumImplementation();
});

describe("the digest", () => {
  it("is md5 by default", () => {
    expect(checksumImplementation()).toBe(md5Checksum);
  });

  it("is stable for the same bytes", () => {
    expect(checksumOf(BYTES)).toBe(checksumOf(new Uint8Array([1, 2, 3, 4])));
  });

  it("differs for different bytes", () => {
    expect(checksumOf(BYTES)).not.toBe(checksumOf(OTHER));
  });

  it("can be swapped", () => {
    setChecksumImplementation(() => "fixed");

    expect(checksumOf(BYTES)).toBe("fixed");
  });

  /**
   * A blob written with one digest and checked with another fails every
   * comparison, so the two paths have to agree.
   */
  it("is the one a blob's checksum is recorded with", () => {
    setChecksumImplementation(() => "fixed");

    expect(checksumFor(BYTES)).toBe("fixed");
  });

  it("goes back to md5 when reset", () => {
    setChecksumImplementation(() => "fixed");
    resetChecksumImplementation();

    expect(checksumOf(BYTES)).toBe(md5Checksum(BYTES));
  });

  it("says whether bytes match", () => {
    expect(checksumMatches(BYTES, checksumOf(BYTES))).toBe(true);
    expect(checksumMatches(OTHER, checksumOf(BYTES))).toBe(false);
  });
});

describe("the raw service calls", () => {
  it("stores and reads without checking", async () => {
    const service = memoryService();

    await serviceUpload(service, "k", BYTES);

    expect(await serviceDownload(service, "k")).toEqual(BYTES);
  });

  it("removes a file", async () => {
    const service = memoryService();

    await serviceUpload(service, "k", BYTES);
    await serviceDelete(service, "k");

    expect(await service.exists("k")).toBe(false);
  });

  /** Kept beside the checked ones so a verified copy is not re-hashed. */
  it("stores bytes that do not match anything", async () => {
    const service = memoryService();

    await serviceUpload(service, "k", OTHER);

    expect(service.files.get("k")).toEqual(OTHER);
  });
});

describe("uploading with a checksum", () => {
  it("stores bytes that match", async () => {
    const service = memoryService();

    await uploadWithChecksum(service, "k", BYTES, checksumOf(BYTES));

    expect(service.files.get("k")).toEqual(BYTES);
  });

  it("refuses bytes that do not", async () => {
    const service = memoryService();

    expect(uploadWithChecksum(service, "k", OTHER, checksumOf(BYTES))).rejects.toThrow(
      ChecksumMismatch,
    );
  });

  /**
   * Checked before the upload, not after: a file written and then found wrong
   * has to be deleted, and a delete that fails leaves the bad file under a key
   * something may already have handed out.
   */
  it("does not store bytes it is going to reject", async () => {
    const service = memoryService();

    await uploadWithChecksum(service, "k", OTHER, checksumOf(BYTES)).catch(() => undefined);

    expect(service.files.has("k")).toBe(false);
  });

  it("says what it expected and what it got", async () => {
    const service = memoryService();

    try {
      await uploadWithChecksum(service, "k", OTHER, "expected-one");
    } catch (error) {
      expect((error as ChecksumMismatch).key).toBe("k");
      expect((error as ChecksumMismatch).expected).toBe("expected-one");
      expect((error as ChecksumMismatch).actual).toBe(checksumOf(OTHER));
    }
  });
});

describe("downloading verified", () => {
  it("gives back bytes that match", async () => {
    const service = memoryService();

    await serviceUpload(service, "k", BYTES);

    expect(await downloadVerified(service, "k", checksumOf(BYTES))).toEqual(BYTES);
  });

  /**
   * The quiet failure. Without this, corrupted bytes are served as though they
   * were right and the first person to notice is whoever opens the file — by
   * which point there is nothing left to compare against.
   */
  it("refuses bytes that were corrupted in the store", async () => {
    const service = memoryService();
    const recorded = checksumOf(BYTES);

    await serviceUpload(service, "k", BYTES);
    service.files.set("k", OTHER);

    expect(downloadVerified(service, "k", recorded)).rejects.toThrow(ChecksumMismatch);
  });

  it("lets a missing key fail as a missing key", async () => {
    const service = memoryService();

    expect(downloadVerified(service, "gone", "x")).rejects.toThrow("No such key");
  });
});

describe("checking a stored blob", () => {
  it("reports an intact file", async () => {
    const service = memoryService();

    await serviceUpload(service, "k", BYTES);

    expect(await verifyBlobIntegrity(service, { key: "k", checksum: checksumOf(BYTES) })).toEqual({
      key: "k",
      intact: true,
    });
  });

  it("reports a corrupted one with both checksums", async () => {
    const service = memoryService();
    const recorded = checksumOf(BYTES);

    await serviceUpload(service, "k", OTHER);

    const result = await verifyBlobIntegrity(service, { key: "k", checksum: recorded });

    expect(result.intact).toBe(false);
    expect(result.expected).toBe(recorded);
    expect(result.actual).toBe(checksumOf(OTHER));
  });

  /** Reports rather than throws: the caller is sweeping a store. */
  it("reports a file that is not there", async () => {
    const service = memoryService();

    const result = await verifyBlobIntegrity(service, { key: "gone", checksum: "x" });

    expect(result.intact).toBe(false);
    expect(result.reason).toBe("missing");
  });

  /**
   * It predates the checksum being recorded. Calling that corruption buries
   * the real failures in a list nobody can act on.
   */
  it("does not call a blob with no checksum corrupted", async () => {
    const service = memoryService();

    const result = await verifyBlobIntegrity(service, { key: "k", checksum: null });

    expect(result.intact).toBe(true);
    expect(result.reason).toBe("no-checksum");
  });
});

describe("sweeping a store", () => {
  it("returns only what is wrong", async () => {
    const service = memoryService();

    await serviceUpload(service, "good", BYTES);
    await serviceUpload(service, "bad", OTHER);

    const corrupted = await findCorruptedBlobs(service, [
      { key: "good", checksum: checksumOf(BYTES) },
      { key: "bad", checksum: checksumOf(BYTES) },
      { key: "old", checksum: null },
    ]);

    expect(corrupted.map((one) => one.key)).toEqual(["bad"]);
  });

  it("keeps going past a missing file", async () => {
    const service = memoryService();

    await serviceUpload(service, "second", OTHER);

    const corrupted = await findCorruptedBlobs(service, [
      { key: "first", checksum: "x" },
      { key: "second", checksum: "y" },
    ]);

    expect(corrupted).toHaveLength(2);
  });

  it("finds nothing wrong with a healthy store", async () => {
    const service = memoryService();

    await serviceUpload(service, "k", BYTES);

    expect(await findCorruptedBlobs(service, [{ key: "k", checksum: checksumOf(BYTES) }])).toEqual(
      [],
    );
  });
});
