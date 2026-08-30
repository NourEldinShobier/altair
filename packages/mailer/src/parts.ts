/**
 * Reading a message as its MIME parts, ported from the `Mail::Message` part
 * accessors Rails tests against.
 *
 * The wire format is the transport's job — Nodemailer and the SES client both
 * build it, and writing a third encoder here would be duplicate work with a
 * third set of bugs. What is missing is the other direction: a way to ask a
 * message what it contains, so a test can say "the HTML part mentions the
 * order number" without reaching into field names and guessing.
 */

import type { Attachment, MessageFields } from "./message.js";

/** One part of a message, as a reader cares about it. */
export interface MessagePart {
  contentType: string;
  body: string;
  /** Set for an attachment part. */
  filename?: string;
  /** Set for an inline attachment, which a body references by cid. */
  cid?: string;
}

/**
 * The parts a message would be encoded as, in the order MIME puts them.
 *
 * Plain text first. That order is not cosmetic: a `multipart/alternative`
 * message is read last-part-first by a client choosing what to show, so the
 * richest version has to be last or every client picks the plain one.
 */
export function messageParts(message: MessageFields): MessagePart[] {
  const parts: MessagePart[] = [];

  if (message.text !== undefined) parts.push({ contentType: "text/plain", body: message.text });
  if (message.html !== undefined) parts.push({ contentType: "text/html", body: message.html });

  for (const attachment of message.attachments ?? []) {
    parts.push({
      contentType: attachment.contentType ?? "application/octet-stream",
      body: bodyOf(attachment),
      filename: attachment.filename,
      cid: (attachment as { cid?: string }).cid,
    });
  }

  return parts;
}

function bodyOf(attachment: Attachment): string {
  const content = (attachment as { content?: unknown }).content;

  if (typeof content === "string") return content;
  if (content instanceof Uint8Array) return Buffer.from(content).toString("base64");

  return "";
}

/** One part by content type, or undefined. Rails' `mail.part`. */
export function messagePart(message: MessageFields, contentType: string): MessagePart | undefined {
  return messageParts(message).find((part) => part.contentType === contentType);
}

/** Whether the message has more than one part. Rails' `multipart?`. */
export function isMultipart(message: MessageFields): boolean {
  return messageParts(message).length > 1;
}

/** The parts that are attachments rather than bodies. */
export function attachmentParts(message: MessageFields): MessagePart[] {
  return messageParts(message).filter((part) => part.filename !== undefined);
}

/**
 * The parts a body would be chosen from. Rails' `body_parts`.
 *
 * Attachments excluded, because a client picking what to display never picks
 * one — and a test asserting on "the body" that matched a PDF would be a
 * confusing failure to read.
 */
export function bodyParts(message: MessageFields): MessagePart[] {
  return messageParts(message).filter((part) => part.filename === undefined);
}

/**
 * The content type the whole message would carry.
 *
 * `multipart/mixed` once anything is attached, `multipart/alternative` for two
 * bodies and no attachment, and the single part's own type otherwise. The
 * distinction matters to clients: `alternative` means "these say the same
 * thing, pick one", and `mixed` means "these are all part of the message".
 */
export function messageContentType(message: MessageFields): string {
  const parts = messageParts(message);

  if (attachmentParts(message).length > 0) return "multipart/mixed";
  if (parts.length > 1) return "multipart/alternative";

  return parts[0]?.contentType ?? "text/plain";
}
