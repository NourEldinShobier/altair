/**
 * Embedding records in rich text, ported from `ActionText::Attachable` and
 * `ActionText::Attachment`.
 *
 * The half of rich text that was missing. A body could hold formatting and
 * links; it could not hold a record — an uploaded file, a mention of a person,
 * a card for a product. Rails stores those as a placeholder carrying a signed
 * id, and renders each one when the body is displayed.
 *
 *     <action-text-attachment sgid="…" content-type="…"></action-text-attachment>
 *
 * The id is signed because the body is user input. Without a signature anybody
 * could type a placeholder naming a record they cannot see, and the page would
 * render it for them.
 */

import { MessageVerifier } from "@altair/support";

/** Anything that can be embedded: a model instance, near enough. */
export interface Attachable {
  id: unknown;
  constructor: { name: string };
  [key: string]: unknown;
}

/** What a placeholder carries. */
export interface AttachmentAttributes {
  sgid: string;
  contentType?: string;
  filename?: string;
  filesize?: number;
  width?: number;
  height?: number;
  caption?: string;
}

let verifier: MessageVerifier | undefined;
const classes = new Map<string, { find(id: unknown): Promise<unknown> }>();

/**
 * The secret that signs embedded ids, and the classes they may name.
 *
 * Both are required rather than optional. Without the secret an id cannot be
 * signed; without the list a signed id could name any class in the process,
 * which turns a rich text body into a way to read arbitrary tables.
 */
export function configureAttachables(options: {
  secret: string;
  classes: Record<string, { find(id: unknown): Promise<unknown> }>;
}): void {
  verifier = new MessageVerifier(options.secret);

  classes.clear();
  for (const [name, klass] of Object.entries(options.classes)) classes.set(name, klass);
}

export function resetAttachables(): void {
  verifier = undefined;
  classes.clear();
}

function requireVerifier(): MessageVerifier {
  if (!verifier) {
    throw new Error(
      "Embedded records need a secret to sign their ids. Call configureAttachables({ secret, classes }).",
    );
  }

  return verifier;
}

/**
 * A signed global id for a record. Rails' `to_sgid`.
 *
 * Signed for one purpose, so an id minted for an attachment cannot be spent
 * anywhere else that happens to take a signed id.
 */
export function signedIdFor(record: Attachable): string {
  return requireVerifier().generate(
    { klass: record.constructor.name, id: record.id },
    "attachable",
  );
}

/** The record a signed id names, or null when it names nothing valid. */
export async function fromAttachableSgid(sgid: string): Promise<unknown | null> {
  const claim = requireVerifier().verified<{ klass: string; id: unknown }>(sgid, "attachable");

  if (!claim) return null;

  // Only a class that was registered. A signature proves the id was minted
  // here; it does not prove the class is one an application meant to expose.
  const klass = classes.get(claim.klass);
  if (!klass) return null;

  return await klass.find(claim.id).catch(() => null);
}

/** The placeholder for a record. Rails' `to_attachment`. */
export function fromAttachable(
  record: Attachable,
  extra: Partial<AttachmentAttributes> = {},
): string {
  return attachmentTag({ sgid: signedIdFor(record), ...extra });
}

/** Several at once, in the order given. */
export function fromAttachables(
  records: readonly Attachable[],
  extra: Partial<AttachmentAttributes> = {},
): string {
  return records.map((record) => fromAttachable(record, extra)).join("");
}

/** Builds a placeholder from attributes that already include a signed id. */
export function fromAttributes(attributes: AttachmentAttributes): string {
  return attachmentTag(attributes);
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

function escape(value: string): string {
  return value.replace(/[&<>"]/g, (one) => ESCAPES[one] as string);
}

function attachmentTag(attributes: AttachmentAttributes): string {
  const pairs = Object.entries(attributes)
    .filter(([, value]) => value !== undefined && value !== null)
    // `contentType` is `content-type` in the markup, as the browser spells a
    // data attribute rather than as JavaScript spells a property.
    .map(
      ([key, value]) =>
        ` ${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}="${escape(String(value))}"`,
    )
    .join("");

  return `<action-text-attachment${pairs}></action-text-attachment>`;
}

/** Every placeholder in a body, as its attributes. */
export function attachmentsIn(html: string): AttachmentAttributes[] {
  const found: AttachmentAttributes[] = [];

  for (const match of html.matchAll(/<action-text-attachment\b([^>]*)>/g)) {
    const attributes: Record<string, string> = {};

    for (const pair of (match[1] ?? "").matchAll(/([a-z-]+)="([^"]*)"/g)) {
      const name = (pair[1] as string).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      attributes[name] = (pair[2] as string).replaceAll("&amp;", "&");
    }

    if (attributes.sgid) found.push(attributes as unknown as AttachmentAttributes);
  }

  return found;
}

/** The records a body embeds, in the order they appear. Rails' `attachables`. */
export async function attachablesIn(html: string): Promise<unknown[]> {
  const found = await Promise.all(
    attachmentsIn(html).map((attachment) => fromAttachableSgid(attachment.sgid)),
  );

  // A placeholder naming something that is gone renders as nothing rather than
  // taking the page down: a record can be deleted after the body was written,
  // and that is not the reader's problem.
  return found.filter((one) => one !== null);
}

/**
 * The body with every placeholder replaced by what it stands for.
 *
 * The renderer is the application's: only it knows what a mention of a person
 * or a card for a product should look like.
 */
export async function renderAttachments(
  html: string,
  render: (record: unknown, attachment: AttachmentAttributes) => string | Promise<string>,
): Promise<string> {
  const attachments = attachmentsIn(html);
  let rendered = html;

  for (const attachment of attachments) {
    const record = await fromAttachableSgid(attachment.sgid);
    const replacement = record === null ? "" : await render(record, attachment);

    rendered = rendered.replace(
      new RegExp(
        `<action-text-attachment\\b[^>]*sgid="${escapeRegExp(escape(attachment.sgid))}"[^>]*></action-text-attachment>`,
      ),
      () => replacement,
    );
  }

  return rendered;
}

/** The body as words, with each embedded record described rather than shown. */
export async function toPlainText(
  html: string,
  describe: (record: unknown) => string = () => "[attachment]",
): Promise<string> {
  const withoutAttachments = await renderAttachments(html, async (record) => describe(record));

  return withoutAttachments
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The class Rails puts on a run of attachments so they lay out as a grid.
 *
 * The count is part of it — `attachment-gallery--3` — because the stylesheet
 * needs to know how many are in the row to size them, and CSS cannot count its
 * own children well enough to do it for four different cases.
 */
const GALLERY_CLASS = "attachment-gallery";

/** One attachment element, whole. */
const ATTACHMENT = /<action-text-attachment\b[^>]*><\/action-text-attachment>/g;

/** A gallery wrapper and everything inside it. */
const GALLERY = /<div class="attachment-gallery(?: attachment-gallery--\d+)?">([\s\S]*?)<\/div>/g;

/**
 * Wraps runs of neighbouring attachments in a gallery. Rails' rendering half of
 * `ActionText::Attachment::Gallery`.
 *
 * Two images in a row are a gallery and should lay out side by side; one image
 * is an image. That distinction lives here rather than in the editor because
 * the stored body is the canonical form — plain attachments, no wrapper — and a
 * body written by an API client, a script or an import has no editor to have
 * added one.
 *
 * A run of one is left alone, which is the whole rule.
 */
export function withAttachmentGalleries(html: string): string {
  // Runs of two or more, allowing whitespace between them. Anything else in
  // the gap — a paragraph, text, a heading — ends the run, because those are
  // attachments that happen to be near each other rather than a set.
  const run = /(?:<action-text-attachment\b[^>]*><\/action-text-attachment>\s*){2,}/g;

  return html.replace(run, (match) => {
    const count = (match.match(ATTACHMENT) ?? []).length;
    const trailing = match.slice(match.trimEnd().length);

    return (
      `<div class="${GALLERY_CLASS} ${GALLERY_CLASS}--${count}">${match.trimEnd()}</div>` + trailing
    );
  });
}

/**
 * Takes the gallery wrappers back off. Rails'
 * `fragment_by_canonicalizing_attachment_galleries`.
 *
 * What is stored is the canonical form. Storing the wrapper would freeze one
 * version of the markup into every body ever written — so a change to how a
 * gallery is laid out would reach new content and leave the archive alone,
 * which is the same reason a body is sanitized on the way out rather than in.
 */
export function withoutAttachmentGalleries(html: string): string {
  return html.replace(GALLERY, (_, inner: string) => inner);
}

/** Whether a body carries any gallery wrappers. */
export function hasAttachmentGalleries(html: string): boolean {
  return new RegExp(GALLERY.source).test(html);
}

/**
 * The attachments in each gallery, in order.
 *
 * For a caller that wants to render a gallery itself — a template that lays
 * out two images differently from four.
 */
export function attachmentGalleriesIn(html: string): AttachmentAttributes[][] {
  const galleries: AttachmentAttributes[][] = [];

  for (const match of html.matchAll(new RegExp(GALLERY.source, "g"))) {
    galleries.push(attachmentsIn(match[1] ?? ""));
  }

  return galleries;
}
