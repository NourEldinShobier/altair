/**
 * Serving files from the disk service, ported from
 * `ActiveStorage::DiskController`.
 *
 * A bucket answers its own URLs. The disk service cannot, so something has to
 * turn a signed link back into bytes — which is exactly what Rails' disk
 * controller does, and why disk URLs are signed rather than bare paths.
 */

import { DiskService, FileNotFound } from "./service.js";

export interface ServeOptions {
  /** The path prefix the service was configured with. */
  prefix?: string;
}

/**
 * A handler for the URLs `DiskService.url` produces.
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
  };
}
