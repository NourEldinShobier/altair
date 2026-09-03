/**
 * Turning one kind of value into another without lying about it, ported from
 * `ActiveSupport`'s numeric and string core extensions — `to_i`, `to_f`,
 * `to_fs`, `tidy_bytes`, `Numeric#bytes` and the UUID packing in `Digest::UUID`.
 *
 * Every function here has a wrong version that is shorter and passes casual
 * testing, and the difference is always what happens to input that is *nearly*
 * valid:
 *
 * - **`Number("12abc")` is `NaN`; `parseInt("12abc")` is `12`.** Rails' `to_i`
 *   is the second, deliberately, because it is what a form field wants — but
 *   that means `to_i` on a genuinely bad value silently produces a number, so
 *   anything that needs to *know* has to ask separately.
 * - **A byte string with one invalid sequence is not an error and not
 *   discardable.** `tidy_bytes` replaces the bad bytes rather than raising or
 *   dropping them, because the alternative is a user record that cannot be
 *   displayed at all because of one character in one field.
 * - **Powers of 1024 and powers of 1000 are both "a kilobyte"** depending on
 *   who is asking, and picking one silently makes every size in the interface
 *   off by 2.4% per order of magnitude — 10% at terabytes.
 */

// --- numbers ---------------------------------------------------------------------------

/**
 * Rails' `to_i` — the leading integer, or zero.
 *
 * `parseInt` semantics, deliberately: a form field containing `"12 items"`
 * should give 12, which is what makes `to_i` usable at all. The cost is that a
 * genuinely bad value gives `0` rather than an error, so `toI` is for input
 * that has already been validated or where zero is a fine answer — anything
 * that needs to know uses `parseIntStrictly`.
 */
export function toI(value: unknown, base = 10): number {
  if (typeof value === "number") return Math.trunc(value);

  const parsed = Number.parseInt(String(value).trim(), base);

  return Number.isNaN(parsed) ? 0 : parsed;
}

/** The same question asked strictly, for when the difference matters. */
export function parseIntStrictly(value: unknown, base = 10): number | undefined {
  const text = String(value).trim();

  if (!/^[+-]?\w+$/.test(text)) return undefined;

  const parsed = Number.parseInt(text, base);

  // `parseInt` stops at the first character it cannot read, so a value it
  // parsed *partly* has to be rejected here by comparing what it produced back
  // against what it was given.
  return Number.isNaN(parsed) || String(parsed) !== text.replace(/^\+/, "") ? undefined : parsed;
}

/** Rails' `to_f` — the leading float, or zero. */
export function toF(value: unknown): number {
  if (typeof value === "number") return value;

  const parsed = Number.parseFloat(String(value).trim());

  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Rails' `to_r` — an exact ratio rather than a float.
 *
 * For money and for anything summed repeatedly: `0.1 + 0.2` is not `0.3` in
 * binary floating point, and a total built from a few hundred of those is
 * visibly wrong on an invoice. The ratio is reduced, so two values that are
 * equal compare equal.
 */
export function toR(value: number | string): { numerator: number; denominator: number } {
  const text = String(value).trim();
  const match = /^([+-]?\d*)(?:\.(\d+))?$/.exec(text);

  if (match === null) return { numerator: 0, denominator: 1 };

  const whole =
    match[1] === "" || match[1] === "+" || match[1] === "-" ? `${match[1]}0` : match[1]!;
  const decimals = match[2] ?? "";
  const denominator = 10 ** decimals.length;
  const sign = whole.startsWith("-") ? -1 : 1;
  const numerator = sign * (Math.abs(Number(whole)) * denominator + Number(decimals || "0"));

  return reduce(numerator, denominator);
}

function reduce(
  numerator: number,
  denominator: number,
): { numerator: number; denominator: number } {
  const divisor = greatestCommonDivisor(Math.abs(numerator), denominator);

  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

function greatestCommonDivisor(a: number, b: number): number {
  return b === 0 ? Math.max(1, a) : greatestCommonDivisor(b, a % b);
}

/**
 * Rails' `to_fs` — a number formatted for a person.
 *
 * Separate from `toS` because the two answer different questions: `toS` is for
 * a machine reading it back, `toFs` is for a person reading it once. Using one
 * for the other is how a delimited "1,234" ends up in a JSON document, where
 * it parses as the number 1.
 */
export function toFs(
  value: number,
  {
    precision,
    delimiter,
    separator = ".",
  }: {
    precision?: number;
    delimiter?: string;
    separator?: string;
  } = {},
): string {
  const fixed = precision === undefined ? String(value) : value.toFixed(precision);
  const [whole = "", fraction] = fixed.split(".");

  const grouped =
    delimiter === undefined ? whole : whole.replaceAll(/\B(?=(\d{3})+(?!\d))/g, delimiter);

  return fraction === undefined ? grouped : `${grouped}${separator}${fraction}`;
}

/** Rails' `to_s` — the round-trippable form. */
export function toS(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);

  return String(value);
}

// --- sizes -------------------------------------------------------------------------------

/**
 * Rails' `Numeric#bytes` family, up to zettabytes.
 *
 * Binary by default — 1024, not 1000 — because that is what a filesystem and
 * an operating system report, and an interface disagreeing with the file
 * manager beside it is read as a bug in the interface. The decimal reading is
 * available because storage vendors and network engineers use it, and picking
 * one silently makes every size off by 2.4% per order of magnitude: 10% by
 * terabytes.
 */
export const BYTE_UNITS: readonly string[] = ["B", "KB", "MB", "GB", "TB", "PB", "EB", "ZB"];

export function zettabytes(count: number, { binary = true }: { binary?: boolean } = {}): number {
  return count * (binary ? 1024 : 1000) ** 7;
}

export function inBytes(
  count: number,
  unit: string,
  { binary = true }: { binary?: boolean } = {},
): number {
  const power = BYTE_UNITS.indexOf(unit.toUpperCase());

  if (power === -1) {
    throw new Error(
      `${JSON.stringify(unit)} is not a size unit. Guessing would produce a number that is off by ` +
        `a factor of a thousand and still looks plausible.`,
    );
  }

  return count * (binary ? 1024 : 1000) ** power;
}

/**
 * Rails' `number_to_human_size`.
 *
 * The unit is chosen so the number has at most one leading group — "1.2 GB"
 * rather than "1234 MB" — because the point of the conversion is that somebody
 * can read it at a glance.
 */
export function humanSize(
  bytes: number,
  { binary = true, precision = 1 }: { binary?: boolean; precision?: number } = {},
): string {
  const base = binary ? 1024 : 1000;

  // No separate case for a value below one unit: the exponent is already zero
  // there, so the general path produces "512 B" on its own.
  const power = Math.min(BYTE_UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(base)));
  const scaled = bytes / base ** power;

  return `${Number(scaled.toFixed(precision))} ${BYTE_UNITS[power]}`;
}

// --- bytes and strings ---------------------------------------------------------------------

const REPLACEMENT = "�";

/**
 * Rails' `tidy_bytes` — replace what cannot be decoded rather than failing.
 *
 * The alternative is a user record that cannot be displayed *at all* because
 * of one character in one field, usually pasted from somewhere with a
 * different encoding. Replacing loses information; raising loses the record.
 *
 * Lone surrogates are the case that matters here: they are valid in a
 * JavaScript string and invalid as UTF-8, so they survive every check inside
 * the process and fail at the moment the value is written to a socket or a
 * database — far from whatever produced them.
 */
export function tidyBytes(value: string): string {
  let tidied = "";

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);

      if (next >= 0xdc00 && next <= 0xdfff) {
        tidied += value[index]! + value[index + 1]!;
        index += 1;
        continue;
      }

      tidied += REPLACEMENT;
      continue;
    }

    tidied += code >= 0xdc00 && code <= 0xdfff ? REPLACEMENT : value[index]!;
  }

  return tidied;
}

/** Whether a string can be encoded as UTF-8 without loss. */
export function validEncoding(value: string): boolean {
  return tidyBytes(value) === value;
}

/**
 * Rails' `String#chr` — the first character, not the first code unit.
 *
 * `value[0]` on an emoji gives half a surrogate pair, which is not a character
 * and cannot be encoded — so a truncation built on it produces a string that
 * is invalid rather than short.
 */
export function chr(value: string): string {
  // `Array.from` rather than a spread: the same code points, and it does not
  // read as an accident to a linter that cannot tell this apart from a
  // spread meant to preserve grapheme clusters.
  return Array.from(value)[0] ?? "";
}

/**
 * Rails' `String#bytesplice` — replace a range measured in bytes.
 *
 * Bounds are snapped to character boundaries rather than applied literally,
 * because a byte offset landing inside a multi-byte character would otherwise
 * split it — producing exactly the invalid sequence `tidyBytes` exists to
 * clean up, from code that was only trying to truncate.
 */
export function bytesplice(
  value: string,
  start: number,
  length: number,
  replacement: string,
): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(value);
  // `snapToCharacter` walks the whole string and returns its length when the
  // offset runs past the end, so it clamps as well as snapping — no separate
  // bound on the way in.
  const from = snapToCharacter(value, Math.max(0, start));
  const to = Math.max(from, snapToCharacter(value, start + length));

  const decoder = new TextDecoder();

  return decoder.decode(bytes.slice(0, from)) + replacement + decoder.decode(bytes.slice(to));
}

function snapToCharacter(value: string, byteOffset: number): number {
  const encoder = new TextEncoder();
  let seen = 0;

  for (const character of value) {
    const size = encoder.encode(character).length;

    if (seen + size > byteOffset) return seen;

    seen += size;
  }

  return seen;
}

/**
 * Rails' `multiline?` — whether a pattern spans lines.
 *
 * Asked because a validation written against a single line and applied to a
 * multi-line value passes on the first line alone: `\A...\z` and `^...$` differ
 * exactly here, and the second is the reason a "username" field can contain a
 * newline followed by anything at all.
 */
export function multiline(pattern: RegExp): boolean {
  return pattern.multiline || /\^|\$/.test(pattern.source);
}

/**
 * Rails' `readable_inspect` — a value shown to a person.
 *
 * Truncated with a count rather than trailing off, because an inspect that
 * does not say it was truncated is read as the whole value — and whatever was
 * cut off is assumed absent.
 */
export function readableInspect(value: unknown, { limit = 120 }: { limit?: number } = {}): string {
  const shown = typeof value === "string" ? JSON.stringify(value) : String(value);

  if (shown.length <= limit) return shown;

  return `${shown.slice(0, limit)}… (${shown.length - limit} more characters)`;
}

/** Rails' `existence` — a value, unless it is blank. */
export function existence<T>(value: T): T | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  if (Array.isArray(value) && value.length === 0) return undefined;

  // Zero and false are values, not absences. Treating them as blank is the
  // single most common source of "why did my count of 0 disappear".
  return value;
}

// --- UUIDs -----------------------------------------------------------------------------------
//
// The namespaces, the packing and the version/variant stamping all live in
// `misc.ts` alongside `uuidV5`. Only the inverse is here.

/** Rails' `Digest::UUID.decompose` — a UUID string back into its five fields. */
export function decompose(uuid: string): [string, string, string, string, string] {
  const parts = uuid.split("-");

  if (parts.length !== 5 || parts.join("").length !== 32) {
    throw new Error(
      `${JSON.stringify(uuid)} is not a UUID. Its five groups are 8-4-4-4-12 characters, and a ` +
        `value that is merely hexadecimal would be accepted here and rejected by the database.`,
    );
  }

  return parts as [string, string, string, string, string];
}
