/**
 * Image variants, ported from `ActiveStorage::Variant`.
 *
 * Rails needs libvips or ImageMagick installed on the machine, and the ruby
 * bindings to reach it. Bun 1.4 ships the codecs statically — libjpeg-turbo,
 * libspng, libwebp — with SIMD resize and rotate, so a variant needs nothing
 * installed and no native module to build.
 *
 *     const thumb = post.cover.variant({ resize: [400, 400], format: "webp" })
 *     await thumb.url()
 *
 * A variant is processed once. The key it is stored under is a digest of the
 * blob and the transformations, so asking for the same variant twice finds the
 * one already there rather than doing the work again — which is the difference
 * between a thumbnail and a denial of service.
 */

import { createHash } from "node:crypto";
import { StorageBlob } from "./blob.js";
import { storageService, type UrlOptions } from "./service.js";

/** How an image is fitted into the size asked for. */
export type ResizeFit = "cover" | "contain" | "fill" | "inside" | "outside";

export interface Transformations {
  /** Width and height. One number keeps the source aspect ratio. */
  resize?: [number, number?];
  fit?: ResizeFit;
  /** Never scales a small image up, which is Rails' `resize_to_limit`. */
  withoutEnlargement?: boolean;
  format?: "jpeg" | "png" | "webp";
  /** 1–100. Ignored by PNG, which is lossless. */
  quality?: number;
  /** A multiple of 90. */
  rotate?: number;
  flip?: boolean;
  flop?: boolean;
  brightness?: number;
  saturation?: number;
}

/** Content types a variant can be made from. */
const PROCESSABLE = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export function isProcessable(contentType: string | null | undefined): boolean {
  return contentType !== null && contentType !== undefined && PROCESSABLE.has(contentType);
}

export class UnprocessableImage extends Error {
  constructor(contentType: string | null) {
    super(
      `Cannot make a variant of ${contentType ?? "a file with no content type"}. ` +
        `Variants are for images: ${[...PROCESSABLE].join(", ")}.`,
    );
    this.name = "UnprocessableImage";
  }
}

/**
 * The key a variant is stored under.
 *
 * A digest of the blob's key and the transformations, so the same request
 * lands on the same object and a variant is computed once. Sorted, so two
 * callers writing the options in a different order get one variant rather than
 * two.
 */
export function variantKey(blobKey: string, transformations: Transformations): string {
  const canonical = JSON.stringify(
    Object.fromEntries(Object.entries(transformations).sort(([a], [b]) => a.localeCompare(b))),
  );

  const digest = createHash("sha256").update(`${blobKey}/${canonical}`).digest("hex").slice(0, 32);
  return `variants/${blobKey}/${digest}`;
}

/** The content type a variant comes out as. */
export function variantContentType(
  transformations: Transformations,
  fallback: string | null,
): string {
  if (transformations.format) return `image/${transformations.format}`;
  return fallback ?? "application/octet-stream";
}

/** What the image pipeline needs from the runtime. Declared, so it can be swapped. */
interface ImagePipeline {
  resize(width: number, height?: number, options?: Record<string, unknown>): ImagePipeline;
  rotate(degrees: number): ImagePipeline;
  flip(): ImagePipeline;
  flop(): ImagePipeline;
  modulate(options: { brightness?: number; saturation?: number }): ImagePipeline;
  jpeg(options?: { quality?: number }): ImagePipeline;
  png(options?: { compressionLevel?: number }): ImagePipeline;
  webp(options?: { quality?: number }): ImagePipeline;
  bytes(): Promise<Uint8Array>;
}

type ImageConstructor = new (input: Uint8Array) => ImagePipeline;

function imageConstructor(): ImageConstructor {
  const runtime = (Bun as unknown as { Image?: ImageConstructor }).Image;

  if (!runtime) {
    throw new Error(
      "This runtime has no image support. Bun 1.4 or newer ships it; check `bun --version`.",
    );
  }

  return runtime;
}

/**
 * Applies the transformations to some bytes.
 *
 * Exported on its own because it is the whole of the image work, and a caller
 * that wants a transformed image without storing it should not have to make a
 * blob first.
 */
export async function transform(
  source: Uint8Array,
  transformations: Transformations,
): Promise<Uint8Array> {
  const Image = imageConstructor();
  let pipeline: ImagePipeline = new Image(source);

  if (transformations.rotate !== undefined) pipeline = pipeline.rotate(transformations.rotate);
  if (transformations.flip) pipeline = pipeline.flip();
  if (transformations.flop) pipeline = pipeline.flop();

  if (transformations.resize) {
    const [width, height] = transformations.resize;
    pipeline = pipeline.resize(width, height, {
      ...(transformations.fit ? { fit: transformations.fit } : {}),
      ...(transformations.withoutEnlargement ? { withoutEnlargement: true } : {}),
    });
  }

  if (transformations.brightness !== undefined || transformations.saturation !== undefined) {
    pipeline = pipeline.modulate({
      ...(transformations.brightness === undefined
        ? {}
        : { brightness: transformations.brightness }),
      ...(transformations.saturation === undefined
        ? {}
        : { saturation: transformations.saturation }),
    });
  }

  const quality = transformations.quality;

  switch (transformations.format) {
    case "jpeg":
      pipeline = pipeline.jpeg(quality === undefined ? undefined : { quality });
      break;
    case "png":
      pipeline = pipeline.png();
      break;
    case "webp":
      pipeline = pipeline.webp(quality === undefined ? undefined : { quality });
      break;
    default:
      break;
  }

  return await pipeline.bytes();
}

/**
 * One variant of one blob.
 *
 * Nothing happens until it is asked for. Rails does the same: a variant named
 * in a template that is never rendered costs nothing.
 */
export class Variant {
  readonly key: string;

  constructor(
    readonly blob: StorageBlob,
    readonly transformations: Transformations,
  ) {
    this.key = variantKey(blob.key as string, transformations);
  }

  get contentType(): string {
    return variantContentType(this.transformations, this.blob.content_type as string | null);
  }

  /** Whether the work has already been done. */
  async isProcessed(): Promise<boolean> {
    return await this.service.exists(this.key);
  }

  private get service() {
    return storageService(this.blob.service_name as string | undefined);
  }

  /**
   * Makes the variant if it does not exist yet, and returns its bytes.
   *
   * Processed once and stored: asking for the same thumbnail on every page
   * view and recomputing it each time is how an image becomes a way to take a
   * site down.
   */
  async process(): Promise<Uint8Array> {
    const service = this.service;

    if (await service.exists(this.key)) return await service.download(this.key);

    if (!isProcessable(this.blob.content_type as string | null)) {
      throw new UnprocessableImage(this.blob.content_type as string | null);
    }

    const processed = await transform(await this.blob.download(), this.transformations);
    await service.upload(this.key, processed, { contentType: this.contentType });

    return processed;
  }

  /** A URL for the variant, processing it first if it has not been. */
  async url(options: UrlOptions = {}): Promise<string> {
    await this.process();

    return await this.service.url(this.key, {
      contentType: this.contentType,
      filename: this.filename,
      ...options,
    });
  }

  /** The variant's filename, with the extension its format implies. */
  get filename(): string {
    const original = (this.blob.filename as string) ?? "file";
    if (!this.transformations.format) return original;

    return `${original.replace(/\.[^.]+$/, "")}.${this.transformations.format}`;
  }

  /** Deletes the processed bytes. The next request makes them again. */
  async purge(): Promise<void> {
    await this.service.delete(this.key);
  }
}
