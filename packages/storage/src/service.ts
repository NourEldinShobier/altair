/**
 * Storage services, ported from `ActiveStorage::Service`.
 *
 * A service is where the bytes actually live. Rails ships Disk, S3, GCS and
 * Azure behind one interface so an application can develop against the disk
 * and deploy against a bucket without changing a line; this ships the two that
 * Bun can do natively, behind the same interface.
 */

import { S3Client } from "bun";
import { MessageVerifier } from "@altair/support";

export interface UploadOptions {
  contentType?: string;
  checksum?: string;
}

export interface UrlOptions {
  /** Seconds the URL stays valid. Services that cannot expire ignore it. */
  expiresIn?: number;
  /** The name the browser should save the file as. */
  filename?: string;
  contentType?: string;
  disposition?: "inline" | "attachment";
}

/** What every service can do. Rails' `ActiveStorage::Service`. */
export interface StorageService {
  readonly name: string;

  upload(
    key: string,
    data: Uint8Array | ArrayBuffer | Blob,
    options?: UploadOptions,
  ): Promise<void>;
  download(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  url(key: string, options?: UrlOptions): Promise<string>;
}

/** Raised when a key names nothing the service holds. */
export class FileNotFound extends Error {
  constructor(key: string, service: string) {
    super(`No file with key "${key}" in the ${service} service.`);
    this.name = "FileNotFound";
  }
}

/**
 * Where a key lives on disk.
 *
 * Rails nests by the first four characters of the key. A directory with a
 * million files in it is a directory some filesystems will not list.
 */
export function diskPath(key: string): string {
  return `${key.slice(0, 2)}/${key.slice(2, 4)}/${key}`;
}

export interface DiskServiceOptions {
  root: string;
  name?: string;
  /**
   * What a generated URL is prefixed with. The signed part is appended, and
   * `serveDisk` is what answers it.
   */
  urlPrefix?: string;
  /** Signs generated URLs, so a key alone does not grant access. */
  secret?: string;
}

/** Files on the local filesystem. Rails' Disk service. */
export class DiskService implements StorageService {
  readonly name: string;
  readonly root: string;

  #urlPrefix: string;
  #verifier: MessageVerifier | undefined;

  constructor(options: DiskServiceOptions) {
    this.name = options.name ?? "disk";
    this.root = options.root;
    this.#urlPrefix = options.urlPrefix ?? "/storage";
    this.#verifier = options.secret ? new MessageVerifier(options.secret) : undefined;
  }

  async upload(
    key: string,
    data: Uint8Array | ArrayBuffer | Blob,
    _options: UploadOptions = {},
  ): Promise<void> {
    await Bun.write(this.pathFor(key), data as Blob);
  }

  async download(key: string): Promise<Uint8Array> {
    const file = Bun.file(this.pathFor(key));
    if (!(await file.exists())) throw new FileNotFound(key, this.name);

    return new Uint8Array(await file.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    // Deleting something that is already gone is the outcome asked for.
    await Bun.file(this.pathFor(key))
      .delete()
      .catch(() => undefined);
  }

  async exists(key: string): Promise<boolean> {
    return await Bun.file(this.pathFor(key)).exists();
  }

  /**
   * A signed URL for `serveDisk` to answer.
   *
   * Signed rather than a bare path, because a key is guessable enough that
   * "you would have to know the key" is not access control.
   */
  async url(key: string, options: UrlOptions = {}): Promise<string> {
    const filename = options.filename ?? key;

    if (!this.#verifier) {
      return `${this.#urlPrefix}/${key}/${encodeURIComponent(filename)}`;
    }

    const token = this.#verifier.generate({
      key,
      disposition: options.disposition ?? "inline",
      contentType: options.contentType,
      expiresAt: options.expiresIn ? Date.now() + options.expiresIn * 1000 : undefined,
    });

    return `${this.#urlPrefix}/${encodeURIComponent(token)}/${encodeURIComponent(filename)}`;
  }

  /** @internal Verifies a token produced by `url`. */
  verify(token: string): { key: string; disposition: string; contentType?: string } {
    if (!this.#verifier) throw new Error("This disk service was configured without a secret.");

    const payload = this.#verifier.verify<{
      key: string;
      disposition: string;
      contentType?: string;
      expiresAt?: number;
    }>(token);

    if (payload.expiresAt !== undefined && Date.now() > payload.expiresAt) {
      throw new Error("This storage link has expired.");
    }

    return payload;
  }

  pathFor(key: string): string {
    return `${this.root}/${diskPath(key)}`;
  }
}

export interface S3ServiceOptions {
  bucket: string;
  name?: string;
  region?: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  /** Seconds a generated URL stays valid. Rails defaults to five minutes. */
  expiresIn?: number;
}

/**
 * Objects in an S3-compatible bucket, through `Bun.S3Client`.
 *
 * Rails needs the aws-sdk for this. Bun ships the client, presigning included,
 * so the whole service is a thin mapping onto it.
 */
export class S3Service implements StorageService {
  readonly name: string;
  readonly client: S3Client;

  #expiresIn: number;

  constructor(options: S3ServiceOptions) {
    this.name = options.name ?? "s3";
    this.#expiresIn = options.expiresIn ?? 300;

    this.client = new S3Client({
      bucket: options.bucket,
      region: options.region,
      endpoint: options.endpoint,
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      sessionToken: options.sessionToken,
    });
  }

  async upload(
    key: string,
    data: Uint8Array | ArrayBuffer | Blob,
    options: UploadOptions = {},
  ): Promise<void> {
    await this.client.write(key, data as Blob, { type: options.contentType });
  }

  async download(key: string): Promise<Uint8Array> {
    const file = this.client.file(key);
    if (!(await file.exists())) throw new FileNotFound(key, this.name);

    return new Uint8Array(await file.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    await this.client.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return await this.client.exists(key);
  }

  async url(key: string, options: UrlOptions = {}): Promise<string> {
    return this.client.presign(key, {
      expiresIn: options.expiresIn ?? this.#expiresIn,
      ...(options.contentType ? { type: options.contentType } : {}),
    });
  }
}

const services = new Map<string, StorageService>();
let defaultService: string | undefined;

export interface StorageConfig {
  services: Record<string, StorageService>;
  /** Which one to use when a blob does not name its own. */
  default?: string;
}

export function configureStorage(config: StorageConfig): void {
  services.clear();

  for (const [name, service] of Object.entries(config.services)) {
    services.set(name, service);
  }

  defaultService = config.default ?? Object.keys(config.services)[0];
}

/** The service a blob belongs to, or the default. */
export function storageService(name?: string): StorageService {
  const wanted = name ?? defaultService;

  if (!wanted) {
    throw new Error("No storage service configured. Call configureStorage() first.");
  }

  const service = services.get(wanted);
  if (!service) {
    const known = [...services.keys()];
    throw new Error(
      known.length > 0
        ? `No storage service named "${wanted}". Configured: ${known.join(", ")}.`
        : `No storage service named "${wanted}".`,
    );
  }

  return service;
}

export function defaultServiceName(): string {
  if (!defaultService) {
    throw new Error("No storage service configured. Call configureStorage() first.");
  }
  return defaultService;
}

export function resetStorage(): void {
  services.clear();
  defaultService = undefined;
}
