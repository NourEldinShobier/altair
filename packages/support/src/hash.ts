/**
 * The object helpers ActiveSupport hangs off `Hash`, for the ones JavaScript
 * does not already have.
 *
 * Same rule as the collection helpers next door: these are functions, not
 * prototype patches, and anything the language already ships is absent. The
 * Ruby originals that only make sense with symbols — `symbolize_keys` and its
 * deep cousin — are absent too, since JavaScript has no symbol to convert to,
 * and a method that quietly did nothing would be worse than no method.
 */

/** Plain objects get walked; anything with a prototype of its own is a leaf. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

/** A copy with every key renamed. Rails' `transform_keys`. */
export function transformKeys<V>(
  object: Record<string, V>,
  rename: (key: string) => string,
): Record<string, V> {
  return Object.fromEntries(Object.entries(object).map(([key, value]) => [rename(key), value]));
}

/** A copy with every value changed. Rails' `transform_values`. */
export function transformValues<V, W>(
  object: Record<string, V>,
  change: (value: V, key: string) => W,
): Record<string, W> {
  return Object.fromEntries(
    Object.entries(object).map(([key, value]) => [key, change(value, key)]),
  );
}

/**
 * A copy whose keys are all strings. Rails' `stringify_keys`.
 *
 * This looks redundant, because JavaScript already coerces a numeric key to a
 * string on the way in — until the object is typed with a numeric index
 * signature, or came back from a `Map`. Then the types and the runtime
 * disagree, and this is what settles it.
 */
export function stringifyKeys<V>(object: Record<PropertyKey, V>): Record<string, V> {
  return Object.fromEntries(Object.entries(object).map(([key, value]) => [String(key), value]));
}

/** The same, all the way down. Rails' `deep_stringify_keys`. */
export function deepStringifyKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepStringifyKeys);
  if (!isPlainObject(value)) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, one]) => [String(key), deepStringifyKeys(one)]),
  );
}

/**
 * Throws unless every key is one you expected. Rails' `assert_valid_keys`.
 *
 * For options objects, where a typo is otherwise silent: `{ ony: "index" }`
 * does not fail, it just never applies, and the caller reads the code eight
 * times looking for the bug. Failing on the typo is the whole point, so the
 * message names the key that was not recognised alongside the ones that are.
 */
export function assertValidKeys(object: Record<string, unknown>, ...valid: string[]): void {
  const allowed = new Set(valid);
  const unexpected = Object.keys(object).filter((key) => !allowed.has(key));

  if (unexpected.length > 0) {
    throw new Error(
      `Unknown key: ${unexpected.map((key) => JSON.stringify(key)).join(", ")}. ` +
        `Valid keys are: ${valid.map((key) => JSON.stringify(key)).join(", ")}`,
    );
  }
}

/**
 * Merge where the receiver wins. Rails' `reverse_merge`.
 *
 * Spreading says the same thing and is the idiom to reach for inline. This is
 * for where the defaults are a named argument rather than a literal:
 * `reverseMerge(options, DEFAULTS)` reads in the order you think about it, and
 * does not invite the transposition that silently overwrites what the caller
 * passed.
 */
export function reverseMerge<T extends object, D extends object>(object: T, defaults: D): D & T {
  return { ...defaults, ...object };
}

/**
 * These values, or a throw naming the first key that was missing. Rails'
 * `fetch_values`.
 *
 * The difference from `valuesAt` is the reason to pick it: that one hands back
 * `undefined` for an absent key and lets the mistake travel, this one stops
 * where the mistake is.
 */
export function fetchValues<T extends object, K extends keyof T>(object: T, ...keys: K[]): T[K][] {
  return keys.map((key) => {
    if (!(key in object)) throw new Error(`key not found: ${JSON.stringify(String(key))}`);
    return object[key];
  });
}

/** A copy without the null and undefined values. Rails' `compact`. */
export function compact<T extends object>(object: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== null && value !== undefined),
  ) as Partial<T>;
}

/**
 * Merge that recurses into nested objects instead of replacing them. Rails'
 * `deep_merge`.
 *
 * Spread is shallow, so `{ mailer: { host } }` spread over
 * `{ mailer: { host, port } }` drops the port. Configuration is nested, and is
 * exactly where that bites.
 */
export function deepMerge<T extends object, O extends object>(target: T, other: O): T & O {
  const merged = { ...target } as Record<string, unknown>;

  for (const [key, value] of Object.entries(other)) {
    const existing = merged[key];
    merged[key] =
      isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }

  return merged as T & O;
}

/**
 * A copy with one key under a new name, in its original position. Rails'
 * `rename_key`.
 *
 * Position is kept because key order is observable — in `JSON.stringify`, in a
 * generated query string, in anything a person reads — and a rename that
 * shuffled the field to the end would show up as noise in a diff.
 */
export function renameKey<V>(
  object: Record<string, V>,
  from: string,
  to: string,
): Record<string, V> {
  if (!(from in object)) return { ...object };

  return Object.fromEntries(
    Object.entries(object).map(([key, value]) => [key === from ? to : key, value]),
  );
}

/** One value as a query-string fragment. Rails' `to_param`. */
export function toParam(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toParam).join("/");

  return String(value);
}

function pair(key: string, value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map((one) => `${encodeURIComponent(`${key}[]`)}=${encodeURIComponent(toParam(one))}`)
      .join("&");
  }

  if (isPlainObject(value)) return toQuery(value, key);

  return `${encodeURIComponent(key)}=${encodeURIComponent(toParam(value))}`;
}

/**
 * An object as a query string, nesting with Rails' bracket convention.
 *
 *     toQuery({ page: 2, filter: { tag: "ruby" } })
 *     // "filter%5Btag%5D=ruby&page=2"
 *
 * Keys are sorted, as Rails sorts them, so the same object always produces the
 * same string — which is what makes the result safe to use as a cache key.
 */
export function toQuery(object: Record<string, unknown>, namespace?: string): string {
  return Object.keys(object)
    .sort()
    .map((key) => pair(namespace ? `${namespace}[${key}]` : key, object[key]))
    .filter((one) => one.length > 0)
    .join("&");
}

/**
 * The trailing options object out of a variadic argument list, and the rest.
 * Rails' `extract_options!`.
 *
 * Ruby's trailing-hash convention has no JavaScript equivalent, but the shape
 * it enables — `link("Home", "/", { class: "nav" })` — is everywhere, and the
 * check for whether that last argument is options or just another item is
 * fiddly enough to get wrong once per codebase.
 */
export function extractOptions<T>(args: unknown[]): {
  rest: T[];
  options: Record<string, unknown>;
} {
  const last = args.at(-1);

  return isPlainObject(last)
    ? { rest: args.slice(0, -1) as T[], options: last }
    : { rest: args as T[], options: {} };
}
