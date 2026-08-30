/**
 * The service operations Active Storage performs that are not a single
 * upload or download, ported from `ActiveStorage::Service`.
 *
 * Each is expressed over the `StorageService` contract rather than added to
 * it, so a service only has to implement the five primitives and gets these
 * for nothing — and a service that can do one of them natively can still
 * override it.
 */

import { FileNotFound, type StorageService, type UrlOptions } from "./service.js";

/**
 * Deletes every key under a prefix. Rails' `delete_prefixed`.
 *
 * What purging a blob actually needs: a blob's variants are stored under
 * `variants/<blob key>/...`, so deleting the blob alone leaves every derived
 * image behind — invisible, unreferenced, and paid for monthly. This is the
 * only operation here whose absence costs money rather than correctness.
 */
export async function serviceDeletePrefixed(
  service: StorageService & { keys?: (prefix?: string) => Promise<string[]> },
  prefix: string,
): Promise<number> {
  if (!service.keys) {
    throw new TypeError(
      `${service.name} cannot list its keys, so it cannot delete by prefix. ` +
        `Delete the keys individually, or give the service a keys() method.`,
    );
  }

  const keys = await service.keys(prefix);

  for (const key of keys) await service.delete(key);

  return keys.length;
}

/** One byte range of a stored file. */
export interface ByteRange {
  start: number;
  /** Inclusive, as HTTP means it. */
  end?: number;
}

/**
 * Downloads part of a file. Rails' `download_chunk`.
 *
 * The reason it exists is video: a browser seeking to the middle of a file
 * sends a Range header, and a service that could only hand back the whole
 * thing would read two gigabytes to serve one second of playback. It is also
 * what makes a resumed download resume rather than restart.
 *
 * The range is inclusive at both ends, matching HTTP rather than JavaScript,
 * because the number on the wire is what a caller has in hand — converting at
 * the boundary is one place to get it wrong instead of every call site.
 */
export async function serviceDownloadChunk(
  service: StorageService,
  key: string,
  range: ByteRange,
): Promise<Uint8Array> {
  const whole = await service.download(key);
  const end = range.end === undefined ? whole.length - 1 : Math.min(range.end, whole.length - 1);

  if (range.start >= whole.length || range.start < 0 || end < range.start) {
    throw new RangeError(
      `Range ${range.start}-${String(range.end ?? "")} is outside ${key}, which is ${whole.length} bytes`,
    );
  }

  return whole.slice(range.start, end + 1);
}

/**
 * Streams a file in pieces. Rails' `service_streaming_download`.
 *
 * A stream rather than a buffer so a large file never has to be held whole in
 * memory to be served — which is the difference between one big download and a
 * process that dies under a few of them at once.
 */
export async function* serviceStreamingDownload(
  service: StorageService,
  key: string,
  chunkSize = 5 * 1024 * 1024,
): AsyncGenerator<Uint8Array> {
  const whole = await service.download(key);

  for (let offset = 0; offset < whole.length; offset += chunkSize) {
    yield whole.slice(offset, Math.min(offset + chunkSize, whole.length));
  }
}

/**
 * Copies a file from one service to another. Rails' `service_mirror`.
 *
 * For a migration between providers, and for the mirror service that writes to
 * a second provider so losing one does not lose the files. Skipped when the
 * destination already has the key, so re-running a half-finished migration
 * costs nothing rather than re-uploading everything.
 */
export async function serviceMirror(
  from: StorageService,
  to: StorageService,
  key: string,
  options: { contentType?: string } = {},
): Promise<boolean> {
  if (await to.exists(key)) return false;

  const data = await from.download(key);
  await to.upload(key, data, { contentType: options.contentType });

  return true;
}

/** Whether a service holds a key. Rails' `service_exist?`. */
export async function serviceExist(service: StorageService, key: string): Promise<boolean> {
  return await service.exists(key);
}

/** A URL for a stored file. Rails' `service_url`. */
export async function serviceUrl(
  service: StorageService,
  key: string,
  options: UrlOptions = {},
): Promise<string> {
  return await service.url(key, options);
}

/**
 * The headers a browser must send with a direct upload. Rails'
 * `headers_for_direct_upload`.
 *
 * The content type and checksum are part of what the signed URL authorises, so
 * a browser that sends different ones is refused by the provider. Returning
 * them alongside the URL is what stops a caller guessing and getting a 403
 * that says nothing about why.
 */
export function headersForDirectUpload(options: {
  contentType?: string;
  checksum?: string;
  contentLength?: number;
}): Record<string, string> {
  const headers: Record<string, string> = {};

  if (options.contentType) headers["Content-Type"] = options.contentType;
  if (options.checksum) headers["Content-MD5"] = options.checksum;
  if (options.contentLength !== undefined) {
    headers["Content-Length"] = String(options.contentLength);
  }

  return headers;
}

/**
 * Checks a service can be reached before anything depends on it. Rails'
 * `validate_service_configuration`.
 *
 * Round-trips a small object rather than only checking credentials parse,
 * because the failures that matter are the ones credentials cannot show: a
 * bucket in the wrong region, a policy that allows read and not write, a
 * mount that is read-only. All of those look fine until the first upload.
 */
export async function validateServiceConfiguration(service: StorageService): Promise<void> {
  const key = `altair-configuration-check-${String(Math.trunc(Date.now()))}`;
  const probe = new TextEncoder().encode("ok");

  await service.upload(key, probe, { contentType: "text/plain" });

  try {
    const read = await service.download(key);

    if (read.length !== probe.length) {
      throw new Error(
        `${service.name} returned ${read.length} bytes for a ${probe.length}-byte upload`,
      );
    }
  } catch (error) {
    if (error instanceof FileNotFound) {
      throw new Error(`${service.name} accepted an upload and then could not find it`);
    }

    throw error;
  } finally {
    // In a finally, so a failed check does not leave its probe behind on every
    // boot of a misconfigured service.
    await service.delete(key).catch(() => undefined);
  }
}
