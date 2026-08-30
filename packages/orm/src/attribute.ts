/**
 * A value together with where it came from, ported from
 * `ActiveModel::Attribute`.
 *
 * The origin is the whole point. A value read from the database has already
 * been through the database's own conversion and needs `deserialize`; a value
 * a user typed is a string and needs `cast`. For most types those do the same
 * thing, which is exactly why the distinction gets lost — and then a JSON
 * column round-trips wrongly, or a boolean read back as the string "f" is
 * true.
 *
 * Keeping the original alongside the current value is what makes dirty
 * tracking work without a second copy of every record: an attribute knows
 * whether it changed, and for a mutable value whether it was changed in place.
 */

import type { Type } from "./types.js";

/** How the value arrived. */
export type AttributeSource = "database" | "user" | "cast" | "uninitialized";

export class Attribute {
  #value: unknown;
  #computed = false;

  private constructor(
    readonly name: string,
    readonly valueBeforeTypeCast: unknown,
    readonly type: Type,
    readonly source: AttributeSource,
    private readonly original?: Attribute,
  ) {}

  /** A value as the database returned it. Rails' `from_database`. */
  static fromDatabase(name: string, value: unknown, type: Type): Attribute {
    return new Attribute(name, value, type, "database");
  }

  /** A value as a user supplied it. Rails' `from_user`. */
  static fromUser(name: string, value: unknown, type: Type, original?: Attribute): Attribute {
    return new Attribute(name, value, type, "user", original);
  }

  /** A value that is already cast, so nothing converts it again. Rails' `with_cast_value`. */
  static withCastValue(name: string, value: unknown, type: Type): Attribute {
    return new Attribute(name, value, type, "cast");
  }

  /**
   * An attribute that was never given a value. Rails' `uninitialized`.
   *
   * Distinct from one holding null, and the difference shows on save: a column
   * nobody assigned should take the database's default, while one explicitly
   * set to null should be written as NULL. Collapsing the two is how a
   * `created_at` with a database default comes out null.
   */
  static uninitialized(name: string, type: Type): Attribute {
    return new Attribute(name, undefined, type, "uninitialized");
  }

  get isUninitialized(): boolean {
    return this.source === "uninitialized";
  }

  /**
   * The value, converted according to where it came from.
   *
   * Computed once and kept, because casting is not always cheap — a JSON blob
   * is parsed, a decimal is formatted — and an attribute is read far more
   * often than it is written.
   */
  get value(): unknown {
    if (!this.#computed) {
      this.#value = this.#convert();
      this.#computed = true;
    }

    return this.#value;
  }

  #convert(): unknown {
    switch (this.source) {
      case "database":
        return this.type.deserialize(this.valueBeforeTypeCast);
      case "user":
        return this.type.cast(this.valueBeforeTypeCast);
      case "cast":
        return this.valueBeforeTypeCast;
      case "uninitialized":
        return undefined;
    }
  }

  /** What the database should store. Rails' `value_for_database`. */
  valueForDatabase(): unknown {
    return this.type.serialize(this.value);
  }

  /** The value this attribute replaced, if it replaced one. Rails' `original_value`. */
  originalValue(): unknown {
    return this.original ? this.original.value : this.value;
  }

  /** What the database had before this was assigned. */
  originalValueForDatabase(): unknown {
    return this.original ? this.original.valueForDatabase() : this.valueForDatabase();
  }

  /**
   * Whether this attribute differs from the one it replaced.
   *
   * Asked of the type rather than compared directly, because what counts as a
   * change depends on the type: 1.0 and 1.00 are the same decimal, two Dates
   * for one instant are the same time.
   */
  changed(): boolean {
    if (!this.original) return false;

    return this.type.changed(this.original.value, this.value, this.valueBeforeTypeCast);
  }

  /**
   * Whether a mutable value was modified without being reassigned. Rails'
   * `changed_in_place?`.
   *
   * The case an equality check cannot see, because both sides are the same
   * object. Compared against what was read rather than against the current
   * value, which is the only thing that did not move.
   */
  changedInPlace(): boolean {
    if (this.isUninitialized) return false;

    return this.type.changedInPlace(this.valueBeforeTypeCast, this.value);
  }

  /** Either kind of change. Rails' `changed?` including in-place edits. */
  changedInAnyWay(): boolean {
    return this.changed() || this.changedInPlace();
  }

  /** The same attribute with a new value from a user. */
  withValueFromUser(value: unknown): Attribute {
    return Attribute.fromUser(this.name, value, this.type, this.original ?? this);
  }

  /** The same attribute with a new value from the database. */
  withValueFromDatabase(value: unknown): Attribute {
    return Attribute.fromDatabase(this.name, value, this.type);
  }

  /** The same value under a different type. Rails' `with_type`. */
  withType(type: Type): Attribute {
    return new Attribute(this.name, this.valueBeforeTypeCast, type, this.source, this.original);
  }

  /**
   * The attribute as it should look after a save. Rails' `forgetting_assignment`.
   *
   * The current value becomes the new original, so the record stops reporting
   * a change it has already written. Built from the database form rather than
   * the value, since that is what the row now holds — and for a mutable value
   * it is also a fresh copy, so a later in-place edit is still noticed.
   */
  forgettingAssignment(): Attribute {
    return Attribute.fromDatabase(this.name, this.valueForDatabase(), this.type);
  }
}
