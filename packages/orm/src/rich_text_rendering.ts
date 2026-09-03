/**
 * Turning rich text back into markup, and the two shapes it has to take.
 * Ported from `ActionText::Content`, `Attachment` and the rendering helpers.
 *
 * `content.ts` reads links and attachments out of stored rich text and
 * `editor.ts` converts between the editor's markup and ours. What is missing
 * is the direction that matters most: getting it back out, which is not one
 * operation but two, and confusing them is the bug.
 *
 * A stored attachment is a reference — a signed global id and nothing else.
 * Rendering it for a **page** means resolving that reference and producing
 * whatever the attached thing looks like: an image tag, a card, a download
 * link. Rendering it for the **editor** means producing the placeholder Trix
 * understands, with the reference intact so a round trip does not lose it.
 *
 * Render the editor form on a page and readers see raw `<figure>` scaffolding.
 * Render the page form in the editor and the next save writes the *rendered*
 * markup into the column — so the reference is gone, the attachment can never
 * be re-resolved, and every later edit re-renders the render. That one is not
 * recoverable from the stored value.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { Fragment } from "./fragment.js";
import type { AttachedNode } from "./content.js";
import type { AttachmentAttributes } from "./attachables.js";

/** Which form a piece of rich text is being produced in. */
export type RenderTarget = "page" | "editor";

/**
 * A placeholder, plus what a renderer needs to turn it into markup.
 *
 * Extends `AttachmentAttributes` — what `attachables.ts` says a placeholder
 * carries — rather than restating it. `Attachable` over there is the *record*
 * being embedded, which is a different thing.
 */
export interface RenderableAttachment extends AttachmentAttributes {
  url?: string;
  /** Anything else the renderer for this type wants. */
  [key: string]: unknown;
}

/** How one kind of attachment becomes markup. */
export type AttachmentRenderer = (attachment: RenderableAttachment, target: RenderTarget) => string;

const renderers = new Map<string, AttachmentRenderer>();

/** The renderer for anything nothing else claims. */
let fallback: AttachmentRenderer = (attachment) =>
  `<a href="${escapeAttribute(attachment.url ?? "#")}">${escapeText(
    attachment.filename ?? "attachment",
  )}</a>`;

/** The renderer a `withRenderer` block chose, which is not the process's. */
const scopedRenderer = new AsyncLocalStorage<AttachmentRenderer>();

/** The fallback in force here: a block's if there is one, the process's if not. */
function currentFallback(): AttachmentRenderer {
  return scopedRenderer.getStore() ?? fallback;
}

export function registerAttachmentRenderer(contentType: string, render: AttachmentRenderer): void {
  renderers.set(contentType.toLowerCase(), render);
}

export function setFallbackRenderer(render: AttachmentRenderer): void {
  fallback = render;
}

/**
 * The renderer for one attachment. Rails' `previewable_attachable?` dispatch.
 *
 * Falls back on the type's prefix — `image/png` reaching the `image/` renderer
 * — because a registry keyed on the full type has to list every format, and
 * the one it forgets renders as a bare link on a page full of pictures.
 */
export function rendererFor(contentType: string | undefined): AttachmentRenderer {
  if (contentType === undefined) return currentFallback();

  const exact = renderers.get(contentType.toLowerCase());

  if (exact) return exact;

  const prefix = `${contentType.split("/")[0] ?? ""}/`;

  return renderers.get(prefix) ?? currentFallback();
}

export function clearAttachmentRenderers(): void {
  renderers.clear();
}

/** Whether something can be shown rather than linked. Rails' `previewable_attachable?`. */
export function previewableAttachable(attachment: RenderableAttachment): boolean {
  const type = attachment.contentType ?? "";

  return type.startsWith("image/") || type.startsWith("video/");
}

/**
 * One attachment as it appears on a page. Rails' `Attachment#to_html`.
 */
export function renderAttachment(
  attachment: RenderableAttachment,
  target: RenderTarget = "page",
): string {
  return rendererFor(attachment.contentType)(attachment, target);
}

/**
 * The editor's placeholder for an attachment. Rails' `to_editor_attachment`.
 *
 * The sgid is carried in an attribute rather than being resolved, because the
 * editor's job is to give it back unchanged on the next save. A placeholder
 * that lost it would leave the attachment unreachable the moment somebody
 * edited the paragraph next to it.
 */
export function toEditorAttachment(attachment: RenderableAttachment): string {
  const caption = attachment.caption ?? attachment.filename ?? "";

  return (
    `<figure data-trix-attachment-sgid="${escapeAttribute(attachment.sgid)}"` +
    (attachment.contentType === undefined
      ? ""
      : ` data-trix-content-type="${escapeAttribute(attachment.contentType)}"`) +
    `>${caption === "" ? "" : `<figcaption>${escapeText(caption)}</figcaption>`}</figure>`
  );
}

/** Where the editor's partial for an attachment lives. Rails' `to_trix_content_attachment_partial_path`. */
export function toTrixContentAttachmentPartialPath(contentType: string | undefined): string {
  return `action_text/content_attachment/${familyOf(contentType)}`;
}

/** And the one for a page. Rails' `to_editor_content_attachment_partial_path`. */
export function toEditorContentAttachmentPartialPath(contentType: string | undefined): string {
  return `action_text/editor_attachment/${familyOf(contentType)}`;
}

function familyOf(contentType: string | undefined): string {
  if (contentType === undefined || contentType === "") return "default";

  return (contentType.split("/")[0] ?? "default").toLowerCase();
}

/**
 * The whole document as the editor should see it. Rails' `to_trix_html`.
 *
 * Every attachment becomes a placeholder carrying its reference. Nothing is
 * resolved, because the editor will hand this straight back.
 */
export function toTrixHtml(
  html: string | Fragment,
  attachments: readonly RenderableAttachment[],
): string {
  let out = String(html instanceof Fragment ? html.toHtml() : html);

  for (const attachment of attachments) {
    out = out.replace(placeholderFor(attachment.sgid), toEditorAttachment(attachment));
  }

  return out;
}

/**
 * The whole document as a reader should see it. Rails' `to_rendered_html_with_layout`.
 *
 * Every attachment is resolved and rendered. This is the form that must never
 * be written back to the column: doing so replaces the reference with its
 * rendering, and the attachment can never be resolved again.
 */
export function toRenderedHtmlWithLayout(
  html: string | Fragment,
  attachments: readonly RenderableAttachment[],
  layout?: (body: string) => string,
): string {
  let out = String(html instanceof Fragment ? html.toHtml() : html);

  for (const attachment of attachments) {
    out = out.replace(placeholderFor(attachment.sgid), renderAttachment(attachment, "page"));
  }

  return layout ? layout(out) : `<div class="trix-content">${out}</div>`;
}

/** Both forms of one document, so a caller cannot accidentally use the wrong one. */
export function asEditable(
  html: string | Fragment,
  attachments: readonly RenderableAttachment[],
): string {
  return toTrixHtml(html, attachments);
}

export function asCanonical(
  html: string | Fragment,
  attachments: readonly RenderableAttachment[],
): string {
  return toRenderedHtmlWithLayout(html, attachments);
}

function placeholderFor(sgid: string): RegExp {
  return new RegExp(
    `<[^>]*data-trix-attachment-sgid="${sgid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>(?:</figure>)?`,
    "g",
  );
}

/**
 * Groups consecutive image attachments so they can be laid out together.
 * Rails' `render_attachment_galleries`.
 *
 * Only consecutive ones: two images separated by a paragraph are not a
 * gallery, and grouping them would move the paragraph.
 */
export function renderAttachmentGalleries(nodes: readonly AttachedNode[]): AttachedNode[][] {
  const groups: AttachedNode[][] = [];
  let current: AttachedNode[] = [];

  for (const node of nodes) {
    const isImage = String(node.contentType ?? "").startsWith("image/");

    if (isImage) {
      current.push(node);
      continue;
    }

    if (current.length > 0) {
      groups.push(current);
      current = [];
    }

    groups.push([node]);
  }

  if (current.length > 0) groups.push(current);

  return groups;
}

/** Whether a group is big enough to be laid out as a gallery rather than singly. */
export const GALLERY_MINIMUM = 2;

export function isGallery(group: readonly AttachedNode[]): boolean {
  return (
    group.length >= GALLERY_MINIMUM &&
    group.every((node) => String(node.contentType ?? "").startsWith("image/"))
  );
}

/** What the editor calls itself, for the markup that mounts it. Rails' `editor_name`. */
let editor = "trix";

export function editorName(): string {
  return editor;
}

export function setEditorName(name: string): void {
  editor = name;
}

/**
 * Runs something with a different renderer in place. Rails' `with_renderer`.
 *
 * Scoped, because swapping a module-level variable handed the replacement to
 * every render happening beside the block — so a request rendering rich text
 * got somebody else's renderer, and the attachment came out wrong rather than
 * missing.
 */
export function withRenderer<T>(render: AttachmentRenderer, body: () => T): T {
  return scopedRenderer.run(render, body);
}

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', "&quot;");
}

export function resetRichTextRendering(): void {
  renderers.clear();
  editor = "trix";
  fallback = (attachment) =>
    `<a href="${escapeAttribute(attachment.url ?? "#")}">${escapeText(
      attachment.filename ?? "attachment",
    )}</a>`;
}
