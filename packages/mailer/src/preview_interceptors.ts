/**
 * Rules that run only when a message is being looked at rather than sent,
 * ported from `ActionMailer::Preview` and
 * `ActionMailer::InlinePreviewInterceptor`.
 *
 * A delivery interceptor changes what people receive. These change only what
 * the preview page shows, which is why they are a separate list: the two want
 * opposite things often enough that sharing one list would mean every rule
 * carrying an `if previewing` of its own.
 *
 * The default one is the clearest case. An HTML mail that carries its own
 * images references them as `<img src="cid:logo">`, which is right — a `cid:`
 * reference resolves against the message's own attachments, needs no hosting,
 * and is not blocked the way a remote image is. A browser has no idea what
 * `cid:` means, so the preview shows broken images and the person checking the
 * mail cannot tell a missing image from a working one. Rewriting `cid:` to a
 * `data:` URL for the preview fixes that without touching the message anybody
 * receives.
 */

import type { Attachment, MessageFields } from "./message.js";

/** Something that adjusts a message for display. Rails' preview interceptor. */
export interface PreviewInterceptor {
  previewingEmail(message: MessageFields): MessageFields | void | Promise<MessageFields | void>;
}

/**
 * Rewrites `cid:` image sources to `data:` URLs. Rails'
 * `InlinePreviewInterceptor`.
 *
 * Registered by default, and removable — `unregisterPreviewInterceptor` takes
 * it back out for anyone who would rather see the raw markup.
 */
export const inlinePreviewInterceptor: PreviewInterceptor = {
  previewingEmail(message: MessageFields): MessageFields {
    return inlineCidImages(message);
  },
};

const DEFAULTS: PreviewInterceptor[] = [inlinePreviewInterceptor];

let interceptors: PreviewInterceptor[] = [...DEFAULTS];

/** The rules a preview currently runs through, in order. */
export function previewInterceptors(): readonly PreviewInterceptor[] {
  return interceptors;
}

/**
 * Adds one. Rails' `register_preview_interceptor`.
 *
 * Registering the same one twice is a no-op, as in Rails: an initializer that
 * runs twice under a reload would otherwise inline every image twice and
 * double the size of the preview each time.
 */
export function registerPreviewInterceptor(interceptor: PreviewInterceptor): void {
  if (!interceptors.includes(interceptor)) interceptors.push(interceptor);
}

/** Adds several. Rails' `register_preview_interceptors`. */
export function registerPreviewInterceptors(...list: PreviewInterceptor[]): void {
  for (const one of list) registerPreviewInterceptor(one);
}

/** Removes one. Rails' `unregister_preview_interceptor`. */
export function unregisterPreviewInterceptor(interceptor: PreviewInterceptor): void {
  interceptors = interceptors.filter((one) => one !== interceptor);
}

/** Removes several. Rails' `unregister_preview_interceptors`. */
export function unregisterPreviewInterceptors(...list: PreviewInterceptor[]): void {
  for (const one of list) unregisterPreviewInterceptor(one);
}

/** Puts the list back to the default, for a test that changed it. */
export function resetPreviewInterceptors(): void {
  interceptors = [...DEFAULTS];
}

/**
 * Runs every registered rule over a message about to be shown.
 *
 * Each may return a new message or change the one it was given, so a rule that
 * only wants to add a header need not rebuild the whole thing.
 */
export async function informPreviewInterceptors(message: MessageFields): Promise<MessageFields> {
  let current = message;

  for (const interceptor of interceptors) {
    current = (await interceptor.previewingEmail(current)) ?? current;
  }

  return current;
}

/** `src="cid:x"` and `src='cid:x'`, which is what a mailer template writes. */
const CID_SOURCE = /src=(["'])cid:([^"']+)\1/gi;

function attachmentCid(attachment: Attachment): string | undefined {
  return (attachment as { cid?: string }).cid;
}

function base64Of(content: string | Uint8Array): string {
  if (typeof content === "string") return Buffer.from(content, "utf8").toString("base64");

  return Buffer.from(content).toString("base64");
}

/**
 * The message with its `cid:` image sources replaced by `data:` URLs.
 *
 * A reference with no matching attachment is left alone rather than blanked:
 * a broken image in the preview is then a broken image in the mail, which is
 * what the person previewing needs to be told.
 */
export function inlineCidImages(message: MessageFields): MessageFields {
  if (message.html === undefined) return message;

  const attachments = message.attachments ?? [];

  if (attachments.length === 0) return message;

  const html = message.html.replace(CID_SOURCE, (match, quote: string, cid: string) => {
    const found = attachments.find((attachment) => attachmentCid(attachment) === cid);

    if (found === undefined) return match;

    const type = found.contentType ?? "application/octet-stream";

    return `src=${quote}data:${type};base64,${base64Of(found.content)}${quote}`;
  });

  // A fresh object rather than an assignment, so previewing a message twice
  // starts from the same markup both times and a caller that kept a reference
  // still holds the message as the mailer built it.
  return { ...message, html };
}
