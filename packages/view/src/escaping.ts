/**
 * The escaping helpers beyond plain `escapeHtml`.
 *
 * Rails has four of these and they are not interchangeable, which is the
 * reason for the file: reaching for the wrong one is how a template ends up
 * either double-escaping its own copy or opening a hole in a `<script>` tag.
 */

import { escapeHtml, raw, type RawHtml } from "./render.js";

/**
 * Escapes, but leaves an existing entity alone. Rails' `html_escape_once`.
 *
 * The problem it solves: text that has already been through an escaper. Plain
 * escaping turns `&amp;` into `&amp;amp;`, and the reader sees the entity
 * spelled out on the page. This one recognises a well-formed entity —
 * `&amp;`, `&#39;`, `&#x27;` — and passes it through untouched.
 *
 * Only for text that is *known* to be partly escaped already. On genuinely
 * untrusted input, prefer `escapeHtml`: a bare `&` typed by a person is safe
 * either way, but leaving entities intact is a decision that needs a reason.
 */
export function htmlEscapeOnce(value: string): string {
  return value.replace(/[&<>"']/g, (character, offset: number) => {
    if (character === "&" && /^&(#\d+|#[xX][0-9a-fA-F]+|\w+);/.test(value.slice(offset))) {
      return "&";
    }

    return escapeHtml(character);
  });
}

/**
 * Escapes JSON for embedding inside a `<script>` tag. Rails' `json_escape`.
 *
 * `JSON.stringify` is not enough on its own. The string `</script>` survives
 * it intact, so a value carrying that closes the tag early and everything
 * after it is parsed as markup — the classic way a JSON blob in a template
 * becomes script injection. Escaping the four characters that can start a tag
 * or a comment leaves the JSON semantically identical, since `<` and `<`
 * parse to the same string.
 */
const JSON_ESCAPES: Record<string, string> = {
  "<": "\\u003c",
  ">": "\\u003e",
  "&": "\\u0026",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

export function jsonEscape(json: string): string {
  return json.replace(/[<>&\u2028\u2029]/g, (character) => JSON_ESCAPES[character]!);
}

/**
 * Joins parts into safe HTML, escaping the ones that are not already safe.
 * Rails' `safe_join`.
 *
 * `parts.join("")` on a mix of strings and `RawHtml` stringifies the raw ones
 * through `toString` and escapes nothing, so the plain strings go out
 * unescaped. This escapes each part on its own terms and only then joins,
 * which is the order that matters.
 */
export function safeJoin(parts: (string | RawHtml)[], separator: string | RawHtml = ""): RawHtml {
  const escaped = parts.map((part) => (typeof part === "string" ? escapeHtml(part) : part.value));
  const between = typeof separator === "string" ? escapeHtml(separator) : separator.value;

  return raw(escaped.join(between));
}
