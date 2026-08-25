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

/** What a browser needs to PUT the bytes straight at the service. */
export interface DirectUpload {
  url: string;
  headers: Record<string, string>;
}

export interface DirectUploadOptions {
  contentType: string;
  /** Checked on arrival. A byte count the client chose is not a byte count. */
  contentLength: number;
  /** base64 MD5, as Rails sends. Checked on arrival where the service can. */
  checksum?: string;
  /** Seconds the URL stays valid. Rails gives a direct upload five minutes. */
  expiresIn?: number;
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
  /**
   * A URL the browser can PUT to, bypassing the application entirely.
   *
   * The point of a direct upload is that a two-gigabyte video never travels
   * through the process serving requests.
   */
  directUpload(key: string, options: DirectUploadOptions): Promise<DirectUpload>;
}

/** Raised when a key names nothing the service holds. */
export class FileNotFound extends Error {
  constructor(key: string, service: string) {
    super(`No file with key "${key}" in the ${service} service.`);
    this.name = "FileNotFound";
  }
}

/** Control characters, built from code points so no escape can be mangled. */
const CONTROL = new RegExp(`[${String.fromCodePoint(0)}-${String.fromCodePoint(0x1f)}]`);

/** Raised when a key would name something outside the service's root. */
export class UnsafeKey extends Error {
  constructor(
    readonly key: string,
    reason: string,
  ) {
    super(`Refusing to build a disk path from ${JSON.stringify(key)}: ${reason}.`);
    this.name = "UnsafeKey";
  }
}

/**
 * Checks that a key names something inside the service's root.
 *
 * A key may nest — a variant is stored under `variants/<blob key>/<digest>`,
 * so barring separators outright is wrong, and a first version of this broke
 * every variant in the suite. What it may not do is climb: no segment may be
 * `..`, which is what makes escaping impossible rather than merely unlikely.
 *
 * Worth checking even though every key the framework generates is safe and
 * every key `serveDisk` reads is signed. An application that keeps its own
 * keys and calls `download(key)` with one it was handed is doing an ordinary
 * thing, and the failure there is reading any file the process can reach.
 */
export function assertSafeKey(key: string): void {
  if (key.length === 0) throw new UnsafeKey(key, "a key cannot be empty");
  if (key.length > 1024) throw new UnsafeKey(key, "a key cannot be longer than 1024 characters");

  // Backslash separates on Windows, so a key holding one would nest there and
  // not here — and `..\` would climb. Checked before the path is built, so
  // the platform gets no say.
  if (key.includes("\\")) throw new UnsafeKey(key, "a key cannot contain a backslash");

  // A newline or a NUL in a path is nobody's key and every logger's problem.
  // eslint-disable-next-line no-control-regex
  if (CONTROL.test(key)) throw new UnsafeKey(key, "a key cannot contain a control character");

  if (key.startsWith("/")) throw new UnsafeKey(key, "a key cannot be absolute");

  // The one that still escaped after separators were barred: the path nests by
  // the key's first two characters, so a key beginning `..` makes `..` a
  // directory — `root/../` — without holding a separator at all.
  if (key.startsWith(".")) throw new UnsafeKey(key, "a key cannot start with a dot");

  for (const segment of key.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new UnsafeKey(key, `"${segment}" is not a path segment a key may contain`);
    }
  }
}

/**
 * Where a key lives on disk.
 *
 * Rails nests by the first four characters of the key. A directory with a
 * million files in it is a directory some filesystems will not list.
 */
export function diskPath(key: string): string {
  assertSafeKey(key);

  // Empty parts dropped rather than joined blindly: a key shorter than four
  // characters has no second folder, and `ab//ab` is a path with a segment
  // that names nothing.
  return [key.slice(0, 2), key.slice(2, 4), key].filter(Boolean).join("/");
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

const DOWNLOAD = "altair.storage.download";
const UPLOAD = "altair.storage.upload";

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

    const token = this.#verifier.generate(
      {
        key,
        disposition: options.disposition ?? "inline",
        contentType: options.contentType,
        expiresAt: options.expiresIn ? Date.now() + options.expiresIn * 1000 : undefined,
      },
      DOWNLOAD,
    );

    return `${this.#urlPrefix}/${encodeURIComponent(token)}/${encodeURIComponent(filename)}`;
  }

  /**
   * A URL to PUT bytes at. A bucket answers its own; the disk cannot, so
   * `serveDisk` answers this one.
   *
   * The content type, the length and the checksum are signed into the token
   * rather than read off the request, because a client that declares its own
   * limits has none.
   */
  async directUpload(key: string, options: DirectUploadOptions): Promise<DirectUpload> {
    if (!this.#verifier) {
      throw new Error(
        "Direct uploads need a signed URL. Give this DiskService a `secret`; " +
          "an unsigned upload endpoint is a public file drop.",
      );
    }

    const token = this.#verifier.generate(
      {
        key,
        contentType: options.contentType,
        contentLength: options.contentLength,
        checksum: options.checksum,
        expiresAt: Date.now() + (options.expiresIn ?? 300) * 1000,
      },
      UPLOAD,
    );

    return {
      url: `${this.#urlPrefix}/${encodeURIComponent(token)}`,
      headers: { "content-type": options.contentType },
    };
  }

  /** @internal Verifies a token produced by `url`. */
  verify(token: string): { key: string; disposition: string; contentType?: string } {
    return this.#payload(token, DOWNLOAD);
  }

  /** @internal Verifies a token produced by `directUpload`. */
  verifyUpload(token: string): {
    key: string;
    contentType: string;
    contentLength: number;
    checksum?: string;
  } {
    return this.#payload(token, UPLOAD);
  }

  // Read and write tokens are signed under different purposes deliberately: a
  // link that lets someone see a file must not also let them replace it.
  #payload<T>(token: string, purpose: string): T {
    if (!this.#verifier) throw new Error("This disk service was configured without a secret.");

    const payload = this.#verifier.verify<T & { expiresAt?: number }>(token, purpose);

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

  /**
   * A presigned PUT, which is the whole reason direct uploads exist: the file
   * goes from the browser to the bucket without passing through here.
   *
   * The signature covers `host` and nothing else, because that is all Bun's
   * presigner signs — `type` there becomes `response-content-type`, a GET
   * response override that means nothing on a PUT. So unlike the disk service,
   * the bucket will not reject a file whose type or size differs from what was
   * declared; it stores what arrives. Content-MD5 is still sent, since S3
   * checks it when present and rejects a body that does not match, which is
   * the one guarantee available here.
   *
   * Enforcing the rest would need a presigned POST policy, which Bun does not
   * generate. Until it does, an application that must enforce a size limit on
   * S3 should check `byte_size` on the blob after the upload, before showing
   * the file to anyone.
   */
  async directUpload(key: string, options: DirectUploadOptions): Promise<DirectUpload> {
    const url = this.client.presign(key, {
      method: "PUT",
      expiresIn: options.expiresIn ?? this.#expiresIn,
    });

    return {
      url,
      headers: {
        "content-type": options.contentType,
        ...(options.checksum ? { "content-md5": options.checksum } : {}),
      },
    };
  }
}

const services = new Map<string, StorageService>();
let defaultService: string | undefined;
let signingSecret: string | undefined;

export interface StorageConfig {
  services: Record<string, StorageService>;
  /** Which one to use when a blob does not name its own. */
  default?: string;
  /**
   * Signs blob ids, so a form can hand one back without the server having to
   * trust a raw primary key. Without it, `1` attaches whatever blob is first.
   */
  secret?: string;
}

export function configureStorage(config: StorageConfig): void {
  services.clear();

  for (const [name, service] of Object.entries(config.services)) {
    services.set(name, service);
  }

  defaultService = config.default ?? Object.keys(config.services)[0];
  signingSecret = config.secret;
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

/** The verifier signed blob ids use. Rails signs them with the app's secret. */
export function storageVerifier(): MessageVerifier {
  if (!signingSecret) {
    throw new Error(
      "Signed blob ids need a secret. Pass `secret` to configureStorage(); " +
        "an unsigned id lets a form attach any file in the table.",
    );
  }

  return new MessageVerifier(signingSecret);
}

export function resetStorage(): void {
  services.clear();
  defaultService = undefined;
  signingSecret = undefined;
}
