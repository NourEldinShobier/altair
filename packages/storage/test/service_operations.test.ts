/**
 * Service operations, ported from
 * `activestorage/test/service/shared_service_tests.rb`.
 */

import { describe, expect, it } from "bun:test";
import type { DirectUpload, StorageService } from "../src/service.js";
import {
  headersForDirectUpload,
  serviceDeletePrefixed,
  serviceDownloadChunk,
  serviceExist,
  serviceMirror,
  serviceStreamingDownload,
  serviceUrl,
  validateServiceConfiguration,
} from "../src/service_operations.js";

/** A service held in memory, which is enough to exercise the operations. */
class FakeService implements StorageService {
  readonly name = "fake";
  readonly files = new Map<string, Uint8Array>();
  uploads = 0;

  async upload(key: string, data: Uint8Array | ArrayBuffer | Blob): Promise<void> {
    this.uploads += 1;
    this.files.set(key, data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer));
  }

  async download(key: string): Promise<Uint8Array> {
    const held = this.files.get(key);
    if (!held) throw new Error(`no such key: ${key}`);
    return held;
  }

  async delete(key: string): Promise<void> {
    this.files.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.files.has(key);
  }

  async url(key: string): Promise<string> {
    return `https://fake.test/${key}`;
  }

  async directUpload(key: string): Promise<DirectUpload> {
    return { url: `https://fake.test/${key}`, headers: {} } as DirectUpload;
  }

  async keys(prefix = ""): Promise<string[]> {
    return [...this.files.keys()].filter((key) => key.startsWith(prefix));
  }
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("serviceDeletePrefixed", () => {
  /**
   * What purging a blob needs: variants live under variants/<key>/, so
   * deleting the blob alone leaves derived images behind — unreferenced,
   * invisible, and paid for monthly.
   */
  it("deletes everything under the prefix", async () => {
    const service = new FakeService();
    await service.upload("variants/abc/thumb", bytes("1"));
    await service.upload("variants/abc/large", bytes("2"));
    await service.upload("variants/xyz/thumb", bytes("3"));

    expect(await serviceDeletePrefixed(service, "variants/abc")).toBe(2);
    expect(await service.keys()).toEqual(["variants/xyz/thumb"]);
  });

  it("deletes nothing when nothing matches", async () => {
    const service = new FakeService();
    await service.upload("a", bytes("1"));

    expect(await serviceDeletePrefixed(service, "missing")).toBe(0);
    expect(await service.keys()).toEqual(["a"]);
  });

  /** A service that cannot list its keys says so rather than silently doing nothing. */
  it("refuses when the service cannot list keys", async () => {
    // Built without a keys method rather than deleting one: FakeService keeps
    // its methods on the prototype, so `delete` on the instance is a no-op and
    // the test would pass for the wrong reason.
    const listless = Object.assign({}, new FakeService(), {
      keys: undefined,
    }) as unknown as StorageService;

    await expect(serviceDeletePrefixed(listless, "x")).rejects.toThrow(/cannot list its keys/);
  });
});

describe("serviceDownloadChunk", () => {
  it("gives the requested range", async () => {
    const service = new FakeService();
    await service.upload("a", bytes("abcdefghij"));

    expect(
      new TextDecoder().decode(await serviceDownloadChunk(service, "a", { start: 2, end: 4 })),
    ).toBe("cde");
  });

  /** Inclusive at both ends, as HTTP means it. */
  it("includes the end byte", async () => {
    const service = new FakeService();
    await service.upload("a", bytes("abcdefghij"));

    expect(await serviceDownloadChunk(service, "a", { start: 0, end: 0 })).toHaveLength(1);
  });

  it("runs to the end when no end is given", async () => {
    const service = new FakeService();
    await service.upload("a", bytes("abcdefghij"));

    expect(new TextDecoder().decode(await serviceDownloadChunk(service, "a", { start: 7 }))).toBe(
      "hij",
    );
  });

  it("clamps an end past the file", async () => {
    const service = new FakeService();
    await service.upload("a", bytes("abc"));

    expect(await serviceDownloadChunk(service, "a", { start: 0, end: 99 })).toHaveLength(3);
  });

  it("refuses a start past the file", async () => {
    const service = new FakeService();
    await service.upload("a", bytes("abc"));

    await expect(serviceDownloadChunk(service, "a", { start: 99 })).rejects.toThrow(RangeError);
  });

  it("refuses a backwards range", async () => {
    const service = new FakeService();
    await service.upload("a", bytes("abcdef"));

    await expect(serviceDownloadChunk(service, "a", { start: 4, end: 2 })).rejects.toThrow(
      RangeError,
    );
  });
});

describe("serviceStreamingDownload", () => {
  it("yields the whole file across chunks", async () => {
    const service = new FakeService();
    await service.upload("a", bytes("abcdefghij"));

    const pieces: string[] = [];
    for await (const chunk of serviceStreamingDownload(service, "a", 3)) {
      pieces.push(new TextDecoder().decode(chunk));
    }

    expect(pieces).toEqual(["abc", "def", "ghi", "j"]);
    expect(pieces.join("")).toBe("abcdefghij");
  });

  it("yields once for a file smaller than a chunk", async () => {
    const service = new FakeService();
    await service.upload("a", bytes("ab"));

    const pieces: Uint8Array[] = [];
    for await (const chunk of serviceStreamingDownload(service, "a", 1024)) pieces.push(chunk);

    expect(pieces).toHaveLength(1);
  });

  it("yields nothing for an empty file", async () => {
    const service = new FakeService();
    await service.upload("a", new Uint8Array());

    const pieces: Uint8Array[] = [];
    for await (const chunk of serviceStreamingDownload(service, "a")) pieces.push(chunk);

    expect(pieces).toEqual([]);
  });
});

describe("serviceMirror", () => {
  it("copies a file across", async () => {
    const from = new FakeService();
    const to = new FakeService();
    await from.upload("a", bytes("hello"));

    expect(await serviceMirror(from, to, "a")).toBe(true);
    expect(new TextDecoder().decode(await to.download("a"))).toBe("hello");
  });

  /** Re-running a half-finished migration should cost nothing. */
  it("skips one the destination already has", async () => {
    const from = new FakeService();
    const to = new FakeService();
    await from.upload("a", bytes("hello"));
    await to.upload("a", bytes("hello"));
    const before = to.uploads;

    expect(await serviceMirror(from, to, "a")).toBe(false);
    expect(to.uploads).toBe(before);
  });
});

describe("the small ones", () => {
  it("reports existence and builds a URL", async () => {
    const service = new FakeService();
    await service.upload("a", bytes("x"));

    expect(await serviceExist(service, "a")).toBe(true);
    expect(await serviceExist(service, "b")).toBe(false);
    expect(await serviceUrl(service, "a")).toBe("https://fake.test/a");
  });

  /** The signed URL authorises these, so a browser sending others is refused. */
  it("builds the direct-upload headers", () => {
    expect(
      headersForDirectUpload({ contentType: "image/png", checksum: "abc", contentLength: 12 }),
    ).toEqual({
      "Content-Type": "image/png",
      "Content-MD5": "abc",
      "Content-Length": "12",
    });
  });

  it("leaves out what it was not given", () => {
    expect(headersForDirectUpload({})).toEqual({});
  });
});

describe("validateServiceConfiguration", () => {
  /** The failures that matter are the ones credentials cannot show. */
  it("passes for a working service", async () => {
    await expect(validateServiceConfiguration(new FakeService())).resolves.toBeUndefined();
  });

  it("leaves nothing behind", async () => {
    const service = new FakeService();
    await validateServiceConfiguration(service);

    expect(await service.keys()).toEqual([]);
  });

  it("fails when an upload cannot be read back", async () => {
    const service = new FakeService();
    service.upload = async () => {};

    await expect(validateServiceConfiguration(service)).rejects.toThrow();
  });

  /** A failed check must not leave its probe behind on every boot. */
  it("cleans up after a failure", async () => {
    const service = new FakeService();
    const realDownload = service.download.bind(service);
    service.download = async () => {
      throw new Error("read denied");
    };

    await expect(validateServiceConfiguration(service)).rejects.toThrow("read denied");

    service.download = realDownload;
    expect(await service.keys()).toEqual([]);
  });
});
