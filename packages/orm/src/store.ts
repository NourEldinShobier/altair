/**
 * Accessors for keys inside a serialized column, ported from
 * `ActiveRecord::Store`.
 *
 *     storeAccessor(User, "settings", ["theme", "locale"])
 *     user.theme = "dark"      // writes settings.theme
 *
 * The point is the migration you do not write. Settings accumulate — a
 * notification preference, a dismissed banner, a beta flag — and each one as
 * its own column is a migration, a deploy, and a column that is null for every
 * existing row. A JSON column takes them without ceremony, and these accessors
 * mean the code still reads like an attribute rather than a nested lookup.
 *
 * What you give up is real and worth stating: no index, no NOT NULL, no
 * foreign key, and no type beyond what JSON has. A value that needs any of
 * those wants a column.
 */

/** What a model needs for a store accessor to be defined on it. */
interface StoreTarget {
  prototype: object;
  storedAttributes?: Record<string, string[]>;
}

/**
 * Which keys each store column holds, by column. Rails' `stored_attributes`.
 *
 * Recorded rather than only defined, so a form builder or a serializer can ask
 * what a store contains — otherwise the keys exist only as accessor names and
 * nothing can enumerate them.
 */
export function storedAttributes(model: StoreTarget): Record<string, string[]> {
  return model.storedAttributes ?? {};
}

/**
 * Defines an accessor for each key. Rails' `store_accessor`.
 *
 * Reading a key from a store that is null gives undefined rather than
 * throwing, because an old row written before the column existed has no store
 * at all and that is not the reader's problem. Writing to one creates it.
 */
export function storeAccessor(
  model: StoreTarget,
  column: string,
  keys: readonly string[],
  { prefix, suffix }: { prefix?: string | true; suffix?: string | true } = {},
): void {
  const registry = Object.hasOwn(model, "storedAttributes")
    ? (model.storedAttributes as Record<string, string[]>)
    : (model.storedAttributes = { ...model.storedAttributes });

  registry[column] = [...(registry[column] ?? []), ...keys];

  for (const key of keys) {
    // `prefix: true` means the column's own name, which is what makes two
    // stores holding the same key — `settings.theme` and `preferences.theme` —
    // able to coexist without one accessor shadowing the other.
    const head = prefix === true ? `${column}_` : prefix ? `${prefix}_` : "";
    const tail = suffix === true ? `_${column}` : suffix ? `_${suffix}` : "";
    const name = `${head}${key}${tail}`;

    Object.defineProperty(model.prototype, name, {
      configurable: true,
      enumerable: false,
      get(this: Record<string, Record<string, unknown> | null | undefined>): unknown {
        return this[column]?.[key];
      },
      set(this: Record<string, Record<string, unknown> | null | undefined>, value: unknown) {
        // Replaced rather than mutated, because dirty tracking compares the
        // stored value to the one it loaded: mutating in place leaves both
        // sides the same object, and the save writes nothing.
        this[column] = { ...this[column], [key]: value };
      },
    });
  }
}

/** Whether a key is one of a store's declared keys. */
export function storeKeyDeclared(model: StoreTarget, column: string, key: string): boolean {
  return (storedAttributes(model)[column] ?? []).includes(key);
}
