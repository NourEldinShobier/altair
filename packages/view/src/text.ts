/**
 * Text helpers that produce markup, ported from ActionView's `TextHelper`.
 *
 * The formatting in these is not the hard part. Every one takes text from
 * somewhere and puts tags around it, and that is an escaping problem wearing a
 * formatting problem's clothes: the text has to be escaped and the tags must
 * not be, and the two are being assembled in the same string.
 *
 * So each of these returns `RawHtml` — already escaped, deliberately — rather
 * than a string the renderer would escape again and show as `&lt;mark&gt;`.
 */

import { RawHtml, escapeHtml } from "./render.js";

export interface SimpleFormatOptions {
  /** Attributes for each paragraph, as an already-safe attribute string. */
  className?: string;
}

/**
 * Turns line breaks into paragraphs, as a textarea's contents want.
 *
 * Rails' `simple_format`. One blank line starts a paragraph; a single line
 * break inside one becomes `<br>`.
 */
export function simpleFormat(text: string, options: SimpleFormatOptions = {}): RawHtml {
  const attributes = options.className ? ` class="${escapeHtml(options.className)}"` : "";

  const paragraphs = String(text)
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    // Escaped here, one paragraph at a time, before any tag goes near it.
    .map((paragraph) => `<p${attributes}>${escapeHtml(paragraph).replaceAll("\n", "<br>")}</p>`);

  return new RawHtml(paragraphs.join(""));
}

export interface HighlightOptions {
  /** The tag put around each match. `mark` by default, as Rails uses. */
  tag?: string;
}

/**
 * Wraps every occurrence of a phrase in a tag. Rails' `highlight`.
 *
 * Both arguments come from outside — the text from a record, the phrase from
 * the search box — so both are escaped, and the search is done on the escaped
 * text so the offsets still line up. Highlighting `<b>` in a document that
 * contains `<b>` finds it and does not emit it.
 */
export function highlight(text: string, phrase: string, options: HighlightOptions = {}): RawHtml {
  const tag = options.tag ?? "mark";
  const escaped = escapeHtml(String(text));
  const needle = escapeHtml(String(phrase));

  if (needle.length === 0) return new RawHtml(escaped);

  // Split rather than replace with a pattern: a phrase is a phrase, and
  // building a RegExp from it would let `.` or `(` from a search box mean
  // something. Splitting on the literal cannot.
  const parts = splitOn(escaped, needle);

  return new RawHtml(parts.join(`<${tag}>${needle}</${tag}>`));
}

/** Case-insensitive split on a literal, keeping the pieces between matches. */
function splitOn(haystack: string, needle: string): string[] {
  const parts: string[] = [];
  const lowerHaystack = haystack.toLowerCase();
  const lowerNeedle = needle.toLowerCase();

  let from = 0;
  for (;;) {
    const at = lowerHaystack.indexOf(lowerNeedle, from);
    if (at === -1) break;

    parts.push(haystack.slice(from, at));
    from = at + needle.length;
  }

  parts.push(haystack.slice(from));

  return parts;
}

export interface ExcerptOptions {
  /** Characters of context either side. Rails' `radius`. */
  radius?: number;
  /** What stands in for the text that was cut. */
  omission?: string;
}

/**
 * A window of text around a phrase. Rails' `excerpt`.
 *
 * Returns the empty string when the phrase is not there, as Rails does — a
 * search result page has nothing to show for a document that does not match.
 */
export function excerpt(text: string, phrase: string, options: ExcerptOptions = {}): string {
  const radius = options.radius ?? 100;
  const omission = options.omission ?? "...";
  const source = String(text);

  const at = source.toLowerCase().indexOf(String(phrase).toLowerCase());
  if (at === -1) return "";

  const from = Math.max(0, at - radius);
  const to = Math.min(source.length, at + String(phrase).length + radius);

  const prefix = from > 0 ? omission : "";
  const suffix = to < source.length ? omission : "";

  return `${prefix}${source.slice(from, to)}${suffix}`;
}

/**
 * Breaks long lines at a width. Rails' `word_wrap`.
 *
 * A word longer than the width is left whole rather than cut: a URL split
 * across two lines is worse than a line that runs over.
 */
export function wordWrap(text: string, width = 80): string {
  return String(text)
    .split("\n")
    .map((line) => wrapLine(line, width))
    .join("\n");
}

function wrapLine(line: string, width: number): string {
  const out: string[] = [];
  let current = "";

  for (const word of line.split(" ")) {
    if (current.length === 0) current = word;
    else if (current.length + 1 + word.length <= width) current += ` ${word}`;
    else {
      out.push(current);
      current = word;
    }
  }

  if (current.length > 0) out.push(current);

  return out.join("\n");
}

/**
 * Formats a phone number. Rails' `number_to_phone`.
 *
 * Only the digits are read, so a number arriving already punctuated comes out
 * punctuated the one way.
 */
export function numberToPhone(
  value: string | number,
  options: {
    areaCode?: boolean;
    delimiter?: string;
    extension?: string | number;
    countryCode?: string | number;
  } = {},
): string {
  const digits = String(value).replaceAll(/\D/g, "");
  if (digits.length === 0) return "";

  const delimiter = options.delimiter ?? "-";

  let formatted: string;
  if (digits.length === 7) {
    formatted = `${digits.slice(0, 3)}${delimiter}${digits.slice(3)}`;
  } else if (options.areaCode) {
    formatted = `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}${delimiter}${digits.slice(6)}`;
  } else {
    const area = digits.slice(0, digits.length - 7);
    const rest = digits.slice(-7);

    formatted = `${area}${area ? delimiter : ""}${rest.slice(0, 3)}${delimiter}${rest.slice(3)}`;
  }

  if (options.countryCode !== undefined)
    formatted = `+${options.countryCode}${delimiter}${formatted}`;
  if (options.extension !== undefined) formatted = `${formatted} x ${options.extension}`;

  return formatted;
}

/**
 * Every tag removed, leaving the text. Rails' `strip_tags`.
 *
 * For a plain-text email, a search index, a meta description — anywhere markup
 * would be shown as markup. Entities are decoded afterwards, because a reader
 * seeing `&amp;` in a subject line is the same bug as seeing `<p>`.
 *
 * Not a sanitizer. This removes tags rather than deciding which are safe, so
 * its output is text and must still be escaped before going back into a page.
 * `sanitize` is the one that keeps markup and makes it safe.
 */
export function stripTags(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

/**
 * Links removed, their text kept. Rails' `strip_links`.
 *
 * The narrow version of stripTags, and the one a comment field usually wants:
 * formatting survives, and the spam link becomes the words it was hiding
 * behind — which is both safer and more informative than deleting it outright,
 * since a moderator can still see what was posted.
 */
export function stripLinks(html: string): string {
  return html.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, "$1");
}
