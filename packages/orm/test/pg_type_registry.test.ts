/**
 * The types a PostgreSQL server tells us about, ported from
 * `activerecord/test/cases/adapters/postgresql/type_lookup_test.rb`,
 * `custom_types_test.rb` and `enum_test.rb`.
 *
 * The failure these are about is not an error: an unregistered oid comes back
 * as the raw string the wire protocol carried, which looks like data until
 * something compares it or does arithmetic on it.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  OidTypeMap,
  type PgTypeRow,
  type TypeBuilders,
  WELL_KNOWN_TYPES,
  applyTypeMappingCallbacks,
  buildMappings,
  clearTypeMappingCallbacks,
  mappingsFor,
  registerClassWithPrecision,
  registerTypeMapping,
  registerTypes,
  typeMapInitializer,
  typeOidsFor,
} from "../src/pg_type_registry.js";

afterEach(() => {
  clearTypeMappingCallbacks();
});

const builders: TypeBuilders = {
  enum: (row) => `enum(${row.typname})`,
  range: (row, subtype) => `range(${String(subtype)})`,
  array: (row, element) => `array(${String(element)})`,
  domain: (row, base) => `domain(${String(base)})`,
};

const row = (over: Partial<PgTypeRow> & Pick<PgTypeRow, "oid" | "typname">): PgTypeRow => ({
  typtype: "b",
  ...over,
});

describe("a store keyed by oid", () => {
  /**
   * The server answers with oids and the schema answers with names; reachable
   * from only one, a column read one way would be a different type from the
   * same column read the other.
   */
  it("takes an oid or a name", () => {
    const store = new OidTypeMap();
    store.register(23, () => "integer");
    store.register("int4", () => "integer");

    expect(store.lookup(23)).toBe("integer");
    expect(store.lookup("int4")).toBe("integer");
  });

  it("says what it has", () => {
    const store = new OidTypeMap();
    store.register(23, () => "integer");

    expect(store.has(23)).toBe(true);
    expect(store.has(99)).toBe(false);
    expect(store.keys()).toEqual([23]);
  });

  /**
   * Explaining what an unregistered oid would otherwise do is the whole point:
   * the value arrives, it is just the wrong kind of thing.
   */
  it("refuses a lookup it cannot answer", () => {
    expect(() => new OidTypeMap().lookup(99)).toThrow("raw string");
  });

  it("aliases one key to another", () => {
    const store = new OidTypeMap();
    store.register("citext", () => "text");
    store.alias(17_000, "citext");

    expect(store.lookup(17_000)).toBe("text");
  });

  /** An alias to something unregistered is a mistake in the caller's ordering. */
  it("refuses an alias to nothing", () => {
    expect(() => new OidTypeMap().alias(1, "nothing")).toThrow("nothing registered");
  });
});

describe("turning pg_type rows into types", () => {
  it("registers an enum", () => {
    const store = new OidTypeMap();
    typeMapInitializer(store, builders).run([row({ oid: 17_000, typname: "mood", typtype: "e" })]);

    expect(store.lookup(17_000)).toBe("enum(mood)");
  });

  it("registers a range over a type it knows", () => {
    const store = new OidTypeMap();
    store.register(23, () => "integer");
    typeMapInitializer(store, builders).run([
      row({ oid: 3904, typname: "int4range", typtype: "r", rngsubtype: 23 }),
    ]);

    expect(store.lookup(3904)).toBe("range(integer)");
  });

  it("registers a domain over a type it knows", () => {
    const store = new OidTypeMap();
    store.register(1700, () => "numeric");
    typeMapInitializer(store, builders).run([
      row({ oid: 17_001, typname: "money_amount", typtype: "d", typbasetype: 1700 }),
    ]);

    expect(store.lookup(17_001)).toBe("domain(numeric)");
  });

  /** There is no `typtype` of "array": an array is anything with an element type. */
  it("registers an array by its element type", () => {
    const store = new OidTypeMap();
    store.register(25, () => "text");
    typeMapInitializer(store, builders).run([row({ oid: 1009, typname: "_text", typelem: 25 })]);

    expect(store.lookup(1009)).toBe("array(text)");
  });

  it("leaves a plain type with no element alone", () => {
    const store = new OidTypeMap();
    const initializer = typeMapInitializer(store, builders);
    initializer.run([row({ oid: 17_002, typname: "widget", typelem: 0 })]);

    expect(store.has(17_002)).toBe(false);
    expect(initializer.pendingOids()).toEqual([]);
  });

  /**
   * The drain: `pg_type` has no useful order, so a domain's base type may
   * appear after the row that needs it. A single pass drops it silently.
   */
  it("resolves a row whose dependency comes later", () => {
    const store = new OidTypeMap();
    const initializer = typeMapInitializer(store, builders);

    initializer.run([
      row({ oid: 17_003, typname: "moods", typelem: 17_004 }),
      row({ oid: 17_004, typname: "mood", typtype: "e" }),
    ]);

    expect(store.lookup(17_003)).toBe("array(enum(mood))");
    expect(initializer.pendingOids()).toEqual([]);
  });

  /** Two links deep, which is what an array of a domain over an enum is. */
  it("resolves a chain of dependencies in any order", () => {
    const store = new OidTypeMap();
    const initializer = typeMapInitializer(store, builders);

    initializer.run([
      row({ oid: 17_005, typname: "_mood_domain", typelem: 17_006 }),
      row({ oid: 17_006, typname: "mood_domain", typtype: "d", typbasetype: 17_007 }),
      row({ oid: 17_007, typname: "mood", typtype: "e" }),
    ]);

    expect(store.lookup(17_005)).toBe("array(domain(enum(mood)))");
  });

  /**
   * A dependency nobody sent stays named rather than disappearing, which is
   * what turns "this column reads as a string" into an answerable question.
   */
  it("keeps a row waiting on a type nobody sent", () => {
    const store = new OidTypeMap();
    const initializer = typeMapInitializer(store, builders);
    initializer.run([row({ oid: 17_008, typname: "_missing", typelem: 99_999 })]);

    expect(store.has(17_008)).toBe(false);
    expect(initializer.pendingOids()).toEqual([99_999]);
  });

  /** A later round can complete what an earlier one could not. */
  it("finishes a pending row when its dependency arrives", () => {
    const store = new OidTypeMap();
    const initializer = typeMapInitializer(store, builders);

    initializer.run([row({ oid: 17_009, typname: "_mood", typelem: 17_010 })]);

    expect(initializer.pendingOids()).toEqual([17_010]);

    initializer.run([row({ oid: 17_010, typname: "mood", typtype: "e" })]);

    expect(store.lookup(17_009)).toBe("array(enum(mood))");
    expect(initializer.pendingOids()).toEqual([]);
  });

  /**
   * A round that registers nothing releases nothing, which ends the loop rather
   * than spinning on rows that can never resolve.
   */
  it("terminates on a cycle", () => {
    const store = new OidTypeMap();
    const initializer = typeMapInitializer(store, builders);

    initializer.run([
      row({ oid: 1, typname: "a", typelem: 2 }),
      row({ oid: 2, typname: "b", typelem: 1 }),
    ]);

    expect(initializer.pendingOids().sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it("reports what it registered", () => {
    const store = new OidTypeMap();
    const registered = typeMapInitializer(store, builders).run([
      row({ oid: 17_011, typname: "mood", typtype: "e" }),
      row({ oid: 17_012, typname: "_missing", typelem: 99_999 }),
    ]);

    expect(registered).toEqual([17_011]);
  });

  /**
   * A database that defines a type shadowing a built-in name must not replace
   * the built-in.
   */
  it("does not replace an oid the store already knows", () => {
    const store = new OidTypeMap();
    store.register(23, () => "integer");
    typeMapInitializer(store, builders).run([row({ oid: 23, typname: "int4", typtype: "e" })]);

    expect(store.lookup(23)).toBe("integer");
  });

  /** A server type whose *name* is known is an alias, not a new registration. */
  it("aliases an oid onto a name it already knows", () => {
    const store = new OidTypeMap();
    store.register("hstore", () => "hstore type");
    const registered = typeMapInitializer(store, builders).run([
      row({ oid: 17_013, typname: "hstore" }),
    ]);

    expect(store.lookup(17_013)).toBe("hstore type");
    expect(registered).toEqual([17_013]);
  });

  /**
   * An alias counts as a registration, so whatever was waiting on that oid is
   * released. Counted only as "already known", the array of a known type would
   * stay pending for ever with nothing said.
   */
  it("releases rows waiting on an oid it aliased", () => {
    const store = new OidTypeMap();
    store.register("citext", () => "citext type");
    const initializer = typeMapInitializer(store, builders);

    initializer.run([
      row({ oid: 17_014, typname: "_citext", typelem: 17_015 }),
      row({ oid: 17_015, typname: "citext" }),
    ]);

    expect(store.lookup(17_014)).toBe("array(citext type)");
    expect(initializer.pendingOids()).toEqual([]);
  });
});

describe("the built-in types", () => {
  /**
   * Their oids are fixed by PostgreSQL, so learning them would be a query on
   * every connection for an answer that is a constant.
   */
  it("are known without asking", () => {
    expect(buildMappings(160_000).get("int4")).toBe(23);
    expect(typeOidsFor(160_000)).toContain(23);
  });

  /**
   * Which types exist is not fixed. Asking an older server about an oid it does
   * not have returns no row, and the type stays unregistered with nothing said.
   */
  it("are filtered by what the server has", () => {
    expect(mappingsFor(160_000).map((each) => each.name)).toContain("xid8");
    expect(mappingsFor(120_000).map((each) => each.name)).not.toContain("xid8");
    expect(typeOidsFor(120_000)).not.toContain(5069);
  });

  it("are registered under both their oid and their name", () => {
    const store = new OidTypeMap();
    registerTypes(store, 160_000, (type) => `built-in ${type.name}`);

    expect(store.lookup(23)).toBe("built-in int4");
    expect(store.lookup("int4")).toBe("built-in int4");
  });

  it("registers only what this server has", () => {
    const store = new OidTypeMap();
    registerTypes(store, 120_000, (type) => type.name);

    expect(store.has(5069)).toBe(false);
    expect(store.has(23)).toBe(true);
  });

  it("has no duplicate oids to disagree about", () => {
    const oids = WELL_KNOWN_TYPES.map((each) => each.oid);

    expect(new Set(oids).size).toBe(oids.length);
  });
});

describe("an application's own types", () => {
  /**
   * A hook rather than a one-off registration, because the map is rebuilt: a
   * migration that creates a type, a schema load, a reconnect. Applied once,
   * the application's type would be present until the first reload and absent
   * afterwards — a bug that only appears in a long-running process.
   */
  it("is applied every time the map is built", () => {
    registerTypeMapping((store) => store.register("citext", () => "citext type"));

    const first = new OidTypeMap();
    const second = new OidTypeMap();
    applyTypeMappingCallbacks(first);
    applyTypeMappingCallbacks(second);

    expect(first.lookup("citext")).toBe("citext type");
    expect(second.lookup("citext")).toBe("citext type");
  });

  it("applies every hook", () => {
    registerTypeMapping((store) => store.register("a", () => "a"));
    registerTypeMapping((store) => store.register("b", () => "b"));

    const store = new OidTypeMap();

    expect(applyTypeMappingCallbacks(store)).toBe(2);
    expect(store.keys()).toEqual(["a", "b"]);
  });

  it("can be cleared", () => {
    registerTypeMapping((store) => store.register("a", () => "a"));
    clearTypeMappingCallbacks();

    const store = new OidTypeMap();

    expect(applyTypeMappingCallbacks(store)).toBe(0);
    expect(store.keys()).toEqual([]);
  });
});

describe("a type whose precision belongs to the column", () => {
  /**
   * `timestamp(3)` and `timestamp(6)` are the same type and not the same
   * behaviour. One shared instance rounds one column's values to the other's
   * precision.
   */
  it("is built per lookup", () => {
    const store = new OidTypeMap();
    let precision = 3;
    registerClassWithPrecision(
      store,
      1114,
      (given) => `timestamp(${String(given)})`,
      () => precision,
    );

    expect(store.lookup(1114)).toBe("timestamp(3)");

    precision = 6;

    expect(store.lookup(1114)).toBe("timestamp(6)");
  });

  it("has no precision when the column names none", () => {
    const store = new OidTypeMap();
    registerClassWithPrecision(store, 1114, (given) => `timestamp(${String(given)})`);

    expect(store.lookup(1114)).toBe("timestamp(undefined)");
  });
});
