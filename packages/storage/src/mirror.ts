/**
 * The mirror service, ported from `ActiveStorage::Service::MirrorService`.
 *
 * Moving from one bucket to another is not a thing you do in one step. You
 * write to both for a while, copy the backlog across, and only then read from
 * the new one — because the moment reads move is the moment a file that never
 * made it becomes a broken page.
 *
 *     configureStorage({
 *       services: {
 *         production: new MirrorService({ primary: s3, mirrors: [gcs] }),
 *       },
 *     })
 *
 * Reads, URLs and direct uploads all go to the primary alone. Only the writes
 * fan out, which is the whole design: the mirrors are being filled, not
 * consulted.
 */

import type {
  DirectUpload,
  DirectUploadOptions,
  StorageService,
  UploadOptions,
  UrlOptions,
} from "./service.js";

export interface MirrorOptions {
  /** The service that answers every read. */
  primary: StorageService;
  /** The ones being kept in step. */
  mirrors: StorageService[];
  name?: string;
  /**
   * What to do when a mirror fails a write the primary accepted.
   *
   * `report` — the default — keeps the upload, because the file is safely in
   * the service that will be asked for it and failing the request would lose
   * it for the sake of a copy. `raise` fails the upload instead, for the part
   * of a migration where the copy is the point.
   */
  onMirrorError?: "report" | "raise";
  /** Where a tolerated failure goes. Defaults to `console.error`. */
  onError?: (error: unknown, mirror: StorageService) => void;
}

/** Raised when a mirror refused a write and the caller asked to hear about it. */
export class MirrorWriteFailed extends Error {
  constructor(
    readonly mirror: string,
    readonly key: string,
    readonly reason: unknown,
  ) {
    super(
      `The "${mirror}" mirror would not take "${key}": ${(reason as Error)?.message ?? reason}`,
    );
    this.name = "MirrorWriteFailed";
  }
}

export class MirrorService implements StorageService {
  readonly name: string;
  readonly primary: StorageService;
  readonly mirrors: StorageService[];

  #onMirrorError: "report" | "raise";
  #onError: (error: unknown, mirror: StorageService) => void;

  constructor(options: MirrorOptions) {
    this.name = options.name ?? "mirror";
    this.primary = options.primary;
    this.mirrors = options.mirrors;
    this.#onMirrorError = options.onMirrorError ?? "report";
    this.#onError = options.onError ?? ((error, mirror) => console.error(mirror.name, error));
  }

  /**
   * The primary first, then the mirrors.
   *
   * In that order rather than all at once: if the primary refuses the file
   * there is nothing to mirror, and writing to the mirrors anyway leaves
   * copies of a file the application does not believe exists.
   */
  async upload(
    key: string,
    data: Uint8Array | ArrayBuffer | Blob,
    options: UploadOptions = {},
  ): Promise<void> {
    // Read once. A Blob can be read again but a stream cannot, and handing the
    // same bytes to each mirror is what makes the fan-out safe for both.
    const bytes = await asBytes(data);

    await this.primary.upload(key, bytes, options);
    await this.#eachMirror(key, async (mirror) => await mirror.upload(key, bytes, options));
  }

  /**
   * Removed everywhere, and the primary last.
   *
   * A mirror that keeps a file the primary has dropped is a file nothing will
   * ever delete again — the record that named it is gone.
   */
  async delete(key: string): Promise<void> {
    await this.#eachMirror(key, async (mirror) => await mirror.delete(key));
    await this.primary.delete(key);
  }

  async download(key: string): Promise<Uint8Array> {
    return await this.primary.download(key);
  }

  async exists(key: string): Promise<boolean> {
    return await this.primary.exists(key);
  }

  async url(key: string, options: UrlOptions = {}): Promise<string> {
    return await this.primary.url(key, options);
  }

  /**
   * The primary's, and only the primary's.
   *
   * A direct upload goes from the browser to the service, so nothing here sees
   * the bytes and nothing here can copy them. Rails has the same hole and
   * fills it the same way: `mirror` afterwards, once the file has landed.
   */
  async directUpload(key: string, options: DirectUploadOptions): Promise<DirectUpload> {
    return await this.primary.directUpload(key, options);
  }

  /**
   * Copies a key the mirrors are missing, for the backlog a migration starts
   * with and for anything a direct upload put in the primary alone.
   *
   * Skips a mirror that already has it, so running this over a whole bucket
   * twice costs a HEAD per file rather than a re-upload.
   */
  async mirror(key: string): Promise<string[]> {
    const copied: string[] = [];
    const bytes = await this.primary.download(key);

    for (const mirror of this.mirrors) {
      if (await mirror.exists(key)) continue;

      await mirror.upload(key, bytes);
      copied.push(mirror.name);
    }

    return copied;
  }

  /** Runs something against every mirror, and decides what a failure means. */
  async #eachMirror(key: string, body: (mirror: StorageService) => Promise<void>): Promise<void> {
    for (const mirror of this.mirrors) {
      try {
        await body(mirror);
      } catch (error) {
        if (this.#onMirrorError === "raise") throw new MirrorWriteFailed(mirror.name, key, error);

        // Reported, never swallowed. A mirror that has quietly stopped taking
        // writes is one you find out about on the day you switch reads to it.
        this.#onError(error, mirror);
      }
    }
  }
}

/** The bytes, whatever they arrived as. */
async function asBytes(data: Uint8Array | ArrayBuffer | Blob): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);

  return new Uint8Array(await data.arrayBuffer());
}
