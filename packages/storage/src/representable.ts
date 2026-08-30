/**
 * Whether a blob can be shown as an image, ported from
 * `ActiveStorage::Blob::Representable`.
 *
 * The question a view asks before rendering a thumbnail, and it has three
 * different answers depending on what the file is:
 *
 *   - **variable** — already an image the processor can transform
 *   - **previewable** — not an image, but something a first frame or first
 *     page can be extracted from: a PDF, a video
 *   - **representable** — either, which is what the view usually wants
 *
 * Getting this wrong is not cosmetic. A template that assumes every attachment
 * is variable throws on the first PDF somebody uploads, and one that assumes
 * none is shows a generic file icon next to a photo.
 */

import { isProcessable } from "./variant.js";

/**
 * Formats a previewer can pull a still image out of.
 *
 * Kept narrow on purpose. Listing a type here is a promise that a previewer
 * exists for it, and a promise that is not kept surfaces as a broken image on
 * a page rather than as an error anybody sees.
 */
const PREVIEWABLE = new Set([
  "application/pdf",
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-msvideo",
  "video/mpeg",
]);

/** Whether the processor can transform this blob directly. Rails' `variable?`. */
export function isVariable(contentType: string | null | undefined): boolean {
  return isProcessable(contentType);
}

/** Whether a still can be extracted from it. Rails' `previewable?`. */
export function isPreviewable(contentType: string | null | undefined): boolean {
  if (!contentType) return false;

  return PREVIEWABLE.has(contentType.split(";")[0]?.trim().toLowerCase() ?? "");
}

/**
 * Whether it can be shown as an image at all. Rails' `representable?`.
 *
 * The one a view should ask. The other two answer *how*, and a template that
 * branches on them is a template that has to be updated when a new format
 * becomes previewable.
 */
export function isRepresentable(contentType: string | null | undefined): boolean {
  return isVariable(contentType) || isPreviewable(contentType);
}

/** How a blob would be turned into an image, or null if it cannot be. */
export type Representation = "variant" | "preview" | null;

/**
 * Which route a blob takes to become an image. Rails' `representation`.
 *
 * Variant first: a file that is already an image is transformed directly, and
 * running it through a previewer would decode and re-encode it for nothing.
 */
export function representationFor(contentType: string | null | undefined): Representation {
  if (isVariable(contentType)) return "variant";
  if (isPreviewable(contentType)) return "preview";

  return null;
}

/** Whether a blob is an image of any kind, transformable or not. */
export function isImage(contentType: string | null | undefined): boolean {
  return (contentType ?? "").toLowerCase().startsWith("image/");
}

/** Whether it is a video. */
export function isVideo(contentType: string | null | undefined): boolean {
  return (contentType ?? "").toLowerCase().startsWith("video/");
}

/** Whether it is audio. */
export function isAudio(contentType: string | null | undefined): boolean {
  return (contentType ?? "").toLowerCase().startsWith("audio/");
}

/** Whether it is text of some kind, including the many `+json` spellings. */
export function isText(contentType: string | null | undefined): boolean {
  const bare = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";

  return bare.startsWith("text/") || /^application\/(json|xml|.*\+(json|xml))$/.test(bare);
}

/**
 * Adds a previewable type.
 *
 * For an application that has a previewer of its own — a CAD format, a
 * proprietary document. Registering it is the honest way to extend the list,
 * as against editing the constant and having the promise silently unbacked.
 */
export function registerPreviewableType(contentType: string): void {
  PREVIEWABLE.add(contentType.toLowerCase());
}

/** Every type a still can currently be extracted from. */
export function previewableTypes(): string[] {
  return [...PREVIEWABLE];
}
