/**
 * Mounting storage on an application.
 *
 *     createApplication({ routes, controllers, providers: [storageProvider()] })
 *
 * A bucket answers its own URLs. The disk service cannot — `blob.url()` hands
 * back a signed path and something has to turn it back into bytes, which is
 * what `serveDisk` does and what Rails' disk controller is.
 *
 * Until this existed that wiring was a line an application had to know to
 * write, and an application that did not know got URLs that 404. The provider
 * is still a line, because core cannot depend on storage without every
 * application carrying it — but it is one line in the place providers already
 * go, rather than a middleware somebody has to find.
 */

import { directUploads, type DirectUploadsMiddlewareOptions } from "./direct-upload.js";
import { serveDisk } from "./serve.js";
import { DiskService, storageService } from "./service.js";

type Handler = (request: Request) => Response | Promise<Response>;
type StorageMiddleware = (request: Request, next: Handler) => Promise<Response>;

/**
 * The part of an application this needs.
 *
 * Structural, so `@altair/storage` does not have to depend on `@altair/core`
 * for one type — and so a test can hand in a plain object.
 */
export interface MiddlewareHost {
  middleware: { use(name: string, middleware: StorageMiddleware): void };
}

export interface StorageProviderOptions {
  /** Which configured service to serve. Defaults to the default one. */
  service?: string;
  /**
   * Mounts the direct upload endpoint, which hands a browser a signed URL to
   * PUT a file to.
   *
   * Off unless asked for, and it takes an `authorize` because there is no safe
   * default: an endpoint that mints signed upload URLs for anyone who asks is
   * a way to pay for someone else's file hosting. Requiring the decision here
   * is the difference between a feature nobody can reach and one everybody
   * can.
   */
  directUploads?: DirectUploadsMiddlewareOptions & {
    authorize: NonNullable<DirectUploadsMiddlewareOptions["authorize"]>;
  };
}

/** Serves the disk service's own URLs, when the app is configured for one. */
export function storageProvider(options: StorageProviderOptions = {}): {
  name: string;
  boot(app: MiddlewareHost): void;
} {
  return {
    name: "storage",

    boot(app: MiddlewareHost) {
      // Mounted whatever the service is: a bucket signs its own download URLs,
      // but the endpoint that hands out an upload URL is the application's
      // either way.
      if (options.directUploads) {
        app.middleware.use("directUploads", directUploads(options.directUploads));
      }

      const service = storageService(options.service);

      // S3 signs its own URLs and the browser goes straight there, so there is
      // nothing more to mount. Silently, because "no disk service" is the
      // ordinary production case rather than a mistake.
      if (!(service instanceof DiskService)) return;

      app.middleware.use("storage", serveDisk(service));
    },
  };
}
