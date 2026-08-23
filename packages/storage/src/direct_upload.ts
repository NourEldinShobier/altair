/**
 * Direct uploads, ported from `ActiveStorage::DirectUploadsController`.
 *
 * The application never sees the bytes. The browser asks for somewhere to put
 * a file, gets a signed URL and a blob record back, PUTs the file straight at
 * the service, and then submits the signed id with the rest of the form:
 *
 *     POST /rails/active_storage/direct_uploads
 *     { "blob": { "filename": "cat.png", "byte_size": 4096,
 *                 "checksum": "…", "content_type": "image/png" } }
 *
 *     → { "signed_id": "…", "direct_upload": { "url": "…", "headers": {…} } }
 *
 * That is the point of the whole exercise: a two-gigabyte video should not
 * travel through the process that is trying to answer requests, and it should
 * not sit in that process's memory while it does.
 */

import { createBlobRecord, StorageBlob } from "./blob.js";
import { storageService, type DirectUpload } from "./service.js";

/** Rails' path. Kept, so a client written against Rails works unchanged. */
export const DIRECT_UPLOADS_PATH = "/rails/active_storage/direct_uploads";

/** What the browser sends. Snake case, because it is Rails' wire format. */
export interface DirectUploadParams {
  filename: string;
  byte_size: number;
  checksum: string;
  content_type?: string;
  metadata?: Record<string, unknown>;
}

/** What it gets back. Rails' JSON, field for field. */
export interface DirectUploadResponse {
  id: number;
  key: string;
  filename: string;
  content_type: string | null;
  metadata: Record<string, unknown>;
  byte_size: number;
  checksum: string | null;
  signed_id: string;
  direct_upload: DirectUpload;
}

export interface CreateDirectUploadOptions {
  /** Seconds the upload URL stays valid. Rails gives it five minutes. */
  expiresIn?: number;
  /** Which service to put it in. Defaults to the configured one. */
  service?: string;
  /** A ceiling on what a single upload may declare. */
  maxByteSize?: number;
}

/** Raised when the parameters are not something we can act on. */
export class InvalidDirectUpload extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDirectUpload";
  }
}

function validate(params: DirectUploadParams, options: CreateDirectUploadOptions): void {
  if (!params.filename) throw new InvalidDirectUpload("A filename is required.");

  if (!Number.isSafeInteger(params.byte_size) || params.byte_size < 0) {
    throw new InvalidDirectUpload("byte_size must be a whole number of bytes.");
  }

  // Rails checks the digest on arrival too, but it has to be present here:
  // without one, the size is the only thing bounding what turns up, and a
  // signed URL with no digest is a signed URL for arbitrary content.
  if (!params.checksum) throw new InvalidDirectUpload("A checksum is required.");

  if (options.maxByteSize !== undefined && params.byte_size > options.maxByteSize) {
    throw new InvalidDirectUpload(
      `That file is ${params.byte_size} bytes; the limit is ${options.maxByteSize}.`,
    );
  }
}

/**
 * Records the blob and produces the URL to upload it to.
 *
 * Split out from the handler so an application with its own routing, its own
 * authentication or its own quota can call it directly.
 */
export async function createDirectUpload(
  params: DirectUploadParams,
  options: CreateDirectUploadOptions = {},
): Promise<{ blob: StorageBlob; response: DirectUploadResponse }> {
  validate(params, options);

  const blob = await createBlobRecord({
    filename: params.filename,
    byteSize: params.byte_size,
    checksum: params.checksum,
    contentType: params.content_type,
    metadata: params.metadata,
    service: options.service,
  });

  const directUpload = await storageService(blob.service_name as string).directUpload(
    blob.key as string,
    {
      contentType: (blob.content_type as string | null) ?? "application/octet-stream",
      contentLength: params.byte_size,
      checksum: params.checksum,
      expiresIn: options.expiresIn,
    },
  );

  return {
    blob,
    response: {
      id: blob.id as number,
      key: blob.key as string,
      filename: blob.filename as string,
      content_type: blob.content_type as string | null,
      metadata: blob.metadataObject(),
      byte_size: blob.byte_size as number,
      checksum: blob.checksum as string | null,
      signed_id: blob.signedId(),
      direct_upload: directUpload,
    },
  };
}

export interface DirectUploadsMiddlewareOptions extends CreateDirectUploadOptions {
  path?: string;
  /**
   * Decides whether this request may upload at all. Returning false answers
   * 403. There is no default: an endpoint that mints signed upload URLs for
   * anyone who asks is a way to pay for someone else's file hosting.
   */
  authorize?: (request: Request) => boolean | Promise<boolean>;
}

/**
 * The endpoint itself.
 *
 *     app.use(directUploads({ authorize: (request) => signedIn(request) }))
 */
export function directUploads(options: DirectUploadsMiddlewareOptions = {}) {
  const path = options.path ?? DIRECT_UPLOADS_PATH;

  return async (request: Request, next: (request: Request) => Response | Promise<Response>) => {
    const url = new URL(request.url);
    if (url.pathname !== path || request.method !== "POST") return await next(request);

    if (options.authorize && !(await options.authorize(request))) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    let params: DirectUploadParams;
    try {
      const body = (await request.json()) as { blob?: DirectUploadParams };
      if (!body.blob) throw new InvalidDirectUpload("Expected a `blob` key.");
      params = body.blob;
    } catch (error) {
      const message = error instanceof InvalidDirectUpload ? error.message : "Expected JSON.";
      return Response.json({ error: message }, { status: 422 });
    }

    try {
      const { response } = await createDirectUpload(params, options);
      return Response.json(response, { status: 200 });
    } catch (error) {
      if (error instanceof InvalidDirectUpload) {
        return Response.json({ error: error.message }, { status: 422 });
      }
      throw error;
    }
  };
}
