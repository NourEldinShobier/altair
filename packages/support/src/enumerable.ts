/**
 * The collection and object helpers ActiveSupport adds to Ruby, for the ones
 * JavaScript does not already have.
 *
 * Rails puts these on `Array`, `Hash` and `Object`; extending built-ins is how
 * two libraries break each other, so they are functions. Anything JavaScript
 * ships — `map`, `filter`, `Object.entries`, `Array.prototype.at` — is not
 * here, because a wrapper around a method that exists is a name to learn for
 * nothing.
 */

/** Rails' `blank?`: empty, whitespace, or nothing at all. */
export function isBlank(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (value instanceof Map || value instanceof Set) return value.size === 0;

  // A plain object with no keys is blank; anything else that happens to have
  // no own enumerable keys is not. A Date has none, and a Date is not blank —
  // nor is a model instance, a RegExp, or anything else with a prototype of
  // its own.
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.keys(value).length === 0;
  }

  return false;
}

/** Rails' `present?`. */
export function isPresent(value: unknown): boolean {
  return !isBlank(value);
}

/** The value, or undefined when it is blank. Rails' `presence`. */
export function presence<T>(value: T): T | undefined {
  return isPresent(value) ? value : undefined;
}

/**
 * The value if it is in the list, otherwise undefined. Rails' `presence_in`.
 *
 *     presenceIn(params.sort, ["name", "date"]) ?? "name"
 *
 * Written for exactly that: a parameter that may only be one of a few things,
 * without an `includes` and a ternary at every call site.
 */
export function presenceIn<T>(value: T, allowed: readonly T[]): T | undefined {
  return allowed.includes(value) ? value : undefined;
}

/** Everything but the blanks. Rails' `compact_blank`. */
export function compactBlank<T>(values: readonly T[]): T[] {
  return values.filter((value) => isPresent(value));
}

/** Keyed by something taken from each. Rails' `index_by`. */
export function indexBy<T, K>(values: readonly T[], key: (value: T) => K): Map<K, T> {
  return new Map(values.map((value) => [key(value), value]));
}

/** Keyed by each, valued by something derived. Rails' `index_with`. */
export function indexWith<T, V>(values: readonly T[], value: (one: T) => V): Map<T, V> {
  return new Map(values.map((one) => [one, value(one)]));
}

/** Fixed-size chunks. Rails' `in_groups_of`, without the padding by default. */
export function inGroupsOf<T>(values: readonly T[], size: number, fill?: T): T[][] {
  if (size < 1) throw new Error("in groups of what? The size must be at least 1.");

  const groups: T[][] = [];

  for (let index = 0; index < values.length; index += size) {
    const group = values.slice(index, index + size);

    // Rails pads to a rectangle when given something to pad with, because the
    // caller is usually laying out a grid and a short last row breaks it.
    if (fill !== undefined) while (group.length < size) group.push(fill);

    groups.push(group);
  }

  return groups;
}

/** A fixed number of chunks, as evenly as they divide. Rails' `in_groups`. */
export function inGroups<T>(values: readonly T[], count: number): T[][] {
  if (count < 1) throw new Error("into how many groups? The count must be at least 1.");

  const groups: T[][] = Array.from({ length: count }, () => []);
  const size = Math.floor(values.length / count);
  const remainder = values.length % count;
  let cursor = 0;

  for (let index = 0; index < count; index += 1) {
    // The first few groups take the remainder, one each, which is what makes
    // them differ by at most one.
    const take = size + (index < remainder ? 1 : 0);

    groups[index] = values.slice(cursor, cursor + take);
    cursor += take;
  }

  return groups;
}

/** Everything except these. Rails' `excluding`. */
export function excluding<T>(values: readonly T[], ...unwanted: T[]): T[] {
  const drop = new Set(unwanted.flat() as T[]);

  return values.filter((value) => !drop.has(value));
}

/** These as well. Rails' `including`. */
export function including<T>(values: readonly T[], ...extra: T[]): T[] {
  return [...values, ...(extra.flat() as T[])];
}

/**
 * Sorted into the order these values are given in. Rails' `in_order_of`.
 *
 *     inOrderOf(posts, (post) => post.state, ["draft", "live"])
 *
 * Anything whose key is not in the list is dropped, as Rails drops it: the
 * list is a statement about what you want as much as about the order.
 */
export function inOrderOf<T, K>(
  values: readonly T[],
  key: (value: T) => K,
  order: readonly K[],
): T[] {
  const rank = new Map(order.map((one, index) => [one, index]));

  return values
    .filter((value) => rank.has(key(value)))
    .sort((left, right) => (rank.get(key(left)) as number) - (rank.get(key(right)) as number));
}

/** A copy all the way down. Rails' `deep_dup`. */
export function deepDup<T>(value: T): T {
  if (Array.isArray(value)) return value.map((one) => deepDup(one)) as T;

  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (value instanceof Map) return new Map([...value].map(([k, v]) => [k, deepDup(v)])) as T;
  if (value instanceof Set) return new Set([...value].map((one) => deepDup(one))) as T;

  // A plain object only. Anything with a prototype of its own is a thing that
  // knows how to copy itself, and guessing on its behalf makes a broken twin.
  if (
    value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value as object).map(([key, one]) => [key, deepDup(one)]),
    ) as T;
  }

  return value;
}

/** Every key rewritten, all the way down. Rails' `deep_transform_keys`. */
export function deepTransformKeys(value: unknown, rename: (key: string) => string): unknown {
  if (Array.isArray(value)) return value.map((one) => deepTransformKeys(one, rename));

  if (
    value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value as object).map(([key, one]) => [
        rename(key),
        deepTransformKeys(one, rename),
      ]),
    );
  }

  return value;
}

/** Every value rewritten, all the way down. Rails' `deep_transform_values`. */
export function deepTransformValues(value: unknown, change: (one: unknown) => unknown): unknown {
  if (Array.isArray(value)) return value.map((one) => deepTransformValues(one, change));

  if (
    value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value as object).map(([key, one]) => [key, deepTransformValues(one, change)]),
    );
  }

  return change(value);
}

/** Only these keys. Rails' `slice`. */
export function slice<T extends object, K extends keyof T>(object: T, ...keys: K[]): Pick<T, K> {
  return Object.fromEntries(
    keys.filter((key) => key in object).map((key) => [key, object[key]]),
  ) as Pick<T, K>;
}

/** Everything but these keys. Rails' `except`. */
export function except<T extends object, K extends keyof T>(object: T, ...keys: K[]): Omit<T, K> {
  const drop = new Set(keys as (string | symbol)[]);

  return Object.fromEntries(Object.entries(object).filter(([key]) => !drop.has(key))) as Omit<T, K>;
}

/** These values, in this order. Rails' `values_at`. */
export function valuesAt<T extends object, K extends keyof T>(
  object: T,
  ...keys: K[]
): (T[K] | undefined)[] {
  return keys.map((key) => object[key]);
}

/** Reaches into nested objects without a chain of guards. Rails' `dig`. */
export function dig(value: unknown, ...keys: (string | number)[]): unknown {
  let current = value;

  for (const key of keys) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }

  return current;
}

/** Whatever it is, as an array. Rails' `Array.wrap`. */
export function wrap<T>(value: T | T[] | null | undefined): T[] {
  if (value === null || value === undefined) return [];

  return Array.isArray(value) ? value : [value];
}

/**
 * "a, b and c". Rails' `to_sentence`.
 *
 * The last separator is its own option because English wants "and" where a
 * list of options wants "or", and because the Oxford comma is a decision
 * somebody will want to make.
 */
export function toSentence(
  values: readonly string[],
  options: { twoWords?: string; lastWord?: string; separator?: string } = {},
): string {
  const separator = options.separator ?? ", ";
  const two = options.twoWords ?? " and ";
  const last = options.lastWord ?? ", and ";

  if (values.length === 0) return "";
  if (values.length === 1) return values[0] as string;
  if (values.length === 2) return values.join(two);

  return values.slice(0, -1).join(separator) + last + values[values.length - 1];
}
