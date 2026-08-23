/**
 * Serving files from the disk service, ported from
 * `ActiveStorage::DiskController`.
 *
 * A bucket answers its own URLs. The disk service cannot, so something has to
 * turn a signed link back into bytes — which is exactly what Rails' disk
 * controller does, and why disk URLs are signed rather than bare paths.
 *
 * The same handler takes the direct upload PUT, as Rails' does. The two are
 * told apart by the method and by the purpose the token was signed under, so a
 * link that lets someone read a file cannot be used to replace it.
 */

import { DiskService, FileNotFound } from "./service.js";

export interface ServeOptions {
  /** The path prefix the service was configured with. */
  prefix?: string;
}

/**
 * A handler for the URLs `DiskService.url` and `DiskService.directUpload`
 * produce.
 *
 *     app.use(serveDisk(disk))
 */
export function serveDisk(service: DiskService, options: ServeOptions = {}) {
  const prefix = options.prefix ?? "/storage";

  return async (request: Request, next: (request: Request) => Response | Promise<Response>) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(`${prefix}/`)) return await next(request);

    const [token, filename] = url.pathname
      .slice(prefix.length + 1)
      .split("/")
      .map(decodeURIComponent);
    if (!token) return await next(request);

    if (request.method === "PUT") return await receive(service, token, request);
    return await send(service, token, filename);
  };
}

/** The direct upload landing. Rails' `DiskController#update`. */
async function receive(service: DiskService, token: string, request: Request): Promise<Response> {
  let payload: { key: string; contentType: string; contentLength: number; checksum?: string };
  try {
    payload = service.verifyUpload(token);
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const bytes = new Uint8Array(await request.arrayBuffer());

  // The length and the digest were signed when the upload was authorised. A
  // client that sends different bytes than it declared is either broken or
  // uploading something it was not given a URL for, and both are a 422.
  if (bytes.byteLength !== payload.contentLength) {
    return new Response("Wrong size", { status: 422 });
  }

  if (payload.checksum) {
    const digest = new Bun.CryptoHasher("md5").update(bytes).digest("base64");
    if (digest !== payload.checksum) return new Response("Checksum mismatch", { status: 422 });
  }

  await service.upload(payload.key, bytes, { contentType: payload.contentType });

  return new Response(null, { status: 204 });
}

/** Rails' `DiskController#show`. */
async function send(
  service: DiskService,
  token: string,
  filename: string | undefined,
): Promise<Response> {
  let payload: { key: string; disposition: string; contentType?: string };
  try {
    payload = service.verify(token);
  } catch {
    // A tampered or expired link is not a hint about what exists.
    return new Response("Not found", { status: 404 });
  }

  try {
    const bytes = await service.download(payload.key);
    const name = filename ?? payload.key;

    return new Response(bytes, {
      headers: {
        "content-type": payload.contentType ?? "application/octet-stream",
        "content-length": String(bytes.byteLength),
        "content-disposition": `${payload.disposition}; filename="${name.replaceAll('"', "")}"`,
      },
    });
  } catch (error) {
    if (error instanceof FileNotFound) return new Response("Not found", { status: 404 });
    throw error;
  }
}
