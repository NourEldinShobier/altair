/**
 * Reading what a blob is, ported from ActiveStorage's analyzers.
 *
 *     await analyze(blob)
 *     blob.metadataObject()   // { width: 1200, height: 800, format: "jpeg", analyzed: true }
 *
 * What it is for is answering questions about a file without fetching it
 * again. A page that lays out a gallery needs every image's dimensions to
 * reserve space before they load, and the alternative to storing them is
 * downloading a hundred images to measure them.
 *
 * Rails runs this in a background job after an upload, because by then it has
 * only the blob and has to download the bytes again to measure them. An upload
 * through `createBlob` still has those bytes in hand, so it measures them there
 * and the job is not needed at all — which is why analysis is not deferred by
 * default here.
 *
 * `analyzeLater` is for the one case that does need it: a direct upload, where
 * the bytes went from the browser to the service and this process never saw
 * them.
 */

import type { StorageBlob } from "./blob.js";

/** What an analyzer found. Deliberately open: a format may know more. */
export interface Analysis {
  width?: number;
  height?: number;
  format?: string;
  /** Set once, so a second pass can be skipped rather than repeated. */
  analyzed: true;
}

/**
 * Whether a content type is one this can read.
 *
 * Rails has analyzers for video and audio as well, which need ffprobe. This
 * has images, which need nothing that is not already here.
 */
export function isAnalyzable(contentType: string | null | undefined): boolean {
  return typeof contentType === "string" && contentType.startsWith("image/");
}

/**
 * Reads a blob's bytes and returns what they say about themselves.
 *
 * Returns null when there is nothing to read: a text file has no dimensions,
 * and a file that will not decode is not an error worth raising — an upload
 * that is not the image it claimed is the user's problem to see, not the
 * upload's to fail on.
 */
export async function analyzeBytes(
  bytes: Uint8Array,
  contentType: string | null | undefined,
): Promise<Analysis | null> {
  if (!isAnalyzable(contentType)) return null;

  try {
    const metadata = (await new Bun.Image(bytes).metadata()) as {
      width?: number;
      height?: number;
      format?: string;
    };

    return {
      width: metadata.width,
      height: metadata.height,
      format: metadata.format,
      analyzed: true,
    };
  } catch {
    // Not the image it said it was. Recorded as analyzed so nothing tries
    // again on every page that renders it.
    return { analyzed: true };
  }
}

/**
 * Analyses a blob and stores what it found.
 *
 * Skips a blob that has been analysed already, which is what makes this safe
 * to call from a view: the first render pays for it and the rest do not.
 */
export async function analyze(blob: StorageBlob): Promise<Analysis | null> {
  const existing = blob.metadataObject();
  if (existing.analyzed === true) return existing as unknown as Analysis;

  const analysis = await analyzeBytes(await blob.download(), blob.content_type as string | null);
  if (!analysis) return null;

  // Merged rather than replaced: whatever was put there at upload — a caption,
  // an uploader id — is not this function's to discard.
  blob.metadata = JSON.stringify({ ...existing, ...analysis });
  await blob.save();

  return analysis;
}

/** Where deferred analysis goes. Supplied by the application, as the mailer's queue is. */
export type AnalysisQueue = (blob: StorageBlob) => unknown | Promise<unknown>;

let queue: AnalysisQueue | undefined;

/**
 * Sets what `analyzeLater` hands a blob to.
 *
 * Registered rather than imported: storage has no business depending on the
 * job queue, and an application that analyses some other way should be able to
 * say so.
 */
export function configureAnalysis(options: { queue: AnalysisQueue | undefined }): void {
  queue = options.queue;
}

/**
 * Analyses a blob out of band. Rails' `analyze_later`.
 *
 * For a direct upload, where the bytes went from the browser to the service
 * and this process never saw them — measuring one means downloading it, which
 * is not something to do while a request is waiting.
 *
 * With no queue configured it analyses inline. That is slower than deferring
 * and much better than not analysing at all: a blob whose dimensions are never
 * read is one every image tag has to guess at, and silently doing nothing is
 * how a feature ends up shipped and unused.
 */
export async function analyzeLater(blob: StorageBlob): Promise<void> {
  if (queue) {
    await queue(blob);
    return;
  }

  await analyze(blob);
}
