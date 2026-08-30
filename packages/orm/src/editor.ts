/**
 * Getting a body in and out of the editor, ported from
 * `ActionText::TrixAttachment`, `ActionText::ContentHelper` and the
 * `rich_text_area` helper.
 *
 * `fragment.ts` already converts our attachment markup *to* the editor's on
 * the way out. The way back was missing, which is the half that loses work: an
 * editor saves `<figure data-trix-attachment="…">`, and stored as it arrives
 * that body no longer matches the attachment selector — so the attachment is
 * invisible to `contentAttachables`, invisible to a purge check, and renders
 * as an empty figure.
 *
 * Trix carries its attachment as a JSON blob in an attribute rather than as
 * attributes of its own, which is why this is not a rename. The blob has to be
 * read, the signed id taken out of it, and the rest thrown away — the renderer
 * decides how an attachment looks each time, so keeping the editor's idea of
 * its width is storing a decision that was never ours.
 */

import {
  ATTACHMENT_SELECTOR,
  Fragment,
  TRIX_ATTACHMENT_SELECTOR,
  attributeOf,
} from "./fragment.js";

/** What the editor puts in `data-trix-attachment`. */
export interface TrixAttachment {
  sgid?: string;
  contentType?: string;
  filename?: string;
  url?: string;
  caption?: string;
  width?: number;
  height?: number;
}

/** The attribute the editor stores its attachment JSON in. */
export const TRIX_ATTACHMENT_ATTRIBUTE = "data-trix-attachment";

/** The attribute Rails writes the signed id into directly. */
export const TRIX_SGID_ATTRIBUTE = "data-trix-attachment-sgid";

/** The tag an editor field is. Rails' `rich_text_area` / `editor_tag`. */
export function editorTag(): string {
  return "trix-editor";
}

/** What the editor calls an attachment node. Rails' `element_name`. */
export function elementName(): string {
  return TRIX_ATTACHMENT_SELECTOR;
}

/**
 * Reads one editor attachment node. Rails' `from_trix_attachment`.
 *
 * Both spellings, because Rails writes the signed id as its own attribute on
 * the way out and the editor sends the JSON blob back. A round trip through a
 * real editor produces one of each, and reading only one of them silently
 * drops half the attachments in a body somebody edited.
 */
export function fromTrixAttachment(node: string): TrixAttachment | null {
  const direct = attributeOf(node, TRIX_SGID_ATTRIBUTE);

  if (direct !== undefined) return { sgid: decodeEntities(direct) };

  const raw = attributeOf(node, TRIX_ATTACHMENT_ATTRIBUTE);

  if (raw === undefined) return null;

  try {
    const parsed: unknown = JSON.parse(decodeEntities(raw));

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

    return parsed as TrixAttachment;
  } catch {
    // Untrusted: the blob comes back from a browser and a person can edit it.
    // A body with one unreadable attachment should keep its other attachments
    // rather than fail to save.
    return null;
  }
}

/** Writes one as the editor expects it. Rails' `to_trix_attachment`. */
export function toTrixAttachment(attachment: TrixAttachment): string {
  const json = escapeAttribute(JSON.stringify(attachment));

  return `<${TRIX_ATTACHMENT_SELECTOR} ${TRIX_ATTACHMENT_ATTRIBUTE}="${json}"></${TRIX_ATTACHMENT_SELECTOR}>`;
}

/**
 * Turns what the editor saved into what gets stored. Rails'
 * `fragment_by_converting_trix_attachments` in the incoming direction.
 *
 * Only the signed id survives, as with `fragmentByMinifyingAttachments`: the
 * renderer decides how an attachment looks each time it renders, so a stored
 * copy of the editor's width and caption is a body that renders differently
 * from a new one for no reason anybody can see.
 *
 * A node with no readable attachment is left exactly as it was rather than
 * dropped — it may be an ordinary `<figure>` somebody wrote, and deleting
 * markup because it did not parse is how an editor eats a document.
 */
export function fragmentFromEditorHtml(html: string): Fragment {
  return Fragment.fromHtml(html).replace(TRIX_ATTACHMENT_SELECTOR, (node) => {
    const attachment = fromTrixAttachment(node);

    if (attachment?.sgid === undefined) return node;

    return `<${ATTACHMENT_SELECTOR} sgid="${escapeAttribute(attachment.sgid)}"></${ATTACHMENT_SELECTOR}>`;
  });
}

/** The stored body as the editor should load it. Rails' `to_trix_html`. */
export function toEditorHtml(html: string | Fragment): Fragment {
  const source = html instanceof Fragment ? html.source : String(html ?? "");

  return Fragment.fromHtml(source).replace(ATTACHMENT_SELECTOR, (node) => {
    const sgid = attributeOf(node, "sgid");

    if (sgid === undefined) return node;

    return `<${TRIX_ATTACHMENT_SELECTOR} ${TRIX_SGID_ATTRIBUTE}="${escapeAttribute(sgid)}"></${TRIX_ATTACHMENT_SELECTOR}>`;
  });
}

/** A Markdown link, escaped so a caption cannot become markup. */
export function markdownLink(text: string, url: string): string {
  return `[${escapeMarkdownText(text)}](${url.replaceAll(")", "%29")})`;
}

/**
 * Escapes the characters that turn text into Markdown.
 *
 * Only what actually changes meaning inside a paragraph. Escaping more makes a
 * caption unreadable in the plain-text part of an email, which is the one
 * place it will be read raw.
 */
export function escapeMarkdownText(text: string): string {
  return text.replaceAll(/([\\`*_[\]()])/g, "\\$1");
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function decodeEntities(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}
