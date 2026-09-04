/**
 * Attachments inside rich text, ported from `ActionText::Attachment`,
 * `ActionText::Content` and the reflection half of
 * `ActiveStorage::Reflection`.
 *
 * `rich-text.ts` stores the body and `attachables.ts` resolves what an
 * attachment points at. This is the layer between: how an attachment is
 * written into the document, and what has to happen when it comes back out.
 *
 * The whole feature turns on one decision. **A rich text body stores a
 * reference, not a rendering.** The editor produces `<action-text-attachment
 * sgid="...">` with a caption and a thumbnail inside it, and everything inside
 * is *stale the moment it is saved* — a file renamed, a variant regenerated, a
 * blob deleted. So the stored form keeps only the reference and the caption,
 * and the rendering is rebuilt from the record every time the document is
 * displayed.
 *
 * Getting that backwards is a document that renders a thumbnail URL which
 * expired months ago, and the failure is a broken image on a page whose HTML
 * is exactly what was saved.
 */

import { signedIdFor, type Attachable } from "./attachables.js";

// --- what an attachment is in the document ------------------------------------------------

export interface EditorAttachment {
  sgid: string;
  contentType?: string;
  filename?: string;
  caption?: string;
  /** Whatever the editor put inside the tag, which is not stored. */
  presentation?: string;
}

/**
 * Rails' `Attachment.from_attachable` — the tag written into the body.
 *
 * Only the reference and the caption. The editor's own markup — a thumbnail, a
 * filename, a size — is dropped, because all of it is stale the moment it is
 * saved and rebuilding it from the record is the only way a renamed file shows
 * its new name.
 */
export function createElement(attachment: EditorAttachment): string {
  const attributes = [`sgid="${escapeAttribute(attachment.sgid)}"`];

  if (attachment.contentType !== undefined) {
    attributes.push(`content-type="${escapeAttribute(attachment.contentType)}"`);
  }

  if (attachment.caption !== undefined && attachment.caption !== "") {
    attributes.push(`caption="${escapeAttribute(attachment.caption)}"`);
  }

  return `<action-text-attachment ${attributes.join(" ")}></action-text-attachment>`;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Rails' `fragment_by_converting_editor_attachments`.
 *
 * Rewrites the editor's tags into stored ones, dropping their contents. Done
 * on the way *in* rather than on the way out, because the editor's markup is
 * what a user could have edited — and a caption is text they typed, so it is
 * kept and escaped rather than trusted.
 */
export function fragmentByConvertingEditorAttachments(html: string): string {
  return html.replaceAll(
    /<action-text-attachment\b([^>]*)>[\s\S]*?<\/action-text-attachment>/g,
    (_whole, attributes: string) => {
      const parsed = parseAttributes(attributes);
      const sgid = parsed["sgid"];

      // A tag with no reference is not an attachment — it is markup somebody
      // pasted. Dropping it is safer than keeping a tag the renderer will
      // later try to resolve and fail on.
      if (sgid === undefined) return "";

      return createElement({
        sgid,
        ...(parsed["content-type"] === undefined ? {} : { contentType: parsed["content-type"] }),
        ...(parsed["caption"] === undefined ? {} : { caption: parsed["caption"] }),
      });
    },
  );
}

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};

  for (const match of source.matchAll(/([\w-]+)="([^"]*)"/g)) {
    attributes[match[1]!] = unescapeAttribute(match[2]!);
  }

  return attributes;
}

function unescapeAttribute(value: string): string {
  return (
    value
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      // Last, or `&amp;lt;` would decode to `<` rather than to `&lt;`.
      .replaceAll("&amp;", "&")
  );
}

/**
 * Rails' `Content#deconstruct` — the attachments a body refers to.
 *
 * Read out of the stored form rather than tracked alongside it, so the two
 * cannot disagree: a body edited to remove an attachment would otherwise leave
 * a tracked reference that keeps a blob alive forever.
 */
export function deconstruct(html: string): EditorAttachment[] {
  return [...html.matchAll(/<action-text-attachment\b([^>]*)>/g)]
    .map((match) => parseAttributes(match[1]!))
    .filter((attributes) => attributes["sgid"] !== undefined)
    .map((attributes) => ({
      sgid: attributes["sgid"]!,
      ...(attributes["content-type"] === undefined
        ? {}
        : { contentType: attributes["content-type"] }),
      ...(attributes["caption"] === undefined ? {} : { caption: attributes["caption"] }),
    }));
}

/**
 * Rails' `Content#links` — the URLs a body points at.
 *
 * For anything that has to know where a document sends people: a link checker,
 * a moderation queue, a preview. Deduplicated, because a body linking the same
 * page from a heading and a footer is one destination.
 */
export function links(html: string): string[] {
  const found = [...html.matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)].map((match) =>
    unescapeAttribute(match[1]!),
  );

  return [...new Set(found)];
}

/**
 * Rails' `render_in` — how one attachment renders.
 *
 * Rebuilt from the record every time. The stored tag carries a reference and a
 * caption; everything visible comes from the attachable now, which is what
 * makes a renamed file show its new name.
 */
export function renderIn(
  attachment: EditorAttachment,
  resolve: (sgid: string) => Attachable | undefined,
  render: (attachable: Attachable, caption?: string) => string,
): string {
  const attachable = resolve(attachment.sgid);

  if (attachable === undefined) {
    // A reference to something that is gone renders as nothing rather than as
    // a broken image: the document is still readable, and a missing attachment
    // is a fact about the data rather than an error in the page.
    return "";
  }

  return render(attachable, attachment.caption);
}

/**
 * Rails' `action_controller_renderer` — the renderer a body is rendered with.
 *
 * Built once and reused. A renderer carries the view paths and the compiled
 * template cache, so one per rendered body would recompile the attachment
 * partial for every attachment in every document.
 */
let sharedRenderer: unknown;

export function actionControllerRenderer<T>(build: () => T): T {
  sharedRenderer ??= build();

  return sharedRenderer as T;
}

export function resetActionControllerRenderer(): void {
  sharedRenderer = undefined;
}

/** Rails' `fill_in_rich_textarea` — what a system test types into an editor. */
export function fillInRichTextarea(
  locator: string,
  html: string,
): { locator: string; script: string } {
  // Set through the editor's own API rather than by assigning innerHTML: the
  // editor keeps its own document model, and writing to the DOM leaves the two
  // disagreeing — so the value that gets submitted is whatever the model had.
  return {
    locator,
    script: `document.querySelector(${JSON.stringify(locator)}).editor.loadHTML(${JSON.stringify(html)})`,
  };
}

// --- attachments as an association -------------------------------------------------------

export interface AttachmentReflection {
  name: string;
  macro: "hasOneAttached" | "hasManyAttached";
  /** The blob association behind it. */
  blobAssociation: string;
}

const attachmentReflections = new Map<string, AttachmentReflection[]>();

/**
 * Rails' `add_attachment_reflection`.
 *
 * Registered so `reflect_on_attachment` can answer, which is what lets generic
 * code — a serializer, an admin interface, a form builder — treat an
 * attachment like any other association. Without it every such tool needs a
 * special case for attachments, and each one gets it slightly wrong.
 */
export function addAttachmentReflection(modelName: string, reflection: AttachmentReflection): void {
  const held = attachmentReflections.get(modelName);

  if (held === undefined) attachmentReflections.set(modelName, [reflection]);
  else held.push(reflection);
}

export function attachmentReflectionsFor(modelName: string): AttachmentReflection[] {
  return [...(attachmentReflections.get(modelName) ?? [])];
}

export function resetAttachmentReflections(): void {
  attachmentReflections.clear();
}

/**
 * Rails' `url_for_direct_upload` — where a browser uploads to.
 *
 * A one-use URL carrying the checksum. The checksum is the point: without it
 * the storage service accepts whatever bytes arrive, so a request that was
 * truncated in transit stores a corrupt file the application believes is the
 * one it authorised.
 */
export function urlForDirectUpload(
  blob: { key: string; checksum: string; byteSize: number; contentType: string },
  { expiresIn = 300 }: { expiresIn?: number } = {},
): { url: string; headers: Record<string, string>; expiresIn: number } {
  if (blob.checksum === "") {
    throw new Error(
      "A direct upload URL needs the checksum the client computed. Without it the service " +
        "accepts whatever bytes arrive, so a request truncated in transit stores a corrupt file " +
        "the application believes is the one it authorised.",
    );
  }

  return {
    url: `/rails/active_storage/direct_uploads/${encodeURIComponent(blob.key)}`,
    headers: {
      "Content-Type": blob.contentType,
      "Content-MD5": blob.checksum,
      "Content-Length": String(blob.byteSize),
    },
    expiresIn,
  };
}

/**
 * Rails' `mirror_later` — copy a blob to the secondary services, in the
 * background.
 *
 * Later rather than inline, because a mirror is for durability rather than
 * for serving: making the upload wait for every secondary service means a
 * slow one turns into a failed upload, and the file is already safely in the
 * primary.
 */
export function mirrorLater(
  key: string,
  services: readonly string[],
): { key: string; services: string[] } {
  return { key, services: [...services] };
}

/**
 * Rails' `update_metadata` — what analysis learned about a blob.
 *
 * Merged onto what is there rather than replacing it. A second analyser — a
 * video probe after an image probe — knows different things about the same
 * file, and replacing would leave the blob describing only whichever ran last.
 */
export function updateMetadata(
  existing: Record<string, unknown>,
  learned: Record<string, unknown>,
): Record<string, unknown> {
  return { ...existing, ...learned, analyzed: true };
}

/**
 * Rails' `processor` — which variant processor an application uses.
 *
 * Named rather than detected, because the two produce different output for the
 * same transformation — and a variant generated by one and cached under a key
 * that does not mention it is served to somebody expecting the other.
 */
export function processor(configured?: string): string {
  return configured ?? "vips";
}

/**
 * Rails' `iam_client` — whether a service signs URLs through an IAM identity.
 *
 * Worth asking because IAM-signed URLs need a round trip to the signing
 * service, so a page rendering fifty thumbnails makes fifty of them. An
 * application that can use a static credential should, and one that cannot has
 * to know it is paying.
 */
export function iamClient(config: { credentials?: unknown; iamRole?: string }): boolean {
  return config.credentials === undefined && config.iamRole !== undefined;
}

/** The signed reference an attachment stores. */
export function attachmentSgid(record: Attachable): string {
  return signedIdFor(record);
}
