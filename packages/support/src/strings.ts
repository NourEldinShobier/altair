/**
 * The string helpers ActiveSupport hangs off `String`, and the random-token
 * alphabets `SecureRandom` provides.
 *
 * Functions rather than prototype patches, same rule as everywhere else here,
 * and nothing that duplicates a method JavaScript already has: `padStart`,
 * `trimEnd`, `at`, `replaceAll` and friends are absent on purpose.
 */

import { randomBytes } from "node:crypto";

/**
 * Removes the common leading indentation. Rails' `strip_heredoc`.
 *
 * For a template or a SQL fragment written inside indented code, where the
 * indentation belongs to the source file and not to the string. The *smallest*
 * indentation wins, so relative nesting inside the block survives — a dedent
 * that flattened everything would ruin exactly the YAML and Markdown this is
 * usually holding.
 *
 * Blank lines are ignored when measuring, since a line that is only a newline
 * would otherwise report an indentation of zero and defeat the whole thing.
 */
export function stripHeredoc(text: string): string {
  const indents = text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => line.match(/^[ \t]*/)![0].length);

  if (indents.length === 0) return text;

  const smallest = Math.min(...indents);

  return text
    .split("\n")
    .map((line) => line.slice(smallest))
    .join("\n");
}

interface TruncateWordsOptions {
  omission?: string;
  separator?: string | RegExp;
}

/**
 * Keeps the first few words. Rails' `truncate_words`.
 *
 * The difference from truncating by characters is that this one never cuts a
 * word in half, which is what you want for a summary or a meta description.
 * Text already short enough comes back untouched — including the omission
 * marker, which is not appended when nothing was removed.
 */
export function truncateWords(
  text: string,
  count: number,
  { omission = "...", separator = /\s+/ }: TruncateWordsOptions = {},
): string {
  const words = text.split(separator).filter((word) => word.length > 0);

  if (words.length <= count) return text;

  return words.slice(0, count).join(" ") + omission;
}

/**
 * How many bytes the string takes as UTF-8. Rails' `bytesize`.
 *
 * Not `length`, which counts UTF-16 code units. The two disagree on anything
 * outside ASCII, and it is `bytesize` that a database column limit, a header
 * length, and a byte-oriented protocol are all counting.
 */
export function bytesize(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Whether the string is well-formed Unicode. Rails' `is_utf8?`.
 *
 * JavaScript strings can hold a lone surrogate — from a bad slice, a truncated
 * read, or a client that split a message mid-character. Such a string cannot
 * be encoded as UTF-8, so it throws on the way into a database or across a
 * socket. This is the check to make before that happens.
 */
export function isUtf8(text: string): boolean {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

/**
 * Folds accents to their ASCII base. Rails' `transliterate`.
 *
 * `parameterize` already does this on its way to a slug; this exposes it on
 * its own, for the searches and sort keys that want "resume" to match
 * "résumé" without also wanting the rest of a slug's mangling.
 */
export function transliterate(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

/** Everything but these patterns. Rails' `remove`. */
export function remove(text: string, ...patterns: (string | RegExp)[]): string {
  return patterns.reduce<string>(
    (result, pattern) =>
      typeof pattern === "string"
        ? result.replaceAll(pattern, "")
        : result.replace(
            new RegExp(pattern, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`),
            "",
          ),
    text,
  );
}

/**
 * The alphabets `SecureRandom` offers beyond hex and base64.
 *
 * All three avoid the padding and the `+/` of base64, so a token is safe in a
 * URL, in a filename, and in a double-click selection. base58 goes further and
 * drops `0`, `O`, `I` and `l` — the characters people transcribe wrongly —
 * which is why it is the one to reach for if a human ever reads the token
 * aloud or types it back in.
 */
const ALPHABETS = {
  base32: "0123456789abcdefghjkmnpqrstvwxyz",
  base36: "0123456789abcdefghijklmnopqrstuvwxyz",
  base58: "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz",
} as const;

/**
 * Draws from the alphabet without modulo bias.
 *
 * Taking `byte % alphabet.length` would make the first few characters of the
 * alphabet measurably likelier, because 256 does not divide evenly by 58. For
 * a token that guards a session or a password reset that is a real reduction
 * in entropy, so bytes that fall in the ragged tail are discarded and redrawn.
 */
function sample(alphabet: string, length: number): string {
  const limit = Math.floor(256 / alphabet.length) * alphabet.length;
  let result = "";

  while (result.length < length) {
    for (const byte of randomBytes(length)) {
      if (byte >= limit) continue;
      result += alphabet[byte % alphabet.length];
      if (result.length === length) break;
    }
  }

  return result;
}

/** A random token in Douglas Crockford's base32. Rails' `SecureRandom.base32`. */
export function base32(length = 16): string {
  return sample(ALPHABETS.base32, length);
}

/** A random token in base36. Rails' `SecureRandom.base36`. */
export function base36(length = 16): string {
  return sample(ALPHABETS.base36, length);
}

/** A random token in base58. Rails' `SecureRandom.base58`. */
export function base58(length = 16): string {
  return sample(ALPHABETS.base58, length);
}
