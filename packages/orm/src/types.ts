/**
 * Attribute types as objects, ported from `ActiveModel::Type`.
 *
 * [attributes.ts](./attributes.ts) casts with a function, which answers the
 * one question a form needs: turn this string into a value. A type has three
 * more that a database needs, and they are genuinely different:
 *
 *   - `cast` — what a user typed becomes a value
 *   - `deserialize` — what the database returned becomes a value
 *   - `serialize` — a value becomes what the database stores
 *   - `changed` — whether two values differ *for this type*
 *
 * The last one is why a function is not enough. Dirty tracking asks whether an
 * attribute changed, and for a decimal column `1.0` and `1.00` are the same
 * number and a different string; for a JSON column two objects can be equal
 * without being identical. A type that cannot answer that makes every save
 * write every column, or worse, miss one that did change.
 *
 * `changedInPlace` is the other half: a mutable value — an array, an object, a
 * parsed JSON blob — can be modified without being reassigned, so comparing
 * the value to itself says nothing. Comparing it to what was read from the
 * database is what catches it.
 */

/** How a type reports itself. */
export type TypeName =
  | "string"
  | "immutable_string"
  | "integer"
  | "big_integer"
  | "float"
  | "decimal"
  | "boolean"
  | "date"
  | "datetime"
  | "time"
  | "binary"
  | "json"
  | "value";

export interface TypeOptions {
  limit?: number;
  precision?: number;
  scale?: number;
}

/**
 * The base type, and the one an attribute with no declared type gets.
 *
 * Passes everything through, which is the honest answer for a column nobody
 * described: guessing would be worse than not converting.
 */
export class Type {
  readonly limit: number | undefined;
  readonly precision: number | undefined;
  readonly scale: number | undefined;

  constructor({ limit, precision, scale }: TypeOptions = {}) {
    this.limit = limit;
    this.precision = precision;
    this.scale = scale;
  }

  get type(): TypeName {
    return "value";
  }

  /** What a user typed becomes a value. Null passes through untouched. */
  cast(value: unknown): unknown {
    return value === null || value === undefined ? null : this.castValue(value);
  }

  /** What the database returned becomes a value. Rails' `deserialize`. */
  deserialize(value: unknown): unknown {
    return this.cast(value);
  }

  /** A value becomes what the database stores. Rails' `serialize`. */
  serialize(value: unknown): unknown {
    return value;
  }

  /**
   * Whether the value changed, judged as this type judges values.
   *
   * The default compares the old value to the newly cast one rather than to
   * the raw input, because `"1"` and `1` are the same integer and a form
   * resubmitting an unchanged field must not look like an edit.
   */
  changed(oldValue: unknown, newValue: unknown, _newValueBeforeTypeCast: unknown): boolean {
    return oldValue !== newValue;
  }

  /**
   * Whether a mutable value was modified without being reassigned.
   *
   * Only mutable types answer yes. For the rest there is nothing to modify,
   * and a type that guessed would make every read look like a write.
   */
  changedInPlace(_rawOldValue: unknown, _newValue: unknown): boolean {
    return false;
  }

  /** Whether values of this type can be changed without reassignment. */
  get mutable(): boolean {
    return false;
  }

  /** Whether this type stores bytes rather than text. Rails' `binary?`. */
  get binary(): boolean {
    return false;
  }

  /** What the schema dumper writes for a default of this value. */
  typeCastForSchema(value: unknown): string {
    return JSON.stringify(value);
  }

  /** Throws if the value cannot be held by this type. Rails' `assert_valid_value`. */
  assertValidValue(_value: unknown): void {}

  /** The conversion itself. Subclasses override this rather than `cast`. */
  protected castValue(value: unknown): unknown {
    return value;
  }
}

/** Rails' values for false: an unchecked box posts "0", an unset select "". */
const FALSE_VALUES = new Set(["", "0", "f", "false", "off", "no", "n"]);

export class BooleanType extends Type {
  override get type(): TypeName {
    return "boolean";
  }

  /**
   * A list of falses rather than a list of trues.
   *
   * `Boolean("0")` is true, and "0" is exactly what an unchecked checkbox
   * posts — so the obvious implementation is wrong on the one input this type
   * most exists to handle.
   */
  protected override castValue(value: unknown): boolean {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;

    return !FALSE_VALUES.has(String(value).trim().toLowerCase());
  }

  override serialize(value: unknown): unknown {
    return value === null || value === undefined ? null : this.castValue(value);
  }
}

export class IntegerType extends Type {
  override get type(): TypeName {
    return "integer";
  }

  protected override castValue(value: unknown): number | null {
    if (value === "") return null;
    if (typeof value === "boolean") return value ? 1 : 0;

    const parsed = typeof value === "number" ? value : Number(String(value).trim());

    return Number.isNaN(parsed) ? null : Math.trunc(parsed);
  }
}

/**
 * A column too wide for a JavaScript number.
 *
 * Kept as a string, because `Number` loses precision above 2^53 and a bigint
 * primary key that silently rounds is a row pointing at the wrong record. Cast
 * only strips the formatting; it does not convert.
 */
export class BigIntegerType extends Type {
  override get type(): TypeName {
    return "big_integer";
  }

  protected override castValue(value: unknown): string | null {
    if (value === "") return null;
    if (typeof value === "bigint") return value.toString();

    const text = String(value).trim();

    return /^-?\d+$/.test(text) ? text : null;
  }
}

export class FloatType extends Type {
  override get type(): TypeName {
    return "float";
  }

  protected override castValue(value: unknown): number | null {
    if (value === "") return null;

    const parsed = typeof value === "number" ? value : Number(String(value).trim());

    return Number.isNaN(parsed) ? null : parsed;
  }
}

/**
 * Money and anything else where the binary float is wrong.
 *
 * Held as a string for the same reason a bigint is: 0.1 + 0.2 is not 0.3 in
 * binary floating point, and a total that is off by a hundredth of a cent is a
 * ledger that does not balance. `scale` fixes the number of decimal places, so
 * two values that mean the same amount compare equal.
 */
export class DecimalType extends Type {
  override get type(): TypeName {
    return "decimal";
  }

  protected override castValue(value: unknown): string | null {
    if (value === "") return null;

    const parsed = typeof value === "number" ? value : Number(String(value).trim());
    if (Number.isNaN(parsed)) return null;

    return this.scale === undefined ? String(parsed) : parsed.toFixed(this.scale);
  }

  /**
   * `1.0` and `1.00` are the same amount.
   *
   * Compared after casting both sides, or a form that reposted "1.00" against
   * a stored "1.0" would write a row that changed nothing.
   */
  override changed(oldValue: unknown, newValue: unknown, _raw: unknown): boolean {
    return this.cast(oldValue) !== this.cast(newValue);
  }
}

export class StringType extends Type {
  override get type(): TypeName {
    return "string";
  }

  protected override castValue(value: unknown): string {
    if (typeof value === "boolean") return value ? "t" : "f";

    return String(value);
  }
}

/** A string that is frozen once cast, so nothing downstream can edit it. */
export class ImmutableStringType extends StringType {
  override get type(): TypeName {
    return "immutable_string";
  }

  protected override castValue(value: unknown): string {
    return Object.freeze(super.castValue(value)) as string;
  }
}

export class DateType extends Type {
  override get type(): TypeName {
    return "date";
  }

  /**
   * The time is dropped, not merely ignored.
   *
   * A date with a time attached shifts a day for anyone east or west of the
   * server, which is how a birthday lands on the wrong day for half the users.
   */
  protected override castValue(value: unknown): Date | null {
    if (value === "") return null;

    const date = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(date.getTime())) return null;

    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  }

  override serialize(value: unknown): unknown {
    const date = this.cast(value) as Date | null;

    return date ? (date.toISOString().split("T")[0] as string) : null;
  }

  override changed(oldValue: unknown, newValue: unknown, _raw: unknown): boolean {
    const before = this.cast(oldValue) as Date | null;
    const after = this.cast(newValue) as Date | null;

    return (before?.getTime() ?? null) !== (after?.getTime() ?? null);
  }
}

export class DateTimeType extends Type {
  override get type(): TypeName {
    return "datetime";
  }

  protected override castValue(value: unknown): Date | null {
    if (value === "") return null;

    const date = value instanceof Date ? value : new Date(String(value));

    return Number.isNaN(date.getTime()) ? null : date;
  }

  override serialize(value: unknown): unknown {
    const date = this.cast(value) as Date | null;

    return date ? date.toISOString() : null;
  }

  /** Two Dates for the same instant are different objects and the same time. */
  override changed(oldValue: unknown, newValue: unknown, _raw: unknown): boolean {
    const before = this.cast(oldValue) as Date | null;
    const after = this.cast(newValue) as Date | null;

    return (before?.getTime() ?? null) !== (after?.getTime() ?? null);
  }
}

/** A time of day with no date, held as `HH:MM:SS`. */
export class TimeType extends Type {
  override get type(): TypeName {
    return "time";
  }

  protected override castValue(value: unknown): string | null {
    if (value === "") return null;

    if (value instanceof Date) return value.toISOString().slice(11, 19);

    const text = String(value).trim();
    const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(text);
    if (!match) return null;

    const [, hours, minutes, seconds = "00"] = match;

    return `${hours!.padStart(2, "0")}:${minutes}:${seconds}`;
  }
}

export class BinaryType extends Type {
  override get type(): TypeName {
    return "binary";
  }

  override get binary(): boolean {
    return true;
  }

  override get mutable(): boolean {
    return true;
  }

  protected override castValue(value: unknown): Uint8Array {
    if (value instanceof Uint8Array) return value;

    return new TextEncoder().encode(String(value));
  }

  /** Bytes are compared by content; two buffers holding the same bytes are equal. */
  override changed(oldValue: unknown, newValue: unknown, _raw: unknown): boolean {
    const before = oldValue as Uint8Array | null;
    const after = newValue as Uint8Array | null;

    if (!before || !after) return before !== after;
    if (before.length !== after.length) return true;

    return before.some((byte, index) => byte !== after[index]);
  }

  override changedInPlace(rawOldValue: unknown, newValue: unknown): boolean {
    return this.changed(this.deserialize(rawOldValue), newValue, null);
  }
}

/**
 * A JSON column, which is the type that most needs `changedInPlace`.
 *
 * `post.metadata.tags.push("new")` changes the value without reassigning it,
 * so an equality check against the current value compares the object to
 * itself and reports no change. Comparing the serialized form to what the
 * database returned is what catches it.
 */
export class JsonType extends Type {
  override get type(): TypeName {
    return "json";
  }

  override get mutable(): boolean {
    return true;
  }

  protected override castValue(value: unknown): unknown {
    if (typeof value !== "string") return value;

    try {
      return JSON.parse(value) as unknown;
    } catch {
      // A malformed body is not a reason to fail the whole assignment; the
      // validation that cares can see it is null and say so in words.
      return null;
    }
  }

  override serialize(value: unknown): unknown {
    return value === null || value === undefined ? null : JSON.stringify(value);
  }

  override changed(oldValue: unknown, newValue: unknown, _raw: unknown): boolean {
    return JSON.stringify(oldValue) !== JSON.stringify(newValue);
  }

  override changedInPlace(rawOldValue: unknown, newValue: unknown): boolean {
    if (rawOldValue === null || rawOldValue === undefined) return newValue !== null;

    return String(rawOldValue) !== String(this.serialize(newValue));
  }
}

/**
 * The types available by name, and how a new one joins them.
 *
 * A registry rather than a switch, because the point of an attribute type is
 * that an application can add its own — a money type, a coordinate, an
 * enumeration held as an integer — and have it work everywhere a built-in
 * does.
 */
const REGISTRY = new Map<string, (options: TypeOptions) => Type>([
  ["value", (options) => new Type(options)],
  ["string", (options) => new StringType(options)],
  ["immutable_string", (options) => new ImmutableStringType(options)],
  ["integer", (options) => new IntegerType(options)],
  ["big_integer", (options) => new BigIntegerType(options)],
  ["float", (options) => new FloatType(options)],
  ["decimal", (options) => new DecimalType(options)],
  ["boolean", (options) => new BooleanType(options)],
  ["date", (options) => new DateType(options)],
  ["datetime", (options) => new DateTimeType(options)],
  ["time", (options) => new TimeType(options)],
  ["binary", (options) => new BinaryType(options)],
  ["json", (options) => new JsonType(options)],
]);

/** Adds a type under a name. Rails' `ActiveModel::Type.register`. */
export function registerType(name: string, build: (options: TypeOptions) => Type): void {
  REGISTRY.set(name, build);
}

/**
 * The type registered under a name. Rails' `ActiveModel::Type.lookup`.
 *
 * An unknown name gets the base type rather than an error, matching Rails: a
 * column whose database type nobody has taught the ORM about should still be
 * readable, just uncast.
 */
export function lookupType(name: string, options: TypeOptions = {}): Type {
  return (REGISTRY.get(name) ?? REGISTRY.get("value")!)(options);
}

/** Whether a name has a type. */
export function typeRegistered(name: string): boolean {
  return REGISTRY.has(name);
}

/** Every registered name, for introspection and for error messages. */
export function typeNames(): string[] {
  return [...REGISTRY.keys()];
}
