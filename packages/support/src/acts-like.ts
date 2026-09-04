/**
 * Asking a value what it can be treated as, ported from
 * `ActiveSupport::CoreExt::Object#acts_like?`.
 *
 * Rails needs this because Ruby has three unrelated classes that are all
 * "a time" — `Time`, `DateTime`, `ActiveSupport::TimeWithZone` — and code that
 * checked `is_a?(Time)` broke on the other two. The situation here is the same
 * and slightly worse: a value that means a moment arrives as a `Date`, as a
 * `TimeWithZone` from `time.ts`, or as an ISO string out of JSON, and a check
 * against any one of them is wrong for the other two.
 *
 * The usual alternative is `instanceof` chains that grow a branch every time
 * somebody introduces a new shape, in every place that ever asks. This asks
 * the value instead.
 */

/** What a value declares itself able to behave as. */
export const ACTS_LIKE = Symbol.for("altair.actsLike");

/** Something that says what it can be treated as. */
export interface ActsLike {
  [ACTS_LIKE]: readonly string[];
}

/**
 * Whether a value can be treated as the named kind. Rails' `acts_like?`.
 *
 * A value declares its own kinds through the `ACTS_LIKE` symbol; the built-in
 * shapes are recognised without having to. `Symbol.for` rather than a private
 * symbol, so a value built by a different copy of this package — two versions
 * in one dependency tree — is still recognised, which is exactly the case a
 * private symbol turns into a silent no.
 */
export function actsLike(value: unknown, kind: string): boolean {
  if (value === null || value === undefined) return false;

  const declared = (value as Partial<ActsLike>)[ACTS_LIKE];

  if (Array.isArray(declared)) return declared.includes(kind);

  switch (kind) {
    case "time":
      return isTimeShaped(value);
    case "date":
      return isDateShaped(value);
    case "string":
      return typeof value === "string";
    default:
      return false;
  }
}

/**
 * Whether a value names a moment. Rails' `acts_like?(:time)`.
 *
 * A `Date`, anything carrying a `toDate`, or a string that parses as an
 * ISO 8601 timestamp. Not any parseable string: `Date.parse` accepts "March"
 * and a bare year, and treating those as timestamps is how a filter on
 * `created_at` silently starts matching January.
 */
export function actsLikeTime(value: unknown): boolean {
  return actsLike(value, "time");
}

/** Whether a value names a day. Rails' `acts_like?(:date)`. */
export function actsLikeDate(value: unknown): boolean {
  return actsLike(value, "date");
}

/** Whether a value behaves as text. Rails' `acts_like?(:string)`. */
export function actsLikeString(value: unknown): boolean {
  return actsLike(value, "string");
}

/** Declares what a value can be treated as, for a type this package cannot see. */
export function declareActsLike<T extends object>(value: T, ...kinds: string[]): T {
  Object.defineProperty(value, ACTS_LIKE, {
    value: Object.freeze([...kinds]),
    enumerable: false,
    configurable: true,
  });

  return value;
}

/** `2026-01-01T12:00:00Z` and its neighbours, but not a bare date. */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

/** `2026-01-01`, and nothing looser. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isTimeShaped(value: unknown): boolean {
  if (value instanceof Date) return !Number.isNaN(value.getTime());

  // Anything that can produce a Date — `TimeWithZone` does — without this
  // module having to know the type, which is the whole point.
  if (typeof (value as { toDate?: unknown }).toDate === "function") return true;

  return typeof value === "string" && ISO_TIMESTAMP.test(value);
}

function isDateShaped(value: unknown): boolean {
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (typeof (value as { toDate?: unknown }).toDate === "function") return true;

  return typeof value === "string" && ISO_DATE.test(value);
}
