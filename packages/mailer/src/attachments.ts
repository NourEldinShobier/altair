/**
 * Attachments, ported from `ActionMailer`'s `attachments[]`.
 *
 * Rails writes `attachments["invoice.pdf"] = File.read(path)` and works out the
 * content type from the name. The same here, with one addition worth having:
 * an inline attachment carries a content id, which is what lets an HTML body
 * reference an image the message itself is carrying rather than a URL the
 * reader's client has to fetch — and which most clients block by default.
 */

import type { Attachment } from "./message.js";

export interface InlineAttachment extends Attachment {
  /** What `<img src="cid:...">` refers to. */
  cid: string;
  /** Tells the client to show it in the body rather than list it. */
  contentDisposition: "inline";
}

/**
 * The content type for a filename.
 *
 * Bun already carries the table, so there is no list of extensions to keep up
 * to date here.
 */
export function contentTypeFor(filename: string): string {
  const type = Bun.file(filename).type;
  return type.split(";")[0] ?? "application/octet-stream";
}

/** Attaches bytes already in hand. */
export function attachData(
  filename: string,
  content: string | Uint8Array,
  contentType?: string,
): Attachment {
  return { filename, content, contentType: contentType ?? contentTypeFor(filename) };
}

/**
 * Attaches a file from disk.
 *
 * Read now rather than at delivery: a message put on a queue is delivered by
 * another process, possibly on another machine, where the path may mean
 * nothing.
 */
export async function attachFile(path: string, options: { as?: string } = {}): Promise<Attachment> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`No file to attach at ${path}.`);

  const filename = options.as ?? path.split(/[\\/]/).pop()!;

  return {
    filename,
    content: new Uint8Array(await file.arrayBuffer()),
    contentType: file.type.split(";")[0] || contentTypeFor(filename),
  };
}

/**
 * An attachment the body can point at with `cid:`.
 *
 * The alternative is hosting the image and letting the client fetch it, which
 * most clients refuse to do without the reader asking — so an inline
 * attachment is the difference between a message that looks right on arrival
 * and one that looks broken.
 */
export function attachInline(
  filename: string,
  content: string | Uint8Array,
  options: { cid?: string; contentType?: string } = {},
): InlineAttachment {
  return {
    filename,
    content,
    contentType: options.contentType ?? contentTypeFor(filename),
    cid: options.cid ?? generateCid(filename),
    contentDisposition: "inline",
  };
}

/**
 * A content id that will not collide with another message's.
 *
 * The domain part is required by the specification and is not resolved by
 * anything, so a fixed one is correct and expected.
 */
export function generateCid(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, "").replaceAll(/[^\w-]/g, "");
  const unique = crypto.randomUUID().split("-")[0];

  return `${stem || "attachment"}.${unique}@altair`;
}

/** What an inline attachment is referenced as from an HTML body. */
export function cidUrl(attachment: InlineAttachment): string {
  return `cid:${attachment.cid}`;
}

/** Total size of a message's attachments, for a limit worth checking early. */
export function attachmentsSize(attachments: readonly Attachment[]): number {
  return attachments.reduce((total, attachment) => {
    const { content } = attachment;
    return total + (typeof content === "string" ? Buffer.byteLength(content) : content.byteLength);
  }, 0);
}

/** What most providers refuse above, so the check is worth making here. */
export const DEFAULT_ATTACHMENT_LIMIT = 25 * 1024 * 1024;

export class AttachmentsTooLarge extends Error {
  constructor(size: number, limit: number) {
    super(
      `Attachments total ${Math.round(size / 1024 / 1024)}MB, over the ${Math.round(limit / 1024 / 1024)}MB limit. ` +
        `Most providers refuse the message rather than truncating it.`,
    );
    this.name = "AttachmentsTooLarge";
  }
}

/** Refuses a message the provider would refuse, before it is queued. */
export function checkAttachments(
  attachments: readonly Attachment[],
  limit = DEFAULT_ATTACHMENT_LIMIT,
): void {
  const size = attachmentsSize(attachments);
  if (size > limit) throw new AttachmentsTooLarge(size, limit);
}
