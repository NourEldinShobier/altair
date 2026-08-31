/**
 * Every attribute of a record, together. Ported from
 * `ActiveModel::AttributeSet`.
 *
 * `attribute.ts` already models one attribute — its value, where it came from,
 * and whether it changed. What it cannot answer are the questions that are
 * about the record rather than the column, and those are the ones a save
 * actually asks:
 *
 *   - Which columns changed? (the SET clause)
 *   - What did they hold before? (the WHERE clause for optimistic locking, and
 *     the `saved_changes` a callback reads)
 *   - What goes in the placeholders? (the database form, not the cast value)
 *   - Did anything change at all? (whether to issue a statement)
 *
 * The last one matters more than it looks. A save that always writes turns
 * every `touch` into a full UPDATE of every column, and on a wide table with
 * an index per column that is most of the cost of the request.
 *
 * `finalizeChanges` is the other half: after a successful save the values stay
 * and the memory of having assigned them goes. Without it the next save writes
 * the same values again, and `saved_changes` reports a change that already
 * happened two saves ago.
 */

import { Attribute } from "./attribute.js";
import { Type } from "./types.js";

/**
 * A type that leaves values alone, for an attribute nobody declared one for.
 *
 * The base `Type`, whose cast is a passthrough — not `StringType`, which would
 * turn an array or an object into its string form and lose it.
 */
export const UNTYPED: Type = new Type();

/**
 * Every attribute of one record.
 *
 * Holds attributes rather than values, so that where each came from survives
 * — which is the only thing "changed?" can be answered from.
 */
export class AttributeSet {
  readonly attributes: Map<string, Attribute>;

  /**
   * Names marked changed without their value moving.
   *
   * Kept beside the attributes rather than faked by reassigning the same
   * value, because reassigning cannot work: the type is asked whether the
   * value changed, and it correctly says no.
   */
  readonly #forced = new Set<string>();

  constructor(attributes: Map<string, Attribute> = new Map()) {
    this.attributes = attributes;
  }

  /** A row as the database returned it. Rails' `AttributeSet.from_database`. */
  static buildFromDatabase(
    values: Readonly<Record<string, unknown>>,
    types: Readonly<Record<string, Type>> = {},
  ): AttributeSet {
    const attributes = new Map<string, Attribute>();

    for (const [name, value] of Object.entries(values)) {
      attributes.set(name, Attribute.fromDatabase(name, value, types[name] ?? UNTYPED));
    }

    return new AttributeSet(attributes);
  }

  /**
   * The declared columns, none of them given a value. Rails' `init_attributes`.
   *
   * Uninitialized rather than null, and the difference shows on insert: a
   * column nobody assigned should take the database's default, while one
   * explicitly set to null is written as NULL. Collapsing them is how a
   * `created_at` with a database default comes out null.
   */
  static initAttributes(types: Readonly<Record<string, Type>>): AttributeSet {
    const attributes = new Map<string, Attribute>();

    for (const [name, type] of Object.entries(types)) {
      attributes.set(name, Attribute.uninitialized(name, type));
    }

    return new AttributeSet(attributes);
  }

  get size(): number {
    return this.attributes.size;
  }

  has(name: string): boolean {
    return this.attributes.has(name);
  }

  /** One value. Rails' `fetch_value`. */
  fetchValue(name: string): unknown {
    return this.attributes.get(name)?.value;
  }

  /** The attribute itself, for a caller that needs more than the value. */
  resolveValue(name: string): Attribute | undefined {
    return this.attributes.get(name);
  }

  /**
   * Assigns a value as a user would.
   *
   * Through the attribute rather than replacing it, so the one that was there
   * becomes the original — which is what makes the change visible.
   */
  writeFromUser(name: string, value: unknown, type: Type = UNTYPED): void {
    const held = this.attributes.get(name);

    this.attributes.set(
      name,
      held ? held.withValueFromUser(value) : Attribute.fromUser(name, value, type),
    );
  }

  /**
   * Assigns a value as the database would.
   *
   * No original, because a value from the database *is* the original: this is
   * what a reload produces, and a reloaded record is not a changed one.
   */
  writeFromDatabase(name: string, value: unknown, type: Type = UNTYPED): void {
    const held = this.attributes.get(name);

    this.attributes.set(
      name,
      held ? held.withValueFromDatabase(value) : Attribute.fromDatabase(name, value, type),
    );
  }

  /** A value that needs no casting. Rails' `write_cast_value`. */
  writeCastValue(name: string, value: unknown, type: Type = UNTYPED): void {
    this.attributes.set(name, Attribute.withCastValue(name, value, type));
  }

  /**
   * What each attribute arrived as. Rails' `values_before_type_cast`.
   *
   * What a validation error echoes back, because showing the cast value shows
   * `0` to somebody who typed `banana`.
   */
  valuesBeforeTypeCast(): Record<string, unknown> {
    return Object.fromEntries(
      Array.from(this.attributes, ([name, attribute]) => [name, attribute.valueBeforeTypeCast]),
    );
  }

  /**
   * What goes in the placeholders. Rails' `values_for_database`.
   *
   * Skips the uninitialized, so a column nobody touched is left out of the
   * INSERT and takes its database default.
   */
  valuesForDatabase(): Record<string, unknown> {
    const values: Record<string, unknown> = {};

    for (const [name, attribute] of this.attributes) {
      if (!attribute.isUninitialized) values[name] = attribute.valueForDatabase();
    }

    return values;
  }

  /** Rails' `changed_attribute_names`. */
  changedAttributeNames(): string[] {
    return Array.from(this.attributes)
      .filter(([name, attribute]) => attribute.changedInAnyWay() || this.#forced.has(name))
      .map(([name]) => name);
  }

  /**
   * What each changed attribute held before. Rails' `changed_values`.
   *
   * The original, not the current one — this is what a callback asking "what
   * was the status before?" needs, and what optimistic locking puts in the
   * WHERE clause.
   */
  changedValues(): Record<string, unknown> {
    const changed: Record<string, unknown> = {};

    for (const name of this.changedAttributeNames()) {
      changed[name] = this.attributes.get(name)?.originalValue();
    }

    return changed;
  }

  /**
   * Whether anything changed at all. Rails' `any_changes?`.
   *
   * A save that always writes turns every touch into a full UPDATE of every
   * column, which on a wide table with an index per column is most of the cost
   * of the request.
   */
  anyChanges(): boolean {
    return this.changedAttributeNames().length > 0;
  }

  /**
   * Makes everything count as unchanged. Rails' `finalize_changes`.
   *
   * What a successful save does. Without it the next save writes the same
   * values again, and `saved_changes` reports a change that happened two saves
   * ago.
   */
  finalizeChanges(): void {
    for (const [name, attribute] of this.attributes) {
      this.attributes.set(name, attribute.forgettingAssignment());
    }

    this.#forced.clear();
  }

  /**
   * Makes one attribute count as changed though its value did not move. Rails'
   * `force_change`.
   *
   * For `touch`, and for a column whose value the database computes: the
   * application has nothing new to write but needs the row written.
   */
  forceChange(name: string): void {
    if (this.attributes.has(name)) this.#forced.add(name);
  }

  /** Makes one count as unchanged. Rails' `forget_change`. */
  forgetChange(name: string): void {
    const held = this.attributes.get(name);

    this.#forced.delete(name);

    if (held) this.attributes.set(name, held.forgettingAssignment());
  }

  /**
   * A copy that does not share mutable values. Rails' `deep_dup`.
   *
   * Sharing them means an in-place edit on the copy is also one on the
   * original, so a `dup`ed record marks the record it came from as changed.
   */
  dupOrShare(): AttributeSet {
    const copied = new Map<string, Attribute>();

    for (const [name, attribute] of this.attributes) {
      copied.set(name, dupOrShare(attribute));
    }

    return new AttributeSet(copied);
  }

  /** Every name, for a caller enumerating the record. */
  keys(): string[] {
    return Array.from(this.attributes.keys());
  }
}

/**
 * A copy of one attribute, or the same one. Rails' `dup_or_share`.
 *
 * Only a value that could have been mutated needs copying, and everything else
 * shares — which is most of them, on every `dup` of every record.
 */
export function dupOrShare(attribute: Attribute): Attribute {
  const value = attribute.value;

  if (!Array.isArray(value) && !isPlainObject(value)) return attribute;

  return Attribute.withCastValue(
    attribute.name,
    Array.isArray(value) ? [...value] : { ...(value as object) },
    attribute.type,
  );
}

/**
 * A bag of keys, as opposed to anything with behaviour.
 *
 * The prototype check is doing all the work: a Date, a Map, a model instance
 * all have their own prototype, so none of them reach here. An explicit
 * `instanceof Date` alongside it was dead code.
 */
function isPlainObject(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype
  );
}

/** Rails' `came_from_user?`. */
export function cameFromUser(attribute: Attribute): boolean {
  return attribute.source === "user";
}

/** Rails' `initialized?`. */
export function initialized(attribute: Attribute): boolean {
  return !attribute.isUninitialized;
}

/** Whether it can be written at all. Rails' `serializable?`. */
export function serializable(attribute: Attribute): boolean {
  return !attribute.isUninitialized;
}

/** Rails' `type_cast`. */
export function typeCast(attribute: Attribute, value: unknown): unknown {
  return attribute.type.cast(value);
}

/** Rails' `serialize_cast_value`. */
export function serializeCastValue(attribute: Attribute, value: unknown): unknown {
  return attribute.type.serialize(value);
}

/** Rails' `changed_in_place?`, as a function over an attribute. */
export function attributeChangedInPlace(attribute: Attribute): boolean {
  return attribute.changedInPlace();
}

/**
 * Whether a value came from assigning a whole hash of them. Rails'
 * `value_constructed_by_mass_assignment?`.
 *
 * A nested hash or array assigned to one attribute is almost always a nested
 * form's parameters rather than a value, and treating it as a value stores
 * `[object Object]`.
 */
export function valueConstructedByMassAssignment(value: unknown): boolean {
  return Array.isArray(value) || isPlainObject(value);
}

/** A default that applies only when the user gave nothing. Rails' `with_user_default`. */
export function withUserDefault(attribute: Attribute, fallback: unknown): Attribute {
  if (!attribute.isUninitialized) return attribute;

  return Attribute.fromDatabase(attribute.name, fallback, attribute.type);
}
