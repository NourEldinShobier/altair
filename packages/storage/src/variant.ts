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

/** Raised when a transformation asks for something that should not be done. */
export class InvalidTransformation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTransformation";
  }
}

/**
 * The largest variant that will be produced, per side.
 *
 * A limit rather than none, because the cost of a resize is the product of the
 * target dimensions and nothing else bounds it. A request for 50,000 x 50,000
 * asks for a 10GB buffer, and the process does not come back — so a route that
 * lets any part of a transformation come from a parameter is a denial of
 * service with no exploit needed beyond a large number.
 *
 * 8192 is generous for anything shown to a person and still an order of
 * magnitude below where a single image exhausts an ordinary container.
 */
export const MAXIMUM_VARIANT_DIMENSION = 8192;

/**
 * Checks a transformation before any work is done. Rails'
 * `validate_transformation`.
 *
 * Everything here is a value the type system cannot bound: `resize` is a pair
 * of numbers and `[0, 0]` typechecks, `rotate` is documented as a multiple of
 * 90 and 37 typechecks, `quality` is documented as 1-100 and 5000 typechecks.
 * Left unchecked, each fails somewhere further in — inside the decoder, with a
 * message about the decoder — and one of them does not fail at all but eats
 * the machine.
 */
export function validateTransformation(transformations: Transformations): void {
  const { resize, rotate, quality, brightness, saturation } = transformations;

  if (resize) {
    for (const side of resize) {
      if (side === undefined) continue;

      if (!Number.isInteger(side) || side < 1) {
        throw new InvalidTransformation(
          `resize needs whole numbers of pixels above zero, got ${String(side)}.`,
        );
      }

      if (side > MAXIMUM_VARIANT_DIMENSION) {
        throw new InvalidTransformation(
          `resize to ${String(side)}px is above the ${String(MAXIMUM_VARIANT_DIMENSION)}px limit. ` +
            `A variant that large costs more memory than it is worth showing anybody.`,
        );
      }
    }
  }

  // A multiple of 90, which the type says in prose and cannot say in types.
  // Anything else needs interpolation and a background colour for the corners,
  // neither of which this has an answer for.
  if (rotate !== undefined && (!Number.isInteger(rotate) || rotate % 90 !== 0)) {
    throw new InvalidTransformation(`rotate takes a multiple of 90, got ${String(rotate)}.`);
  }

  if (quality !== undefined && (!Number.isInteger(quality) || quality < 1 || quality > 100)) {
    throw new InvalidTransformation(`quality is 1 to 100, got ${String(quality)}.`);
  }

  for (const [name, value] of [
    ["brightness", brightness],
    ["saturation", saturation],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new InvalidTransformation(`${name} takes a non-negative number, got ${String(value)}.`);
    }
  }
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
  // Before the decoder is reached, so a bad number is reported as the bad
  // number it is rather than as whatever the decoder says when it runs out of
  // memory — and, for a large resize, before the memory is asked for at all.
  validateTransformation(transformations);

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
