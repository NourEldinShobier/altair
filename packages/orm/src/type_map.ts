/**
 * Turning a column's SQL type into a runtime type, ported from
 * `ActiveRecord::Type::TypeMap` and `AbstractAdapter#initialize_type_map`.
 *
 * `types.ts` has the types and a registry keyed by *our* names. What the
 * database hands back is not one of those: introspection returns
 * `varchar(255)`, `int(11) unsigned`, `numeric(10,2)`, `timestamp without time
 * zone` — adapter-specific strings with their limits baked into them. Something
 * has to be the translation, and without it every value that comes out of a
 * query is whatever the driver felt like producing.
 *
 * That is not a cosmetic problem. A `decimal(10,2)` read as a float turns
 * `19.99` into `19.989999999999998` and money arithmetic starts drifting; a
 * `tinyint(1)` read as a number makes `if (record.published)` true for `0`
 * under some drivers and not others. Both surface far from the query.
 *
 * Two decisions worth stating:
 *
 * **Patterns are anchored, and tried most specific first.** The type names
 * overlap: `int` is inside `point` and at the head of `bigint`, `date` is at
 * the head of `datetime`. Rails matches `int` unanchored and so reads a PostGIS
 * `point` as an integer; anchoring fixes that, and registration order settles
 * the rest — `bigint` is registered after `int` so it is tried first.
 *
 * **An unknown type is refused, not guessed.** Falling back to a string type
 * would make every unmapped column silently stringly-typed, which is a bug that
 * looks like data until someone does arithmetic on it.
 */

import {
  BigIntegerType,
  BinaryType,
  BooleanType,
  DateTimeType,
  DateType,
  DecimalType,
  FloatType,
  IntegerType,
  JsonType,
  StringType,
  TimeType,
  type Type,
  type TypeOptions,
} from "./types.js";

/** What a column's SQL type says about its size. */
export interface SqlTypeParts {
  /** `varchar(255)` -> 255; `numeric(10,2)` -> 10. Rails' `extract_limit`/`extract_precision`. */
  limit?: number;
  precision?: number;
  /** `numeric(10,2)` -> 2. Rails' `extract_scale`. */
  scale?: number;
  unsigned: boolean;
}

const PARENS = /\((\d+)(?:,\s*(\d+))?\)/;

/**
 * Pulls the numbers out of a SQL type. Rails' `extract_*` family.
 *
 * One parenthesised number means a limit or a precision depending on the type,
 * two mean precision and scale. `numeric(10)` has scale zero rather than *no*
 * scale — the distinction matters because a scale of zero means integers only,
 * and treating it as "unspecified" silently allows fractions the column will
 * round away on write.
 */
export function sqlTypeParts(sqlType: string): SqlTypeParts {
  const found = PARENS.exec(sqlType);
  const unsigned = /\bunsigned\b/i.test(sqlType);

  if (!found) return { unsigned };

  const first = Number(found[1]);
  const second = found[2] === undefined ? undefined : Number(found[2]);

  return {
    limit: first,
    precision: first,
    scale: second ?? (isDecimal(sqlType) ? 0 : undefined),
    unsigned,
  };
}

function isDecimal(sqlType: string): boolean {
  return /^(decimal|numeric|number)/i.test(sqlType.trim());
}

/** How a matched pattern builds its type. */
export type TypeBuilder = (sqlType: string, parts: SqlTypeParts) => Type;

interface Mapping {
  pattern: RegExp;
  build: TypeBuilder;
}

export class UnknownSqlType extends Error {
  constructor(sqlType: string, known: readonly string[]) {
    super(
      `No type is mapped for the SQL type ${JSON.stringify(sqlType)}. Mapped patterns: ` +
        `${known.join(", ") || "none"}. Guessing a string type here would make the column ` +
        `silently stringly-typed, which looks like data until somebody does arithmetic on it.`,
    );
    this.name = "UnknownSqlType";
  }
}

/**
 * A list of patterns, tried in order. Rails' `Type::TypeMap`.
 *
 * A list rather than a map, because the keys overlap: `int` is inside `point`
 * and `bigint`, `date` is inside `datetime`. Order is the disambiguation, and
 * it has to be explicit rather than whatever a hash iterates in.
 */
export class TypeMap {
  readonly #mappings: Mapping[] = [];
  readonly #cache = new Map<string, Type>();

  /** Rails' `register_type` — later registrations are tried first. */
  registerType(pattern: RegExp, build: TypeBuilder): void {
    this.#mappings.unshift({ pattern, build });
    this.#cache.clear();
  }

  /** Rails' `alias_type`. */
  aliasType(pattern: RegExp, target: string): void {
    this.registerType(pattern, (_sqlType, parts) => this.lookup(target, parts));
  }

  patterns(): string[] {
    return this.#mappings.map((each) => each.pattern.source);
  }

  /**
   * The type for a SQL type. Rails' `lookup`.
   *
   * Cached: a table of forty columns is looked up on every model load, and the
   * answer for one string never changes.
   */
  lookup(sqlType: string, override?: SqlTypeParts): Type {
    const cached = override ? undefined : this.#cache.get(sqlType);

    if (cached) return cached;

    const parts = override ?? sqlTypeParts(sqlType);

    for (const { pattern, build } of this.#mappings) {
      if (!pattern.test(sqlType)) continue;

      const built = build(sqlType, parts);

      if (!override) this.#cache.set(sqlType, built);

      return built;
    }

    throw new UnknownSqlType(sqlType, this.patterns());
  }

  /** Whether anything would match. Rails' `key?`. */
  registered(sqlType: string): boolean {
    return this.#mappings.some(({ pattern }) => pattern.test(sqlType));
  }

  /** A copy an adapter can add its own types to. Rails' `EXTENDED_TYPE_MAPS`. */
  extend(): TypeMap {
    const copy = new TypeMap();

    // Reversed, because `registerType` unshifts: copying in order would invert
    // the precedence that the original's order encodes.
    for (const { pattern, build } of [...this.#mappings].reverse()) {
      copy.registerType(pattern, build);
    }

    return copy;
  }
}

const options = (parts: SqlTypeParts): TypeOptions => ({
  ...(parts.limit === undefined ? {} : { limit: parts.limit }),
  ...(parts.precision === undefined ? {} : { precision: parts.precision }),
  ...(parts.scale === undefined ? {} : { scale: parts.scale }),
});

/**
 * The mappings every adapter starts from. Rails' `initialize_type_map`.
 *
 * Registered least-specific first, because `registerType` puts each new one in
 * front. `tinyint(1)` is the case that depends on it: it matches the integer
 * pattern too, and only being registered later makes it a boolean.
 */
export function initializeTypeMap(map: TypeMap = new TypeMap()): TypeMap {
  // Anchored at the head of the type rather than matched anywhere inside it.
  // Rails matches `%r(int)i` unanchored, which also matches `point` — so a
  // PostGIS column reads as an integer and every coordinate becomes `NaN`.
  map.registerType(
    /^u?(tiny|small|medium)?int/i,
    (_sqlType, parts) => new IntegerType(options(parts)),
  );
  map.registerType(/^(float|double|real)/i, (_sqlType, parts) => new FloatType(options(parts)));
  map.registerType(/char|text|clob|string/i, (_sqlType, parts) => new StringType(options(parts)));
  map.registerType(
    /^(var)?binary|blob$|^bytea|blob\(/i,
    (_sqlType, parts) => new BinaryType(options(parts)),
  );
  map.registerType(/^date$/i, () => new DateType());
  map.registerType(/^time(\(\d+\))?$/i, (_sqlType, parts) => new TimeType(options(parts)));
  map.registerType(/^(datetime|timestamp)/i, (_sqlType, parts) => new DateTimeType(options(parts)));
  map.registerType(
    /^(decimal|numeric|number)/i,
    (_sqlType, parts) => new DecimalType(options(parts)),
  );
  map.registerType(/^json/i, () => new JsonType());
  map.registerType(/^bool/i, () => new BooleanType());

  // After the others, so it is tried first: `bigint` starts with `int`-ish
  // text the integer pattern also accepts, and being read as a 32-bit integer
  // is how an id past two billion starts colliding.
  map.registerType(/^(bigint|int8)/i, (_sqlType, parts) => new BigIntegerType(options(parts)));

  // MySQL spells a boolean `tinyint(1)`. Without this it is an integer, and
  // `if (record.published)` is then true for `0`.
  map.registerType(/^tinyint\(1\)/i, () => new BooleanType());

  return map;
}

const shared = initializeTypeMap();

/** The default map. Rails' `TYPE_MAP`. */
export function defaultTypeMap(): TypeMap {
  return shared;
}

/** Rails' `lookup_cast_type`. */
export function lookupCastType(sqlType: string, map: TypeMap = shared): Type {
  return map.lookup(sqlType);
}

/** Rails' `type_for_column`, from what introspection returned. */
export function typeForColumn(column: { sqlType: string }, map: TypeMap = shared): Type {
  return map.lookup(column.sqlType);
}

/** Rails' `extended_type_map`. */
export function extendedTypeMap(register: (map: TypeMap) => void): TypeMap {
  const map = shared.extend();
  register(map);

  return map;
}

// --- what the database fills in for you ------------------------------------

/** What introspection says about a column, beyond its type. */
export interface ColumnMetadata {
  sqlType: string;
  default?: unknown;
  defaultFunction?: string;
  autoIncrement?: boolean;
  /** Postgres identity columns and MySQL's generated columns. */
  generated?: boolean;
  onUpdate?: string;
}

/** Rails' `has_default?`. */
export function hasDefault(column: ColumnMetadata): boolean {
  return column.default !== undefined || column.defaultFunction !== undefined;
}

/**
 * Rails' `default_value`.
 *
 * A default *function* is not a default value: `now()` has to be evaluated by
 * the database, and copying the string into an insert would store the literal
 * text. So this returns nothing for one, and the caller omits the column.
 */
export function defaultValue(column: ColumnMetadata): unknown {
  return column.defaultFunction === undefined ? column.default : undefined;
}

/** Rails' `auto_increment?`. */
export function autoIncrement(column: ColumnMetadata): boolean {
  return column.autoIncrement === true;
}

/**
 * Whether the database fills a column in on insert. Rails'
 * `auto_populated_on_insert?`.
 *
 * Which decides whether the column has to be read back after an insert. Get it
 * wrong in one direction and a freshly created record has no id; in the other,
 * every insert pays for a returning clause it does not need.
 */
export function autoPopulatedOnInsert(column: ColumnMetadata): boolean {
  return autoIncrement(column) || column.generated === true || column.defaultFunction !== undefined;
}

/** Rails' `auto_populated_on_update?` — MySQL's `ON UPDATE CURRENT_TIMESTAMP`. */
export function autoPopulatedOnUpdate(column: ColumnMetadata): boolean {
  return column.onUpdate !== undefined || column.generated === true;
}

/** Rails' `auto_populated?`. */
export function autoPopulated(column: ColumnMetadata): boolean {
  return autoPopulatedOnInsert(column) || autoPopulatedOnUpdate(column);
}

// --- times -----------------------------------------------------------------

export type DatabaseTimezone = "utc" | "local";

let timezone: DatabaseTimezone = "utc";

/**
 * How the database stores times. Rails' `default_timezone`.
 *
 * UTC, and it is worth being deliberate: a column storing local time is
 * ambiguous for one hour every autumn, when the same wall-clock time happens
 * twice and nothing in the row says which. Applications that inherited such a
 * schema need `local`; new ones should never choose it.
 */
export function defaultTimezone(): DatabaseTimezone {
  return timezone;
}

export function setDefaultTimezone(chosen: DatabaseTimezone): void {
  timezone = chosen;
}

/** Rails' `is_utc?`. */
export function isUtc(): boolean {
  return timezone === "utc";
}

/**
 * A time as the database should receive it. Rails'
 * `convert_time_to_timestamp`.
 *
 * A `Date` is an instant, so this is a formatting decision rather than a
 * conversion — but formatting a UTC instant with local fields, or the reverse,
 * shifts every stored time by the offset, which reads as data that was written
 * hours before it was.
 */
export function convertTimeToTimestamp(value: Date, zone = timezone): string {
  const parts =
    zone === "utc"
      ? {
          year: value.getUTCFullYear(),
          month: value.getUTCMonth() + 1,
          day: value.getUTCDate(),
          hour: value.getUTCHours(),
          minute: value.getUTCMinutes(),
          second: value.getUTCSeconds(),
          ms: value.getUTCMilliseconds(),
        }
      : {
          year: value.getFullYear(),
          month: value.getMonth() + 1,
          day: value.getDate(),
          hour: value.getHours(),
          minute: value.getMinutes(),
          second: value.getSeconds(),
          ms: value.getMilliseconds(),
        };

  const pad = (part: number, width = 2) => String(part).padStart(width, "0");

  return (
    `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)} ` +
    `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}.${pad(parts.ms, 3)}`
  );
}

/** The other direction. Rails' `convert_timestamp_to_time`. */
export function convertTimestampToTime(value: string, zone = timezone): Date {
  const found = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?/.exec(value);

  if (!found) return new Date(value);

  const [, year, month, day, hour, minute, second, fraction] = found as unknown as string[];
  const ms = Number((fraction ?? "0").padEnd(3, "0").slice(0, 3));
  const numbers = [year, month, day, hour, minute, second].map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];

  if (zone === "utc") {
    return new Date(
      Date.UTC(numbers[0], numbers[1] - 1, numbers[2], numbers[3], numbers[4], numbers[5], ms),
    );
  }

  return new Date(numbers[0], numbers[1] - 1, numbers[2], numbers[3], numbers[4], numbers[5], ms);
}

/** Rails' `current_time_from_proper_timezone`. */
export function currentTimeFromProperTimezone(now: Date = new Date()): Date {
  // Always the same instant: the zone is a formatting concern, and shifting the
  // instant here would make `created_at` disagree with anything else that
  // recorded the same moment.
  return now;
}

// --- casting a whole result ------------------------------------------------

/** Rails' `cast_values` — one column's type applied down a column of rows. */
export function castValues(
  rows: readonly Record<string, unknown>[],
  types: Record<string, Type>,
): Record<string, unknown>[] {
  return rows.map((row) => castResult(row, types));
}

/** Rails' `cast_result` — one row. */
export function castResult(
  row: Record<string, unknown>,
  types: Record<string, Type>,
): Record<string, unknown> {
  const cast: Record<string, unknown> = {};

  for (const [column, value] of Object.entries(row)) {
    const type = types[column];

    // A column with no type passes through rather than being dropped: a query
    // with a computed column is a normal thing, and losing it silently is
    // worse than handing back what the driver gave.
    cast[column] = type ? type.cast(value) : value;
  }

  return cast;
}

/**
 * Rails' `cast_bound_value` — one value on its way into a query.
 *
 * Cast *then* serialised, which is Rails' `value_for_database`. Serialising
 * alone passes a string straight through, so a form's `"7"` reaches an integer
 * column as text and the database either refuses it or compares it as a
 * string, depending on which database it is.
 */
export function castBoundValue(value: unknown, type: Type | undefined): unknown {
  return type ? type.serialize(type.cast(value)) : value;
}

export class IntegerOutOfRange extends Error {
  constructor(value: bigint | number, limit: number) {
    super(
      `${value} does not fit in a ${limit}-byte integer column. The database would wrap or ` +
        `truncate it, so the row would be stored with a different number than the one written.`,
    );
    this.name = "IntegerOutOfRange";
  }
}

/**
 * Rails' `check_int_in_range`.
 *
 * Refused here rather than left to the database, because the databases
 * disagree: Postgres errors, MySQL in its default mode truncates to the
 * maximum and reports success. The second is much worse — the write appears to
 * have worked and the value is wrong forever.
 */
export function checkIntInRange(value: bigint | number, limit = 4): bigint | number {
  const bits = BigInt(limit * 8 - 1);
  const max = (1n << bits) - 1n;
  const asBig = typeof value === "bigint" ? value : BigInt(Math.trunc(value));

  if (asBig > max || asBig < -max - 1n) throw new IntegerOutOfRange(value, limit);

  return value;
}
