/**
 * Laying out a plain-text mail body, ported from
 * `ActionMailer::MailHelper` — `block_format`, `format_paragraph` and
 * `word_wrap`.
 *
 *     formatParagraph(text)              // wrapped at 72 columns
 *     blockFormat(text)                  // paragraphs kept, quotes indented
 *
 * The text part of an email is not markup, and that is exactly why it needs
 * this. HTML reflows to whatever width the reader has; plain text does not. An
 * unwrapped paragraph arrives as one very long line, and what happens next
 * depends on the client — some wrap it, some scroll sideways, some truncate,
 * and a few show it as a single unreadable run. Wrapping it at a fixed width
 * before sending is the only way the sender controls how it reads.
 *
 * 72 is the number to use, and the reason is quoting rather than the terminal:
 * every reply prefixes each line with `> `, so a body wrapped at 78 breaks the
 * moment somebody replies twice. 72 leaves room for three levels.
 */

/** The width Rails wraps at, and the one a reply can survive. */
export const DEFAULT_LINE_WIDTH = 72;

export interface WrapOptions {
  /** Columns to wrap at. */
  width?: number;
  /** Put in front of every line — `> ` for a quote, spaces for an indent. */
  prefix?: string;
}

/**
 * Breaks text at a width without breaking words. Rails' `word_wrap`.
 *
 * A word longer than the width is left whole rather than split. Splitting it
 * would break exactly the things that must not be broken — a URL, a token, an
 * order reference — and a line four characters too long is a smaller problem
 * than a link that no longer works when clicked.
 */
export function wordWrap(text: string, options: WrapOptions = {}): string {
  const width = options.width ?? DEFAULT_LINE_WIDTH;
  const prefix = options.prefix ?? "";
  const room = Math.max(1, width - prefix.length);

  // Line by line, so an author's own breaks survive. Reflowing the whole thing
  // would run a list of three items into one paragraph.
  return text
    .split("\n")
    .map((line) => wrapLine(line, room, prefix))
    .join("\n");
}

function wrapLine(line: string, room: number, prefix: string): string {
  if (line.trim() === "") return prefix.trimEnd();

  const words = line.split(/\s+/).filter((word) => word !== "");
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (current === "") {
      current = word;
      continue;
    }

    if (current.length + 1 + word.length <= room) {
      current += ` ${word}`;
      continue;
    }

    lines.push(current);
    current = word;
  }

  if (current !== "") lines.push(current);

  return lines.map((one) => `${prefix}${one}`).join("\n");
}

/**
 * Wraps one paragraph and indents it. Rails' `format_paragraph`.
 *
 * The indent is spaces rather than a tab, because a tab is eight columns in
 * one client and four in another, and the width this wrapped to assumed one of
 * them.
 */
export function formatParagraph(text: string, width = DEFAULT_LINE_WIDTH, indent = 0): string {
  return wordWrap(text.trim(), { width, prefix: " ".repeat(indent) });
}

/**
 * Lays out a whole body. Rails' `block_format`.
 *
 * Paragraphs are wrapped and kept apart; a line already quoted with `>` is
 * indented rather than re-wrapped, since it is somebody else's text and
 * reflowing it silently changes what they appear to have written.
 */
export function blockFormat(text: string, width = DEFAULT_LINE_WIDTH): string {
  const paragraphs = String(text ?? "").split(/\n\s*\n/);

  return paragraphs
    .map((paragraph) => {
      const trimmed = paragraph.trim();

      if (trimmed === "") return "";

      if (isQuoted(trimmed)) return indentQuoted(trimmed);

      return wordWrap(trimmed, { width });
    })
    .filter((paragraph) => paragraph !== "")
    .join("\n\n");
}

/** Whether every line of a block is somebody else's quoted text. */
function isQuoted(paragraph: string): boolean {
  return paragraph.split("\n").every((line) => line.trimStart().startsWith(">"));
}

/** Two spaces in front, which is what Rails' block_format does to a quote. */
function indentQuoted(paragraph: string): string {
  return paragraph
    .split("\n")
    .map((line) => `  ${line.trim()}`)
    .join("\n");
}

/**
 * Prefixes every line for a reply. Rails does this through `block_format`'s
 * quote handling.
 *
 * Blank lines are prefixed too, without the trailing space: a gap with no
 * marker reads as the end of the quotation, and a marker with a space on the
 * end is trailing whitespace every diff and linter complains about.
 */
export function quoteText(text: string, marker = "> "): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? marker.trimEnd() : `${marker}${line}`))
    .join("\n");
}
