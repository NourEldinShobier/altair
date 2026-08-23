/**
 * Blobs, ported from `ActiveStorage::Blob`.
 *
 * A blob is the record of an uploaded file: where it lives, what it was
 * called, how big it is and what it hashes to. The bytes live in a service;
 * this is the row that knows how to find them again.
 */

import { Model, type SchemaStatements } from "@altair/orm";
import { secureToken } from "@altair/support";
// A variant needs a blob and a blob makes variants, so these two import each
// other. The use here is inside a method, which runs long after both modules
// have finished loading.
import { Variant, type Transformations } from "./variant.js";
import {
  defaultServiceName,
  storageService,
  type StorageService,
  type UrlOptions,
} from "./service.js";

export interface BlobRow {
  id: number;
  key: string;
  filename: string;
  content_type: string | null;
  metadata: string | null;
  service_name: string;
  byte_size: number;
  checksum: string | null;
  created_at: string;
}

/**
 * Named `StorageBlob` rather than `Blob`.
 *
 * `Blob` is a global that means a bag of bytes, and this is a database row
 * about one. Shadowing it at every call site would make `new Blob(...)` mean
 * two different things in the same file.
 */
export class StorageBlob extends Model<BlobRow>("active_storage_blobs") {
  /** The service this blob's bytes live in. */
  get service(): StorageService {
    return storageService(this.service_name as string | undefined);
  }

  /** The bytes. */
  async download(): Promise<Uint8Array> {
    return await this.service.download(this.key as string);
  }

  /** A URL a browser can fetch the bytes from. */
  async url(options: UrlOptions = {}): Promise<string> {
    return await this.service.url(this.key as string, {
      filename: this.filename as string,
      contentType: (this.content_type as string | null) ?? undefined,
      ...options,
    });
  }

  /** Anything the uploader recorded alongside the file. */
  metadataObject(): Record<string, unknown> {
    const raw = this.metadata as string | null;
    if (!raw) return {};

    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // A row someone edited by hand should not take down a page.
      return {};
    }
  }

  /**
   * A transformed copy of this image. Rails' `variant`.
   *
   * Nothing is processed until the variant is asked for, and then only once.
   */
  variant(transformations: Transformations): Variant {
    return new Variant(this, transformations);
  }

  /** Deletes the bytes and the row. Rails' `purge`. */
  async purge(): Promise<void> {
    await this.service.delete(this.key as string);
    await this.destroy();
  }
}

export interface UploadedFile {
  /** What the person called it. */
  filename: string;
  data: Uint8Array | ArrayBuffer | Blob;
  contentType?: string;
  metadata?: Record<string, unknown>;
  /** Which service to put it in. Defaults to the configured one. */
  service?: string;
}

/** A key no one can guess, in the shape Rails uses. */
export function generateKey(): string {
  // base64url minus the punctuation, so a key is safe in a path and a header.
  return secureToken(24).replaceAll(/[-_]/g, "").slice(0, 28);
}

/**
 * Rails records an MD5 digest, base64 encoded.
 *
 * MD5 is not a security claim here and never was: it answers "did the bytes
 * arrive intact", which is what S3's Content-MD5 header checks too.
 */
export function checksumFor(data: Uint8Array): string {
  return new Bun.CryptoHasher("md5").update(data).digest("base64");
}

/** Guesses a content type from the filename, as Rails does from the extension. */
export function contentTypeFor(filename: string): string {
  const type = Bun.file(filename).type;
  // Bun answers with the octet-stream default plus a charset for unknowns.
  return type.startsWith("application/octet-stream") ? "application/octet-stream" : type;
}

async function bytesOf(data: Uint8Array | ArrayBuffer | Blob): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(await data.arrayBuffer());
}

/**
 * Stores a file and records it. Rails' `ActiveStorage::Blob.create_and_upload!`.
 *
 * The row is written after the upload succeeds, so a blob that exists always
 * has bytes behind it.
 */
export async function createBlob(file: UploadedFile): Promise<StorageBlob> {
  const bytes = await bytesOf(file.data);
  const key = generateKey();
  const serviceName = file.service ?? defaultServiceName();
  const contentType = file.contentType ?? contentTypeFor(file.filename);

  await storageService(serviceName).upload(key, bytes, { contentType });

  return await StorageBlob.create({
    key,
    filename: file.filename,
    content_type: contentType,
    metadata: file.metadata ? JSON.stringify(file.metadata) : null,
    service_name: serviceName,
    byte_size: bytes.byteLength,
    checksum: checksumFor(bytes),
  });
}

/**
 * Creates the two tables ActiveStorage needs.
 *
 * Rails ships this as an installed migration. Attachments are polymorphic: one
 * table joins every model in the application to its files.
 */
export async function createStorageTables(schema: SchemaStatements): Promise<void> {
  await schema.createTable("active_storage_blobs", (t) => {
    t.string("key", { null: false });
    t.string("filename", { null: false });
    t.string("content_type");
    t.text("metadata");
    t.string("service_name", { null: false });
    t.bigint("byte_size", { null: false });
    t.string("checksum");
    t.datetime("created_at", { null: false });
    t.index(["key"], { unique: true });
  });

  await schema.createTable("active_storage_attachments", (t) => {
    t.string("name", { null: false });
    t.string("record_type", { null: false });
    t.bigint("record_id", { null: false });
    t.bigint("blob_id", { null: false });
    t.datetime("created_at", { null: false });
    // The index a lookup actually uses: everything attached to one record
    // under one name.
    t.index(["record_type", "record_id", "name"]);
    t.index(["blob_id"]);
  });
}
