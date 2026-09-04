/**
 * Turning a column's SQL type into a runtime type, ported from
 * `activerecord/test/cases/type/type_map_test.rb`,
 * `activerecord/test/cases/adapters/mysql2/datatype_test.rb` and the quoting
 * cases in `activerecord/test/cases/quoting_test.rb`.
 *
 * The failures this prevents are all quiet ones: a decimal read as a float
 * drifts, a `tinyint(1)` read as a number makes `if (published)` true for zero,
 * a `bigint` read as a 32-bit integer collides past two billion. None of them
 * raise.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  IntegerOutOfRange,
  TypeMap,
  UnknownSqlType,
  autoIncrement,
  autoPopulated,
  autoPopulatedOnInsert,
  autoPopulatedOnUpdate,
  castBoundValue,
  castResult,
  castValues,
  checkIntInRange,
  convertTimestampToTime,
  convertTimeToTimestamp,
  currentTimeFromProperTimezone,
  defaultTimezone,
  defaultTypeMap,
  defaultValue,
  extendedTypeMap,
  hasDefault,
  initializeTypeMap,
  isUtc,
  lookupCastType,
  setDefaultTimezone,
  sqlTypeParts,
  typeForColumn,
} from "../src/type-map.js";
import { BooleanType, IntegerType, StringType } from "../src/types.js";

afterEach(() => {
  setDefaultTimezone("utc");
});

const nameOf = (sqlType: string) => lookupCastType(sqlType).constructor.name;

describe("reading the numbers out of a SQL type", () => {
  it("takes one number as a limit", () => {
    expect(sqlTypeParts("varchar(255)").limit).toBe(255);
  });

  it("takes two as precision and scale", () => {
    const parts = sqlTypeParts("numeric(10,2)");

    expect(parts.precision).toBe(10);
    expect(parts.scale).toBe(2);
  });

  it("takes a space after the comma", () => {
    expect(sqlTypeParts("numeric(10, 2)").scale).toBe(2);
  });

  /**
   * Scale zero means integers only. Treating it as unspecified allows
   * fractions the column rounds away on write.
   */
  it("gives a bare decimal a scale of zero", () => {
    expect(sqlTypeParts("decimal(10)").scale).toBe(0);
  });

  it("does not invent a scale for something that is not a decimal", () => {
    expect(sqlTypeParts("varchar(255)").scale).toBeUndefined();
  });

  it("notices unsigned", () => {
    expect(sqlTypeParts("int(11) unsigned").unsigned).toBe(true);
    expect(sqlTypeParts("int(11)").unsigned).toBe(false);
  });

  it("survives a type with no numbers", () => {
    expect(sqlTypeParts("text")).toEqual({ unsigned: false });
  });
});

describe("mapping a SQL type", () => {
  it("maps the ordinary ones", () => {
    expect(nameOf("varchar(255)")).toBe("StringType");
    expect(nameOf("text")).toBe("StringType");
    expect(nameOf("float")).toBe("FloatType");
    expect(nameOf("date")).toBe("DateType");
    expect(nameOf("json")).toBe("JsonType");
    expect(nameOf("boolean")).toBe("BooleanType");
  });

  it("carries the limit through", () => {
    expect(lookupCastType("varchar(255)")).toMatchObject({ limit: 255 });
  });

  /**
   * `bigint` contains `int`. Read as a 32-bit integer, an id past two billion
   * starts colliding.
   */
  it("does not read a bigint as an integer", () => {
    expect(nameOf("bigint")).toBe("BigIntegerType");
    expect(nameOf("int8")).toBe("BigIntegerType");
    expect(nameOf("int(11)")).toBe("IntegerType");
  });

  /** `date` is inside `datetime`, and the two are not interchangeable. */
  it("does not read a datetime as a date", () => {
    expect(nameOf("datetime")).toBe("DateTimeType");
    expect(nameOf("timestamp")).toBe("DateTimeType");
    expect(nameOf("date")).toBe("DateType");
  });

  it("does not read a time as a datetime", () => {
    expect(nameOf("time")).toBe("TimeType");
    expect(nameOf("time(3)")).toBe("TimeType");
  });

  /** MySQL spells a boolean this way; as an integer, `0` is truthy. */
  it("reads tinyint(1) as a boolean", () => {
    expect(nameOf("tinyint(1)")).toBe("BooleanType");
  });

  it("still reads a wider tinyint as an integer", () => {
    expect(nameOf("tinyint(4)")).toBe("IntegerType");
  });

  /** Read as a float, `19.99` becomes `19.989999999999998`. */
  it("keeps a decimal a decimal", () => {
    expect(nameOf("numeric(10,2)")).toBe("DecimalType");
    expect(nameOf("decimal(10,2)")).toBe("DecimalType");
    expect(lookupCastType("numeric(10,2)")).toMatchObject({ scale: 2 });
  });

  it("maps the aliases", () => {
    expect(nameOf("blob")).toBe("BinaryType");
    expect(nameOf("clob")).toBe("StringType");
    expect(nameOf("double")).toBe("FloatType");
  });

  /** Guessing a string would make the column silently stringly-typed. */
  it("refuses a type nothing maps", () => {
    expect(() => lookupCastType("inet")).toThrow(UnknownSqlType);
  });

  /**
   * Rails matches `int` unanchored, which also matches `point` — a PostGIS
   * column then reads as an integer and every coordinate becomes `NaN`.
   */
  it("does not read a point as an integer", () => {
    expect(() => lookupCastType("point")).toThrow(UnknownSqlType);
  });

  it("says why", () => {
    expect(() => lookupCastType("nonsense")).toThrow("stringly-typed");
  });

  it("says whether something is mapped", () => {
    expect(defaultTypeMap().registered("varchar(255)")).toBe(true);
    expect(defaultTypeMap().registered("nonsense")).toBe(false);
  });

  it("reads a type off an introspected column", () => {
    expect(typeForColumn({ sqlType: "varchar(255)" })).toBeInstanceOf(StringType);
  });
});

describe("a map of its own", () => {
  it("tries the newest registration first", () => {
    const map = new TypeMap();
    map.registerType(/int/i, () => new IntegerType());
    map.registerType(/bigint/i, () => new BooleanType());

    expect(map.lookup("bigint")).toBeInstanceOf(BooleanType);
  });

  it("follows an alias", () => {
    const map = initializeTypeMap(new TypeMap());
    map.aliasType(/rowversion/i, "bigint");

    expect(map.lookup("rowversion").constructor.name).toBe("BigIntegerType");
  });

  it("lists what it knows", () => {
    const map = new TypeMap();
    map.registerType(/int/i, () => new IntegerType());

    expect(map.patterns()).toEqual(["int"]);
  });

  /**
   * Copying in registration order would invert the precedence, since each
   * registration goes in front. `tinyint(1)` is the case that shows it: it
   * matches the integer pattern as well, and only its later registration makes
   * it a boolean — inverted, a MySQL boolean column comes back an integer.
   */
  it("keeps precedence when extended", () => {
    const map = extendedTypeMap(() => undefined);

    expect(map.lookup("tinyint(1)").constructor.name).toBe("BooleanType");
    expect(map.lookup("bigint").constructor.name).toBe("BigIntegerType");
  });

  it("takes an adapter's own types", () => {
    const map = extendedTypeMap((extended) => {
      extended.registerType(/^geography/i, () => new StringType());
    });

    expect(map.lookup("geography(Point,4326)")).toBeInstanceOf(StringType);
  });

  it("leaves the shared map alone", () => {
    extendedTypeMap((extended) => {
      extended.registerType(/^geography/i, () => new StringType());
    });

    expect(() => lookupCastType("geography(Point,4326)")).toThrow(UnknownSqlType);
  });

  it("answers the same lookup twice", () => {
    expect(lookupCastType("varchar(255)")).toBe(lookupCastType("varchar(255)"));
  });
});

describe("what the database fills in", () => {
  it("says when a column has a default", () => {
    expect(hasDefault({ sqlType: "int", default: 0 })).toBe(true);
    expect(hasDefault({ sqlType: "int" })).toBe(false);
  });

  it("counts a default function as a default", () => {
    expect(hasDefault({ sqlType: "timestamp", defaultFunction: "now()" })).toBe(true);
  });

  /**
   * `now()` has to be evaluated by the database; copying the string into an
   * insert would store the literal text.
   */
  it("does not offer a default function as a value", () => {
    // Introspection reports both: the default's text *and* that it is a
    // function. Returning the text would insert the literal string "now()".
    expect(
      defaultValue({ sqlType: "timestamp", default: "now()", defaultFunction: "now()" }),
    ).toBeUndefined();
  });

  it("offers a plain default", () => {
    expect(defaultValue({ sqlType: "int", default: 0 })).toBe(0);
  });

  it("says which columns are auto-incremented", () => {
    expect(autoIncrement({ sqlType: "bigint", autoIncrement: true })).toBe(true);
    expect(autoIncrement({ sqlType: "bigint" })).toBe(false);
  });

  /**
   * Which decides whether the insert has to read the row back. Wrong one way,
   * a freshly created record has no id; wrong the other, every insert pays for
   * a returning clause it does not need.
   */
  it("says an id is filled in on insert", () => {
    expect(autoPopulatedOnInsert({ sqlType: "bigint", autoIncrement: true })).toBe(true);
    expect(autoPopulatedOnInsert({ sqlType: "timestamp", defaultFunction: "now()" })).toBe(true);
    expect(autoPopulatedOnInsert({ sqlType: "int", default: 0 })).toBe(false);
  });

  it("says a MySQL on-update column is filled in on update", () => {
    expect(autoPopulatedOnUpdate({ sqlType: "timestamp", onUpdate: "CURRENT_TIMESTAMP" })).toBe(
      true,
    );
    expect(autoPopulatedOnUpdate({ sqlType: "int" })).toBe(false);
  });

  it("counts a generated column both ways", () => {
    expect(autoPopulated({ sqlType: "int", generated: true })).toBe(true);
  });

  it("says a plain column is not filled in at all", () => {
    expect(autoPopulated({ sqlType: "int" })).toBe(false);
  });
});

describe("times", () => {
  it("is UTC by default", () => {
    expect(defaultTimezone()).toBe("utc");
    expect(isUtc()).toBe(true);
  });

  it("can be told otherwise", () => {
    setDefaultTimezone("local");

    expect(isUtc()).toBe(false);
  });

  /**
   * Formatting a UTC instant with local fields shifts every stored time by the
   * offset, which reads as data written hours before it was.
   */
  it("formats a time in UTC", () => {
    expect(convertTimeToTimestamp(new Date("2026-06-15T12:34:56.789Z"))).toBe(
      "2026-06-15 12:34:56.789",
    );
  });

  /**
   * Only distinguishable where the machine is not on UTC — under `TZ=UTC` the
   * two branches agree, so this catches a local/UTC mix-up off UTC and nothing
   * catches it on it.
   */
  it("formats a time in local fields when told to", () => {
    const at = new Date("2026-06-15T12:34:56.789Z");
    const pad = (part: number) => String(part).padStart(2, "0");

    expect(convertTimeToTimestamp(at, "local")).toBe(
      `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
        `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.789`,
    );
  });

  it("keeps the milliseconds", () => {
    expect(convertTimeToTimestamp(new Date("2026-06-15T00:00:00.007Z"))).toEndWith(".007");
  });

  it("pads every field", () => {
    expect(convertTimeToTimestamp(new Date("2026-01-02T03:04:05.000Z"))).toBe(
      "2026-01-02 03:04:05.000",
    );
  });

  it("reads one back", () => {
    expect(convertTimestampToTime("2026-06-15 12:34:56.789").toISOString()).toBe(
      "2026-06-15T12:34:56.789Z",
    );
  });

  it("round-trips", () => {
    const at = new Date("2026-06-15T12:34:56.789Z");

    expect(convertTimestampToTime(convertTimeToTimestamp(at))).toEqual(at);
  });

  it("reads one with a T in it", () => {
    expect(convertTimestampToTime("2026-06-15T12:34:56").toISOString()).toBe(
      "2026-06-15T12:34:56.000Z",
    );
  });

  it("reads microseconds, keeping what fits", () => {
    expect(convertTimestampToTime("2026-06-15 12:34:56.123456").getUTCMilliseconds()).toBe(123);
  });

  it("falls back for something it cannot parse", () => {
    expect(convertTimestampToTime("2026-06-15").getUTCFullYear()).toBe(2026);
  });

  /**
   * The same instant whatever the zone: shifting here would make `created_at`
   * disagree with everything else that recorded the same moment.
   */
  it("does not shift the current time", () => {
    const now = new Date("2026-06-15T12:00:00Z");

    expect(currentTimeFromProperTimezone(now)).toEqual(now);
    setDefaultTimezone("local");
    expect(currentTimeFromProperTimezone(now)).toEqual(now);
  });
});

describe("casting results", () => {
  const types = { id: new IntegerType(), published: new BooleanType() };

  it("casts a row", () => {
    expect(castResult({ id: "7", published: "1" }, types)).toEqual({ id: 7, published: true });
  });

  /**
   * A query with a computed column is normal, and losing it silently is worse
   * than handing back what the driver gave.
   */
  it("passes an untyped column through", () => {
    expect(castResult({ total: "12" }, types)).toEqual({ total: "12" });
  });

  it("casts every row", () => {
    expect(castValues([{ id: "1" }, { id: "2" }], types)).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("casts nothing into nothing", () => {
    expect(castValues([], types)).toEqual([]);
  });

  it("serialises a bound value", () => {
    expect(castBoundValue("7", new IntegerType())).toBe(7);
  });

  it("passes one through with no type", () => {
    expect(castBoundValue("7", undefined)).toBe("7");
  });
});

describe("integer range", () => {
  it("takes something that fits", () => {
    expect(checkIntInRange(2_000_000_000)).toBe(2_000_000_000);
    expect(checkIntInRange(-2_000_000_000)).toBe(-2_000_000_000);
  });

  /**
   * Refused here because the databases disagree: Postgres errors, MySQL in its
   * default mode truncates to the maximum and reports success — the write
   * appears to have worked and the value is wrong forever.
   */
  it("refuses something that does not", () => {
    expect(() => checkIntInRange(3_000_000_000)).toThrow(IntegerOutOfRange);
    expect(() => checkIntInRange(-3_000_000_000)).toThrow(IntegerOutOfRange);
  });

  it("says what would have happened", () => {
    expect(() => checkIntInRange(3_000_000_000)).toThrow("wrap or");
  });

  it("takes a wider column", () => {
    expect(checkIntInRange(3_000_000_000, 8)).toBe(3_000_000_000);
  });

  it("takes a narrower one", () => {
    expect(() => checkIntInRange(40_000, 2)).toThrow(IntegerOutOfRange);
    expect(checkIntInRange(30_000, 2)).toBe(30_000);
  });

  it("checks a bigint too", () => {
    expect(() => checkIntInRange(10_000_000_000_000_000_000n, 8)).toThrow(IntegerOutOfRange);
  });

  /** The negative range is one wider than the positive one. */
  it("allows the most negative value", () => {
    expect(checkIntInRange(-2_147_483_648)).toBe(-2_147_483_648);
    expect(() => checkIntInRange(2_147_483_648)).toThrow(IntegerOutOfRange);
  });
});
