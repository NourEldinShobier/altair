/**
 * Reading what is inside a rich text body, ported from
 * `ActionText::Content` — the `links`, `attachables` and
 * `attachable_*_representation` parts.
 *
 * `fragment.ts` transforms a body: canonicalize it, minify its attachments,
 * convert the editor's markup to ours. This asks questions about one instead,
 * and the questions are the ones an application actually has:
 *
 *   - **what does this link to** — a moderation queue, a spam check, a digest
 *     mail that has to rewrite every URL to a tracked one
 *   - **what does this attach** — the only way to know whether a blob is still
 *     referenced, and so the only safe basis for deleting one
 *   - **how does an attachment read with no HTML** — the text/plain part of an
 *     email, a search index, a notification preview
 *
 * The last is the one that goes wrong quietly. Strip the tags from a body and
 * every attachment becomes nothing: a message that was a caption and a photo
 * arrives as the caption, and the recipient cannot tell a photo was meant.
 */

import { ATTACHMENT_SELECTOR, Fragment, attributeOf } from "./fragment.js";
import type { AttachmentAttributes } from "./attachables.js";

/** One link found in a body. */
export interface ContentLink {
  href: string;
  /** The visible text, with any markup inside it removed. */
  text: string;
}

/**
 * What an attachment node in a body says about itself.
 *
 * `AttachmentAttributes` is the same vocabulary from the writing side, made
 * partial here because this is read off markup that may be malformed — a node
 * with no sgid is a node somebody hand-edited, and dropping it silently is
 * worse than reporting it without one. Distinct from `Attachable` in
 * attachables.ts, which is the record being attached rather than the node
 * naming it.
 */
export interface AttachedNode extends Partial<AttachmentAttributes> {
  /** Where the file is, when the node carries it. */
  url?: string;
  /** The whole node, for a caller that needs more than these. */
  node: string;
}

const LINK = /<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;

/**
 * Every link in a body, in the order they appear. Rails' `links`.
 *
 * Duplicates are kept rather than collapsed: "this post links to the same
 * domain nine times" is the shape a spam check is looking at, and a caller
 * that wants them unique can say so in one line.
 */
export function contentLinks(html: string | Fragment): ContentLink[] {
  const source = sourceOf(html);

  return [...source.matchAll(LINK)].map((match) => ({
    href: decodeEntities(match[1] ?? ""),
    text: stripTags(match[2] ?? "").trim(),
  }));
}

/** Just the addresses, which is what a rewrite or a check usually wants. */
export function contentLinkUrls(html: string | Fragment): string[] {
  return contentLinks(html).map((link) => link.href);
}

/**
 * Every attachment in a body. Rails' `attachables`.
 *
 * The list a purge has to consult. A blob referenced only from inside a rich
 * text body has no association row pointing at it, so deleting "unattached"
 * blobs without reading the bodies deletes images out of published posts —
 * and the post still renders, with a broken image where the picture was.
 */
export function contentAttachables(html: string | Fragment): AttachedNode[] {
  return Fragment.wrap(sourceOf(html))
    .findAll(ATTACHMENT_SELECTOR)
    .map((node) => ({
      ...pick(node, "sgid", "sgid"),
      ...pick(node, "content-type", "contentType"),
      ...pick(node, "filename", "filename"),
      ...pick(node, "url", "url"),
      ...pick(node, "caption", "caption"),
      node,
    }));
}

/** The signed ids alone, which is what a reference check compares. */
export function contentAttachableSgids(html: string | Fragment): string[] {
  return contentAttachables(html)
    .map((attachable) => attachable.sgid)
    .filter((sgid): sgid is string => sgid !== undefined);
}

/**
 * Adds attachments to the end of a body. Rails' `append_attachables`.
 *
 * Appended as nodes rather than spliced in, because where an attachment goes
 * in the middle of a body is the author's decision and there is no sensible
 * guess. The end is the one position that is always meant.
 */
export function appendAttachables(
  html: string | Fragment,
  attachables: { sgid: string; contentType?: string; filename?: string; caption?: string }[],
): Fragment {
  const nodes = attachables.map((attachable) => {
    const attributes = [
      `sgid="${escapeAttribute(attachable.sgid)}"`,
      ...(attachable.contentType === undefined
        ? []
        : [`content-type="${escapeAttribute(attachable.contentType)}"`]),
      ...(attachable.filename === undefined
        ? []
        : [`filename="${escapeAttribute(attachable.filename)}"`]),
      ...(attachable.caption === undefined
        ? []
        : [`caption="${escapeAttribute(attachable.caption)}"`]),
    ];

    return `<${ATTACHMENT_SELECTOR} ${attributes.join(" ")}></${ATTACHMENT_SELECTOR}>`;
  });

  return new Fragment(sourceOf(html) + nodes.join(""));
}

/**
 * How an attachment reads with no HTML. Rails'
 * `attachable_plain_text_representation`.
 *
 * A name in brackets rather than nothing, because nothing is what a plain tag
 * strip produces and it loses the fact that something was there. A message
 * that was a caption and a photo arrives as the caption alone, and the
 * recipient cannot tell a photo was meant.
 */
export function attachablePlainTextRepresentation(attachable: AttachedNode): string {
  return `[${attachable.caption ?? attachable.filename ?? describeType(attachable.contentType)}]`;
}

/**
 * The same for Markdown, where an image has a real spelling. Rails'
 * `attachable_markdown_representation`.
 */
export function attachableMarkdownRepresentation(attachable: AttachedNode): string {
  const label = attachable.caption ?? attachable.filename ?? "";

  if (attachable.url === undefined) return attachablePlainTextRepresentation(attachable);

  const link = `[${label}](${attachable.url})`;

  return isImage(attachable.contentType) ? `!${link}` : link;
}

/** Whether a preview could be shown for it. Rails' `previewable_attachable?`. */
export function isPreviewableAttachable(attachable: AttachedNode): boolean {
  const type = attachable.contentType?.split(";")[0]?.trim().toLowerCase();

  if (type === undefined) return false;

  return type === "application/pdf" || type.startsWith("video/");
}

/** Word-for-word what a type is, for an attachment with no name of its own. */
function describeType(contentType: string | undefined): string {
  const type = contentType?.split("/")[0]?.toLowerCase();

  switch (type) {
    case "image":
      return "Image";
    case "video":
      return "Video";
    case "audio":
      return "Audio";
    default:
      return "Attachment";
  }
}

function isImage(contentType: string | undefined): boolean {
  return contentType?.toLowerCase().startsWith("image/") ?? false;
}

function sourceOf(html: string | Fragment): string {
  return html instanceof Fragment ? html.source : String(html ?? "");
}

function pick(node: string, attribute: string, key: string): Record<string, string> {
  const value = attributeOf(node, attribute);

  return value === undefined ? {} : { [key]: decodeEntities(value) };
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

/**
 * The entities an attribute value can carry.
 *
 * Only the five the escaper produces: a link's href is compared against a
 * host, put in a header, or followed, and `&amp;` left in place turns a query
 * string into a different query string.
 */
function decodeEntities(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}
