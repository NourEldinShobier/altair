/**
 * The methods a model gets for free from its attributes, ported from
 * `ActiveModel::AttributeMethods` and the casting half of
 * `ActiveModel::Type`.
 *
 * `attribute-methods.ts` owns the pattern object and the generated-method
 * bookkeeping. This is the declaration layer above it — `attributeMethodSuffix`
 * and friends, which are how `title_changed?`, `reset_title!` and
 * `title_before_type_cast` come to exist without anybody writing them — plus
 * the casting rules those readers apply.
 *
 * Two things here are less obvious than they look:
 *
 * - **A prefix and a suffix can both match, and the longest match wins.**
 *   `reset_title!` matches the `reset_` prefix and the `!` suffix; an affix
 *   matches both ends at once and has to be tried first, or `reset_title!`
 *   resolves as "reset" applied to the attribute `title!`, which does not
 *   exist. Rails orders the patterns for this and the ordering is the feature.
 * - **Casting is not symmetric.** The value going to the database and the
 *   value coming back are different conversions, and a type that used one
 *   function for both would round-trip a value into something else. The
 *   clearest case is a time: writing truncates to the column's precision, and
 *   reading must not truncate again or a value written at microsecond
 *   precision reads back rounded twice.
 */

// --- declaring a family of methods ------------------------------------------------

export interface MethodPattern {
  prefix: string;
  suffix: string;
  /** What the pattern is called, for an error that names it. */
  target: string;
}

const patterns: MethodPattern[] = [];

/** Rails' `attribute_method_prefix`. */
export function attributeMethodPrefix(...prefixes: string[]): MethodPattern[] {
  return prefixes.map((prefix) => register({ prefix, suffix: "", target: `${prefix}attribute` }));
}

/** Rails' `attribute_method_suffix`. */
export function attributeMethodSuffix(...suffixes: string[]): MethodPattern[] {
  return suffixes.map((suffix) => register({ prefix: "", suffix, target: `attribute${suffix}` }));
}

/**
 * Rails' `attribute_method_affix` — both ends at once.
 *
 * Kept separate from a prefix plus a suffix because it has to be *matched*
 * first: `reset_title!` matches the `reset_` prefix and the `!` suffix
 * independently, and resolving it that way asks for the attribute `title!`,
 * which does not exist.
 */
export function attributeMethodAffix(
  ...affixes: { prefix: string; suffix: string }[]
): MethodPattern[] {
  return affixes.map((affix) =>
    register({ ...affix, target: `${affix.prefix}attribute${affix.suffix}` }),
  );
}

function register(pattern: MethodPattern): MethodPattern {
  patterns.push(pattern);

  return pattern;
}

export function registeredPatterns(): MethodPattern[] {
  return [...patterns];
}

export function resetPatterns(): void {
  patterns.length = 0;
}

/**
 * Rails' `strict_match` — which pattern a method name belongs to.
 *
 * The longest match wins, which is the whole reason affixes are a separate
 * kind: `reset_title!` has to resolve as the `reset_`/`!` affix over `title`
 * rather than as the `reset_` prefix over `title!`. Sorted by combined length
 * so the ordering does not depend on declaration order — which would make the
 * behaviour depend on the order two unrelated concerns happened to load in.
 */
export function strictMatch(
  methodName: string,
  known: readonly MethodPattern[] = patterns,
  attributes?: readonly string[],
): { pattern: MethodPattern; attribute: string } | undefined {
  const byLength = [...known].sort(
    (a, b) => b.prefix.length + b.suffix.length - (a.prefix.length + a.suffix.length),
  );

  for (const pattern of byLength) {
    if (!methodName.startsWith(pattern.prefix) || !methodName.endsWith(pattern.suffix)) continue;

    const attribute = methodName.slice(
      pattern.prefix.length,
      methodName.length - pattern.suffix.length,
    );

    if (attribute === "") continue;
    if (attributes !== undefined && !attributes.includes(attribute)) continue;

    return { pattern, attribute };
  }

  return undefined;
}

/**
 * Rails' `define_attribute_accessor_method`.
 *
 * Refuses to define one over a method the class already has. Silently
 * overwriting is how an attribute called `class` or `send` breaks a model in a
 * way that has nothing to do with the attribute, and the error names both so
 * the reader does not have to guess which half is the problem.
 */
export function defineAttributeAccessorMethod(
  target: Record<string, unknown>,
  name: string,
  body: (...args: unknown[]) => unknown,
  { force = false }: { force?: boolean } = {},
): void {
  if (!force && Object.hasOwn(target, name)) {
    throw new Error(
      `${JSON.stringify(name)} is already defined here, so generating an attribute method for it ` +
        `would replace something the class relies on. Rename the attribute, or use an alias.`,
    );
  }

  target[name] = body;
}

/** Rails' `define_on` — where a generated method actually lives. */
export function defineOn(owner: { generated?: Record<string, unknown> }): Record<string, unknown> {
  // A separate container, not the class itself, so an application method of
  // the same name shadows the generated one rather than being overwritten by
  // it — and so `undefineAttributeMethods` can drop the lot without touching
  // anything anybody wrote.
  owner.generated ??= {};

  return owner.generated;
}

/**
 * Rails' `find_by_` dynamic finders — `findByTitleAndAuthor`.
 *
 * Parsed rather than generated ahead of time: the number of possible finders
 * is the powerset of the columns, and generating them all costs more at boot
 * than every one of them saves.
 */
export function findBy_(
  methodName: string,
  attributes: readonly string[],
): { attributes: string[]; bang: boolean } | undefined {
  const match = /^findBy([A-Z]\w*?)(Bang)?$/.exec(methodName);

  if (match === null) return undefined;

  const names = match[1]!.split("And").map((part) => part.charAt(0).toLowerCase() + part.slice(1));

  // Every part has to be a real attribute. A partial match would build a query
  // against a column that is not there, which fails in the adapter with a
  // message about SQL rather than about the method that was called.
  if (!names.every((name) => attributes.includes(name))) return undefined;

  return { attributes: names, bang: match[2] !== undefined };
}

// --- pending declarations ---------------------------------------------------------

export interface AttributeModification {
  name: string;
  type?: string;
  default?: unknown;
}

/**
 * Rails' `apply_pending_attribute_modifications`.
 *
 * Declarations are queued and applied once, in order, when the schema is first
 * needed. Applying each as it is declared would mean `attribute :price,
 * :integer` written above the connection is a lookup against a schema that has
 * not loaded — and applying them out of order would let a later `attribute`
 * for the same name lose to an earlier one.
 */
export function applyPendingAttributeModifications(
  pending: readonly AttributeModification[],
): Map<string, AttributeModification> {
  const applied = new Map<string, AttributeModification>();

  for (const modification of pending) {
    const existing = applied.get(modification.name);

    // A later declaration wins, but only for what it actually said: declaring
    // a type without a default must not clear a default declared earlier.
    applied.set(
      modification.name,
      existing === undefined ? modification : { ...existing, ...definedOnly(modification) },
    );
  }

  return applied;
}

function definedOnly(modification: AttributeModification): Partial<AttributeModification> {
  return Object.fromEntries(
    Object.entries(modification).filter(([, value]) => value !== undefined),
  );
}

/** Rails' `decorate_attributes` — wrap a type without replacing it. */
export function decorateAttributes(
  types: ReadonlyMap<string, string>,
  names: readonly string[],
  decorate: (type: string) => string,
): Map<string, string> {
  const decorated = new Map(types);

  for (const name of names) {
    const type = types.get(name);

    // A name with no type is skipped rather than given one. A decorator that
    // invented a type would hide the missing column it was pointed at.
    if (type === undefined) continue;

    decorated.set(name, decorate(type));
  }

  return decorated;
}

/** Rails' `assign_attributes` — many at once, refusing what is not there. */
export function assignAttributes(
  record: Record<string, unknown>,
  values: Record<string, unknown>,
  known: readonly string[],
): string[] {
  const unknown = Object.keys(values).filter((name) => !known.includes(name));

  if (unknown.length > 0) {
    throw new Error(
      `Unknown attribute${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")}. Ignoring a name ` +
        `nothing recognises is how a typo in a form or a fixture becomes a value that is never ` +
        `saved and never reported.`,
    );
  }

  Object.assign(record, values);

  return Object.keys(values);
}

// --- casting ----------------------------------------------------------------------

/**
 * Rails' `assign_data_with_type_casting`.
 *
 * Casts on the way in, so what the record holds is what a reader gets. Casting
 * lazily on read would mean two reads of an unsaved value can differ — the
 * first through the cast, the second from a cache holding the raw input.
 */
export function assignDataWithTypeCasting(
  values: Record<string, unknown>,
  cast: (name: string, value: unknown) => unknown,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [name, cast(name, value)]),
  );
}

/**
 * Rails' `apply_seconds_precision`.
 *
 * Truncates rather than rounds. Rounding can move a timestamp *forward* past
 * the moment it describes, so a record created at 12:00:00.9 with second
 * precision would claim to have been created at 12:00:01 — a moment that had
 * not happened when the row was written.
 */
export function applySecondsPrecision(value: Date, precision: number | undefined): Date {
  if (precision === undefined || precision >= 3) return value;

  const factor = 10 ** (3 - precision);
  const millis = value.getTime();

  return new Date(Math.floor(millis / factor) * factor);
}

/**
 * Rails' `user_input_in_time_zone`.
 *
 * A string a person typed has no zone, and reading it as UTC silently shifts
 * every time somebody enters by their offset. Interpreted in the application's
 * zone instead, which is the only reading that matches what they meant.
 */
export function userInputInTimeZone(value: string, offsetMinutes: number): Date | undefined {
  const naive = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?$/.exec(value);

  if (naive === null) {
    const parsed = new Date(value);

    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }

  const [, year, month, day, hour, minute, second = "0"] = naive;

  return new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute) - offsetMinutes,
      0,
      Math.round(Number(second) * 1000),
    ),
  );
}

/**
 * Rails' `force_equality?` — whether a type compares by value in a `where`.
 *
 * A range and an array become `BETWEEN` and `IN`; everything else is `=`. A
 * type that answered wrongly here turns `where(id: 1..3)` into `id = '1..3'`,
 * which matches nothing and reports no error.
 */
export function forceEquality(value: unknown): boolean {
  return !Array.isArray(value) && !(value instanceof Set) && !isRange(value);
}

function isRange(value: unknown): boolean {
  return typeof value === "object" && value !== null && "begin" in value && "end" in value;
}

/**
 * Rails' `transforms_query_predicates?`.
 *
 * Whether a type rewrites the comparison rather than just the value — an
 * encrypted attribute searched by ciphertext, or a case-insensitive column
 * compared with `LOWER()`. Declared rather than inferred, because a type that
 * quietly rewrote a predicate would make an index somebody built stop being
 * used with nothing to point at.
 */
export function transformsQueryPredicates(type: { transformsPredicates?: boolean }): boolean {
  return type.transformsPredicates === true;
}

/**
 * The value a type contributes to a `where` condition.
 *
 * Named for the condition rather than `queryValue`, which `query-intent.ts`
 * already uses for reading a single value back from a statement — one is what
 * goes in, the other is what comes out.
 */
export function queryConditionValue(
  value: unknown,
  serialize: (value: unknown) => unknown,
): unknown {
  if (Array.isArray(value)) return value.map((each) => serialize(each));

  return serialize(value);
}

/**
 * Rails' `to_immutable_string`.
 *
 * Ruby needs `String#freeze` here because its strings are mutable, and an
 * attribute handed out by reference is one a caller can edit in place without
 * the record noticing. A JavaScript string primitive is already immutable, so
 * the conversion *is* the whole guarantee — `Object.freeze` on one is a no-op
 * and pretending otherwise would suggest a protection that is not there.
 *
 * The conversion still matters: it is what stops an object with a `toString`
 * being handed out as a live reference to itself.
 */
export function toImmutableString(value: unknown): string {
  return String(value);
}

/**
 * Rails' `serialize_cast_value_compatible?`.
 *
 * Whether a type's cast and serialize agree closely enough that a value can be
 * serialized straight from its cast form. When they do not, serializing has to
 * start from the raw input — the clearest case being a time, where casting
 * truncates to the column's precision and serializing from the truncated value
 * would truncate a second time.
 */
export function serializeCastValueCompatible(type: {
  cast?: unknown;
  serialize?: unknown;
  precision?: number;
}): boolean {
  if (type.precision !== undefined) return false;

  return type.cast === type.serialize || type.serialize === undefined;
}

/** Rails' `itself_if_serialize_cast_value_compatible`. */
export function itselfIfSerializeCastValueCompatible<T extends { precision?: number }>(
  type: T,
): T | undefined {
  return serializeCastValueCompatible(type) ? type : undefined;
}

/**
 * Rails' `normalize` — an attribute's declared normalisation.
 *
 * Applied on write and on query, not on read. Applied on read as well, a
 * record loaded from a row written before the normalisation existed would
 * report itself as unchanged while holding a different value than the row —
 * and the next save would write the normalised form with no record of why.
 */
export function normalizeAttribute(
  value: unknown,
  normalize: (value: unknown) => unknown,
  { onRead = false }: { onRead?: boolean } = {},
): unknown {
  if (onRead) return value;
  if (value === null || value === undefined) return value;

  return normalize(value);
}
