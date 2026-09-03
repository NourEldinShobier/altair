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

/**
 * Characters an XML name may start with, from
 * https://www.w3.org/TR/REC-xml/#NT-Name, plus the `@` and `:` that template
 * frameworks put in front of an attribute.
 */
const NAME_START = String.raw`@:A-Z_a-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD`;

/**
 * The same, plus what may appear after the first character.
 *
 * The `-` leads, where a character class reads it as itself rather than as
 * the start of a range. Escaping it instead works and reads as a mistake to a
 * linter, which cannot see that this string becomes a regular expression.
 */
const NAME_FOLLOWING = `-.0-9\u00B7\u0300-\u036F\u203F-\u2040${NAME_START}`;

const SAFE_NAME = new RegExp(`^[${NAME_START}][${NAME_FOLLOWING}]*$`);
const INVALID_START = new RegExp(`[^${NAME_START}]`, "g");
const INVALID_FOLLOWING = new RegExp(`[^${NAME_FOLLOWING}]`, "g");

/**
 * An attribute or tag name, with anything that is not part of a name replaced
 * by `_`. Rails' `ERB::Util.xml_name_escape`.
 *
 *     xmlNameEscape("1 < 2 & 3")  //=> "1___2___3"
 *
 * Escaping the *value* of an attribute is not enough on its own. A name is
 * written outside the quotes, so a name holding `>` closes the tag and
 * everything after it is markup:
 *
 *     tagOptions({ 'x><script>alert(1)</script': "1" })
 *     //  x><script>alert(1)</script="1"
 *
 * Rails escapes names for this reason and so does this. A name is usually a
 * literal in the source and this does nothing to it — but "usually" is not a
 * security boundary, and a spread of attributes built from a record or a
 * request is the case that is not.
 */
export function xmlNameEscape(name: string): string {
  // A shortcut, not a branch: a name with nothing invalid in it comes out of
  // the replacements unchanged, and almost every name is one.
  if (SAFE_NAME.test(name)) return name;

  // The first character and the rest follow different rules — a digit may
  // follow a name character and may not begin one — so `1a` is `_a`.
  const first = name.slice(0, 1).replace(INVALID_START, "_");

  return first + name.slice(1).replace(INVALID_FOLLOWING, "_");
}
