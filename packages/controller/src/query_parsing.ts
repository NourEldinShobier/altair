/**
 * Turning a query string or form body into parameters, ported from
 * `ActionDispatch::Request::Utils`, `Rack::Utils.parse_nested_query` and
 * `ActionDispatch::Http::Parameters`.
 *
 * `nested_params.ts` builds the nested object once the pairs are known. This is
 * the step before it — splitting the string — and it is the step where the
 * input is entirely under the sender's control, so every rule here is a limit
 * rather than a feature:
 *
 * **Depth.** `a[b][c][d]…` nested a thousand deep builds a thousand objects and
 * recurses a thousand times, from a request that costs the sender nothing to
 * write. Rack caps it, and so does this, because the alternative is a stack
 * overflow that takes the process with it.
 *
 * **Count.** Ten thousand parameters in one body is ten thousand string
 * operations and ten thousand keys in a hash. The cap is what makes the cost of
 * parsing proportional to something the server chose.
 *
 * **Encoding.** A parameter that is not valid UTF-8 reaches the application as
 * a string nothing can safely compare, log or store — and a database will
 * usually refuse it far away from here. Rejecting at the boundary is the only
 * place the error can name the parameter.
 *
 * None of these is a theoretical concern: all three are how a single request
 * takes a process down or gets a malformed value into a table.
 */

/** Rails' `Rack::Utils.param_depth_limit`. */
export const DEFAULT_DEPTH_LIMIT = 32;

/** Rails' `Rack::Utils.key_space_limit` equivalent. */
export const DEFAULT_PARAM_LIMIT = 4096;

export interface ParseOptions {
  depthLimit?: number;
  paramLimit?: number;
  /**
   * Rails' `strict_query_string_separator`. `&` only by default: `;` as a
   * separator was removed from the URL spec, and honouring it lets one request
   * be read as two different parameter sets by two different parsers.
   */
  separator?: RegExp;
}

export class ParamsTooDeep extends Error {
  constructor(key: string, limit: number) {
    super(
      `The parameter ${JSON.stringify(key)} nests deeper than ${limit}. A request can ask for ` +
        `arbitrary depth in a few bytes, and building it costs a stack frame per level — so the ` +
        `limit is what stops one request ending the process.`,
    );
    this.name = "ParamsTooDeep";
  }
}

export class TooManyParams extends Error {
  constructor(limit: number) {
    super(
      `More than ${limit} parameters in one request. The cost of parsing has to be proportional ` +
        `to something the server chose rather than to what the sender typed.`,
    );
    this.name = "TooManyParams";
  }
}

export class InvalidParameterEncoding extends Error {
  constructor(key: string) {
    super(
      `The parameter ${JSON.stringify(key)} is not valid UTF-8. Passed on, it reaches the ` +
        `application as a string nothing can safely compare, log or store, and the database ` +
        `usually refuses it somewhere that cannot say which parameter it was.`,
    );
    this.name = "InvalidParameterEncoding";
  }
}

/** Rails' `strict_query_string_separator` — the default, and the loose one. */
export const STRICT_SEPARATOR = /&/;
export const LEGACY_SEPARATOR = /[&;]/;

/**
 * How deep a bracketed key goes. Rails' depth check in `parse_nested_query`.
 *
 * Counted from the brackets rather than by recursing, so the limit can be
 * enforced *before* anything is built — checking on the way down would already
 * have allocated the objects the limit exists to prevent.
 */
export function keyDepth(key: string): number {
  return (key.match(/\[/g) ?? []).length + 1;
}

/** Rails' `check_param_depth`. */
export function checkParamDepth(key: string, limit = DEFAULT_DEPTH_LIMIT): void {
  if (keyDepth(key) > limit) throw new ParamsTooDeep(key, limit);
}

/**
 * Whether a decoded string is usable. Rails' `check_param_encoding`.
 *
 * `decodeURIComponent` throws on a malformed escape, and a lone surrogate
 * survives decoding but cannot be encoded again — both are values that look
 * like strings and are not.
 */
export function checkParamEncoding(key: string, value: string): string {
  // A lone surrogate round-trips through nothing: JSON, a database driver and
  // a log formatter each fail on it somewhere further away than here.
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)) {
    throw new InvalidParameterEncoding(key);
  }

  return value;
}

/**
 * Rails' `set_binary_encoding` — parameters that must not be decoded as text.
 *
 * A file upload's body is bytes. Decoding it as UTF-8 corrupts anything that
 * is not text, and the corruption is silent: the upload succeeds and the file
 * is broken.
 */
export function skipParameterEncoding(
  controller: string,
  action: string,
  declared: ReadonlySet<string>,
): boolean {
  return declared.has(`${controller}#${action}`);
}

/** Rails' `param_encoding` registry. */
const binaryActions = new Set<string>();

export function paramEncoding(controller: string, action: string): "binary" | "utf-8" {
  return binaryActions.has(`${controller}#${action}`) ? "binary" : "utf-8";
}

export function setBinaryEncoding(controller: string, action: string): void {
  binaryActions.add(`${controller}#${action}`);
}

export function clearParamEncodings(): void {
  binaryActions.clear();
}

/**
 * Splits a query string into pairs. Rails' `parse_query`.
 *
 * Decoding failures become the raw text rather than an exception, because a
 * malformed escape is a bad request, not a crash — and a 400 naming the
 * parameter is more useful than a stack trace. The *encoding* check is separate
 * and does throw, because an unusable string passed on is worse than a refusal.
 */
export function fromQueryString(
  query: string,
  {
    depthLimit = DEFAULT_DEPTH_LIMIT,
    paramLimit = DEFAULT_PARAM_LIMIT,
    separator = STRICT_SEPARATOR,
  }: ParseOptions = {},
): [string, string][] {
  const trimmed = query.replace(/^[?]/, "");

  if (trimmed === "") return [];

  const parts = trimmed.split(new RegExp(separator.source, "g"));

  if (parts.length > paramLimit) throw new TooManyParams(paramLimit);

  const pairs: [string, string][] = [];

  for (const part of parts) {
    if (part === "") continue;

    const split = part.indexOf("=");
    const rawKey = split === -1 ? part : part.slice(0, split);
    const rawValue = split === -1 ? "" : part.slice(split + 1);

    const key = decodeComponent(rawKey);

    checkParamDepth(key, depthLimit);

    pairs.push([key, checkParamEncoding(key, decodeComponent(rawValue))]);
  }

  return pairs;
}

function decodeComponent(value: string): string {
  const plus = value.replaceAll("+", " ");

  try {
    return decodeURIComponent(plus);
  } catch {
    // A malformed escape is a bad request, not a crash. Keeping the raw text
    // means the value will not match anything and the request ends as the 400
    // it is.
    return plus;
  }
}

/** Rails' `from_pairs` — the same, from pairs somebody else split. */
export function fromPairs(
  pairs: Iterable<readonly [string, string]>,
  { depthLimit = DEFAULT_DEPTH_LIMIT, paramLimit = DEFAULT_PARAM_LIMIT }: ParseOptions = {},
): [string, string][] {
  const out: [string, string][] = [];

  for (const [key, value] of pairs) {
    if (out.length >= paramLimit) throw new TooManyParams(paramLimit);

    checkParamDepth(key, depthLimit);
    out.push([key, checkParamEncoding(key, value)]);
  }

  return out;
}

/** Rails' `from_hash`. */
export function fromHash(
  hash: Record<string, unknown>,
  options: ParseOptions = {},
): [string, string][] {
  return fromPairs(
    Object.entries(hash).map(([key, value]) => [key, String(value)] as const),
    options,
  );
}

/** The names present, without their values. Rails' `query_parameter_names`. */
export function queryParameterNames(query: string, options: ParseOptions = {}): string[] {
  return [...new Set(fromQueryString(query, options).map(([key]) => key))];
}

// --- walking what came out -------------------------------------------------

/** Rails' `each_pair`. */
export function eachPair(
  params: Record<string, unknown>,
  visit: (key: string, value: unknown) => void,
): void {
  for (const [key, value] of Object.entries(params)) visit(key, value);
}

/**
 * Every scalar in a nested structure. Rails' `each_value` / `each_param_value`.
 *
 * Depth first through objects and arrays, because a filter or an encoding
 * check that only looked at the top level would miss
 * `user[profile][bio]` — which is where the interesting values usually are.
 */
export function eachParamValue(
  value: unknown,
  visit: (value: unknown, path: string[]) => void,
  path: string[] = [],
): void {
  if (Array.isArray(value)) {
    value.forEach((each, index) => eachParamValue(each, visit, [...path, String(index)]));

    return;
  }

  if (typeof value === "object" && value !== null) {
    for (const [key, each] of Object.entries(value)) eachParamValue(each, visit, [...path, key]);

    return;
  }

  visit(value, path);
}

/**
 * Rails' `rewrite_param_values` — replace every scalar, keeping the shape.
 *
 * The shape has to survive, because a filter that flattened `user[roles][]`
 * into a string would change what the application sees as well as what the log
 * shows.
 */
export function rewriteParamValues(
  value: unknown,
  rewrite: (value: unknown, path: string[]) => unknown,
  path: string[] = [],
): unknown {
  if (Array.isArray(value)) {
    return value.map((each, index) => rewriteParamValues(each, rewrite, [...path, String(index)]));
  }

  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, each]) => [
        key,
        rewriteParamValues(each, rewrite, [...path, key]),
      ]),
    );
  }

  return rewrite(value, path);
}

/**
 * Rails' `to_unsafe_h`.
 *
 * Named for what it is. The whole point of wrapping parameters is that
 * reaching the raw structure should be something a reader notices, and a
 * neutral name like `toHash` makes an unfiltered mass-assignment look
 * ordinary.
 */
export function toUnsafeH(params: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(params);
}

/**
 * Rails' `deep_symbolize_keys`, as far as it means anything here.
 *
 * JavaScript has no symbols-as-keys convention for this, so the useful part is
 * the *deep* half: normalising nested keys so a caller can rely on one shape.
 */
export function deepTransformKeys(value: unknown, transform: (key: string) => string): unknown {
  if (Array.isArray(value)) return value.map((each) => deepTransformKeys(each, transform));

  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, each]) => [
        transform(key),
        deepTransformKeys(each, transform),
      ]),
    );
  }

  return value;
}

/** Rails' `delete_if` over a parameter structure. */
export function deleteIf(
  params: Record<string, unknown>,
  reject: (key: string, value: unknown) => boolean,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(params).filter(([key, value]) => !reject(key, value)));
}

/**
 * Whether a key's brackets should be read as literal text. Rails'
 * `ignore_leading_brackets`.
 *
 * `[a]=1` has no name before the bracket, so there is nothing to nest *under*.
 * Rack takes the whole string as one literal key rather than guessing, and
 * guessing is what would let two parsers read one request as two different
 * parameter sets.
 */
export function ignoreLeadingBrackets(key: string): boolean {
  return key.startsWith("[");
}

/**
 * Whether a key is one this parser understands as nested.
 *
 * The leading `[^[\]]+` is what enforces the rule `ignoreLeadingBrackets`
 * states: a key has to have a name before its first bracket. A separate guard
 * for that was redundant with this pattern, so it is not here.
 */
export function nestedParam(key: string): boolean {
  return /^[^[\]]+(\[[^[\]]*\])+$/.test(key);
}

/** The attribute a nested key finally names. Rails' `nested_attribute`. */
export function nestedAttribute(key: string): string | undefined {
  if (!nestedParam(key)) return undefined;

  const segments = key.match(/\[([^[\]]*)\]/g) ?? [];
  const last = segments.at(-1);

  return last === undefined ? undefined : last.slice(1, -1);
}
