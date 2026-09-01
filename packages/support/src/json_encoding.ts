/**
 * Turning a value into JSON, and keeping out of it what should not be there —
 * ported from `ActiveSupport::JSON::Encoding` and the compiled half of
 * `ActiveSupport::ParameterFilter`.
 *
 * `filter.ts` owns the filter itself and `hash.ts` the key transforms. This is
 * the encoder around them, and two of its decisions are the kind that look
 * like paranoia until the failure happens.
 *
 * **A JSON document embedded in HTML is not the same document.** `</script>`
 * inside a string ends the script tag, whatever the JSON says — so a comment
 * body containing it turns the rest of the page into markup the browser
 * executes. Escaping the three characters that can do it costs nothing and is
 * off by default in every JSON library, because a library does not know where
 * its output is going.
 *
 * **A filter list is compiled once and reused.** Building a matcher per
 * parameter turns filtering from a fixed cost into one proportional to the
 * product of the parameters and the patterns — and the parameters are
 * user-controlled, so a request with a thousand of them is a request that
 * costs a thousand times as much to log.
 */

// --- escaping for a page ------------------------------------------------------------------

/**
 * The characters that change meaning inside a `<script>` block.
 *
 * `<` and `>` for the tag; `&` because an HTML entity inside the JSON would
 * otherwise be decoded by the parser before the script ran, so `&lt;` in a
 * string becomes a real `<`.
 */
const HTML_ESCAPE: Readonly<Record<string, string>> = {
  "<": "\\u003c",
  ">": "\\u003e",
  "&": "\\u0026",
};

/**
 * Rails' `escape_html_entities_in_json`.
 *
 * Applied to the *encoded* string rather than to the values, because the
 * characters have to be escaped wherever they appear — inside a key, inside a
 * string, inside nested markup — and walking the value would have to know
 * which of those it was in.
 */
export function htmlEscape(json: string): string {
  return json.replaceAll(/[<>&]/g, (character) => HTML_ESCAPE[character] ?? character);
}

/**
 * Rails' `encode_without_escape` — the document as it is.
 *
 * For anything not going into a page: an API response, a job argument, a file.
 * Escaping there is not wrong and is noise — `<` in a stored document is
 * something every later reader has to decode.
 */
export function encodeWithoutEscape(
  value: unknown,
  replacer?: (key: string, value: unknown) => unknown,
): string {
  return JSON.stringify(value, replacer);
}

export interface JsonOptions {
  only?: readonly string[];
  except?: readonly string[];
  /** Escape the characters that would end a script block. */
  escapeHtml?: boolean;
  /** How many fractional digits a time keeps. */
  timePrecision?: number;
}

/**
 * Rails' `encode_without_options` — the encoder with nothing configured.
 *
 * Separate from the configured form because the options are the expensive
 * part: `only` and `except` walk the value, and most documents have neither.
 */
export function encodeWithoutOptions(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Rails' `ActiveSupport::JSON.encode`.
 *
 * `only` wins over `except` rather than intersecting, the same rule
 * serialization uses elsewhere: intersecting silently produces fewer fields
 * than either asked for, and the caller sees a document missing one with
 * nothing to explain it.
 */
export function jsonEncoder(options: JsonOptions = {}): (value: unknown) => string {
  const { only, except, escapeHtml = false, timePrecision = 3 } = options;

  return (value) => {
    const prepared = asJson(value, {
      ...(only === undefined ? {} : { only }),
      ...(except === undefined ? {} : { except }),
      timePrecision,
    });
    const encoded = JSON.stringify(prepared);

    return escapeHtml ? htmlEscape(encoded) : encoded;
  };
}

/**
 * Rails' `as_json` — a value reduced to what JSON can hold.
 *
 * A `Date` becomes an ISO string at the configured precision. Left to
 * `JSON.stringify` it would be milliseconds always, so a column stored at
 * second precision round-trips with three zeros that were never in the
 * database — and a document compared against another built elsewhere differs
 * for a reason nobody can see.
 */
export function asJson(value: unknown, options: JsonOptions = {}): unknown {
  const { only, except, timePrecision = 3 } = options;

  if (value instanceof Date) return formatTime(value, timePrecision);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((each) => asJson(each, { timePrecision }));

  const entries = Object.entries(value as Record<string, unknown>).filter(([key]) => {
    if (only !== undefined) return only.includes(key);
    if (except !== undefined) return !except.includes(key);

    return true;
  });

  return Object.fromEntries(entries.map(([key, each]) => [key, asJson(each, { timePrecision })]));
}

function formatTime(value: Date, precision: number): string {
  const iso = value.toISOString();

  if (precision >= 3) return iso;

  // Cut rather than round: rounding can move a timestamp forward past the
  // moment it describes, and a record whose stored time is after its own
  // creation breaks any ordering that relies on it.
  const cut = precision <= 0 ? iso.slice(0, 19) : iso.slice(0, 20 + precision);

  return `${cut}Z`;
}

// --- keeping secrets out ------------------------------------------------------------------

export interface CompiledFilter {
  patterns: RegExp[];
  /** Keys matched exactly, which is the common case and the fast one. */
  exact: Set<string>;
}

/**
 * Rails' `precompile_filters`.
 *
 * Built once. A matcher per parameter turns filtering from a fixed cost into
 * one proportional to parameters times patterns — and the parameters are
 * user-controlled, so a request with a thousand of them costs a thousand times
 * as much to log.
 *
 * Plain strings go into a set rather than a pattern, because an exact lookup
 * is constant time and most filters are plain strings.
 */
export function precompileFilters(filters: readonly (string | RegExp)[]): CompiledFilter {
  const patterns: RegExp[] = [];
  const exact = new Set<string>();

  for (const filter of filters) {
    if (typeof filter !== "string") {
      patterns.push(filter);
      continue;
    }

    exact.add(filter.toLowerCase());
    // A plain string still matches as a substring, which is what makes
    // `password` cover `password_confirmation` — the set is the fast path, not
    // the only one.
    patterns.push(new RegExp(escapeRegExp(filter), "i"));
  }

  return { patterns, exact };
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Rails' `filter_param?` — whether one parameter is hidden.
 *
 * The exact set is tried first because it answers most calls without running a
 * pattern at all.
 */
export function filterParam(name: string, compiled: CompiledFilter): boolean {
  if (compiled.exact.has(name.toLowerCase())) return true;

  return compiled.patterns.some((pattern) => pattern.test(name));
}

let payloadFilter: CompiledFilter | undefined;

/**
 * Rails' `reload_payload_filter` — rebuild after configuration changes.
 *
 * Explicit rather than automatic, because the compiled form is what makes
 * filtering cheap and rebuilding it on every read would undo that. The cost of
 * an explicit call is that somebody can forget it; the cost of the alternative
 * is paid on every log line.
 */
export function reloadPayloadFilter(filters: readonly (string | RegExp)[]): CompiledFilter {
  payloadFilter = precompileFilters(filters);

  return payloadFilter;
}

export function currentPayloadFilter(): CompiledFilter | undefined {
  return payloadFilter;
}

export function resetPayloadFilter(): void {
  payloadFilter = undefined;
}

/**
 * Rails' `safe_record` — a record's attributes with the filtered ones replaced.
 *
 * Replaced rather than removed, so a reader can see the attribute exists and
 * was withheld. An omitted one reads as an attribute the record does not have,
 * which sends somebody looking for a migration.
 */
export function safeRecord(
  attributes: Record<string, unknown>,
  compiled: CompiledFilter,
  placeholder = "[FILTERED]",
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(attributes).map(([name, value]) => [
      name,
      filterParam(name, compiled) ? placeholder : value,
    ]),
  );
}

// --- option hashes -------------------------------------------------------------------------

/**
 * Rails' `extractable_options?`.
 *
 * Whether a trailing argument is an options hash rather than a value. Asked
 * explicitly, because a method taking `(*args, **options)` cannot otherwise
 * tell `find(1, 2)` from `find(1, limit: 2)` — and guessing turns a positional
 * argument into an option that is silently ignored.
 */
export function extractableOptions(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;

  // A plain object only, decided by the prototype — which covers arrays,
  // dates, maps and every model instance in one test rather than a list of
  // types somebody has to remember to extend. A model instance is an object
  // and is never options, and treating one as options would drop it from the
  // arguments entirely.
  const prototype = Object.getPrototypeOf(value) as object | null;

  return prototype === null || prototype === Object.prototype;
}

/**
 * Rails' `to_options` — a value coerced into an options hash.
 *
 * A copy, because options are routinely mutated by whatever receives them —
 * defaults merged in, keys deleted after being read — and doing that to the
 * caller's object changes a value it still holds.
 */
export function toOptions(value: unknown): Record<string, unknown> {
  return extractableOptions(value) ? { ...(value as Record<string, unknown>) } : {};
}

/**
 * Rails' `dup_value` — a copy deep enough that editing it is safe.
 *
 * One level for a plain object or array, which is what an options hash needs:
 * a deeper copy would clone whatever a caller put inside, including a model or
 * a connection, and a cloned connection is a connection nothing will close.
 */
export function dupValue<T>(value: T): T {
  if (Array.isArray(value)) return [...value] as unknown as T;

  if (extractableOptions(value)) return { ...(value as object) } as T;

  return value;
}

/**
 * Rails' `convert` — one nested value on its way into an options hash.
 *
 * Nested plain objects are converted too, so `options[:a][:b]` behaves the
 * same at every depth. Anything else is left as it is, because converting a
 * model or a date would replace it with a shape that merely resembles it.
 */
export function convert(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((each) => convert(each));

  if (!extractableOptions(value)) return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, each]) => [key, convert(each)]),
  );
}

/**
 * Rails' `reopen` — merge new options over existing ones without losing either.
 *
 * Nested objects merge rather than replace, which is the difference from a
 * plain spread: `{ a: { b: 1 } }` reopened with `{ a: { c: 2 } }` keeps both,
 * where a spread would drop `b` — and dropping it is silent, because the
 * result is still an object with an `a`.
 */
export function reopen(
  base: Record<string, unknown>,
  added: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(added)) {
    const existing = merged[key];

    merged[key] =
      extractableOptions(existing) && extractableOptions(value)
        ? reopen(existing as Record<string, unknown>, value as Record<string, unknown>)
        : value;
  }

  return merged;
}
