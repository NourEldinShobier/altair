/**
 * The types a PostgreSQL server tells us about, ported from
 * `ConnectionAdapters::PostgreSQL::OID::TypeMapInitializer`, `OID::WellKnown`
 * and the type-mapping hooks on `PostgreSQLAdapter`.
 *
 * `type_map.ts` matches SQL type *names* — `varchar(30)`, `numeric(8,2)` — which
 * is how every adapter reads a schema. PostgreSQL does not identify a result
 * column that way: it returns an **oid**, an integer naming a row in `pg_type`,
 * and the set of rows is not fixed. A database defines its own types — an enum,
 * a domain, a composite, an array or a range of any of those — and an extension
 * adds more. So the map is built by asking the server what it has.
 *
 * The failure when this is missing is not an error. An unknown oid comes back
 * as the raw string the wire protocol carried:
 *
 * - A `citext` column compares case-insensitively in the database and
 *   case-sensitively in the application, so a duplicate-email check passes and
 *   the unique index then rejects the insert.
 * - An enum column reads as a string, which is usually right, until it is
 *   compared against a value the application defines.
 * - A `numeric` inside a domain arrives as text and arithmetic on it either
 *   concatenates or produces NaN.
 *
 * Two details do the real work here:
 *
 * - **Registration is drained, not single-pass.** A domain's base type, a
 *   range's subtype and an array's element type may each appear *after* the row
 *   that needs them, because `pg_type` has no useful order. A single pass drops
 *   whatever depended on a later row, silently. So rows that cannot be resolved
 *   yet are held, and each round of registrations releases the ones waiting on
 *   it, until a round registers nothing new.
 * - **The well-known oids depend on the server version.** The oids of built-in
 *   types are stable, but *which* types exist is not — `xid8` arrived in
 *   PostgreSQL 13. Asking an older server about an oid it does not have is a
 *   query that returns nothing, and the type quietly stays unregistered.
 */

/** A row of `pg_type`, as much of it as this needs. */
export interface PgTypeRow {
  oid: number;
  typname: string;
  /** `b`ase, `c`omposite, `d`omain, `e`num, `p`seudo, `r`ange, `m`ultirange. */
  typtype: string;
  /** The element type, for an array. */
  typelem?: number;
  /** The type a domain is over. */
  typbasetype?: number;
  /** The type a range is over. */
  rngsubtype?: number;
  typdelim?: string;
  typinput?: string;
}

/** What a resolved oid produces. Opaque here: the type system is elsewhere. */
export type OidType = unknown;

/**
 * A store keyed by oid, with names as aliases. Rails'
 * `Type::HashLookupTypeMap`.
 *
 * Keyed by oid and *also* by name, because the server answers with oids and the
 * schema answers with names, and the same type has to be reachable from both or
 * a column read one way is a different type from the same column read the other.
 */
export class OidTypeMap {
  readonly #types = new Map<number | string, () => OidType>();

  register(key: number | string, build: () => OidType): void {
    this.#types.set(key, build);
  }

  /** Rails' `alias_type` — a second key for a type already registered. */
  alias(key: number | string, target: number | string): void {
    const build = this.#types.get(target);

    // Resolved now rather than on lookup: an alias to something unregistered is
    // a mistake in the caller's ordering, and resolving lazily would turn it
    // into a lookup failure somewhere else entirely.
    if (build === undefined) {
      throw new TypeError(`Cannot alias ${String(key)} to ${String(target)}: nothing registered.`);
    }

    this.#types.set(key, build);
  }

  has(key: number | string): boolean {
    return this.#types.has(key);
  }

  lookup(key: number | string): OidType {
    const build = this.#types.get(key);

    if (build === undefined) {
      throw new TypeError(
        `No type registered for ${JSON.stringify(key)}. An unregistered oid is read as the raw ` +
          `string the wire protocol carried, which looks like data until something compares it.`,
      );
    }

    return build();
  }

  keys(): (number | string)[] {
    return [...this.#types.keys()];
  }
}

/** How a row becomes a type once everything it depends on is known. */
export interface TypeBuilders {
  enum: (row: PgTypeRow) => OidType;
  range: (row: PgTypeRow, subtype: OidType) => OidType;
  array: (row: PgTypeRow, element: OidType) => OidType;
  domain: (row: PgTypeRow, base: OidType) => OidType;
}

export interface TypeMapInitializer {
  /** Registers everything in these rows that can be resolved. */
  run: (rows: readonly PgTypeRow[]) => number[];
  /** Rails' `pending_oids` — what is still waiting on a type nobody sent. */
  pendingOids: () => number[];
}

/**
 * Turns `pg_type` rows into registrations. Rails' `TypeMapInitializer`.
 *
 * Drains rather than passes once: a row whose dependency has not been seen is
 * held against that dependency's oid, and registering an oid releases whatever
 * was waiting on it. The loop ends when a round registers nothing, which is
 * also how a genuinely missing dependency is detected — those oids stay in
 * `pendingOids` rather than disappearing.
 */
export function typeMapInitializer(store: OidTypeMap, builders: TypeBuilders): TypeMapInitializer {
  const pending = new Map<number, PgTypeRow[]>();

  const requeue = (on: number, row: PgTypeRow): void => {
    const held = pending.get(on);

    if (held) held.push(row);
    else pending.set(on, [row]);
  };

  const registerRow = (row: PgTypeRow, registered: number[]): void => {
    // Already known, from a previous round or from the well-known list. Rails
    // checks this first so a server-defined type never replaces a built-in one.
    if (store.has(row.oid)) return;

    if (store.has(row.typname)) {
      store.alias(row.oid, row.typname);
      registered.push(row.oid);

      return;
    }

    const dependent = (on: number | undefined, build: (subtype: OidType) => OidType): void => {
      if (on === undefined || on === 0) return;

      if (!store.has(on)) {
        requeue(on, row);

        return;
      }

      const resolved = store.lookup(on);
      store.register(row.oid, () => build(resolved));
      registered.push(row.oid);
    };

    switch (row.typtype) {
      case "e":
        store.register(row.oid, () => builders.enum(row));
        registered.push(row.oid);

        return;
      case "r":
        dependent(row.rngsubtype, (subtype) => builders.range(row, subtype));

        return;
      case "d":
        dependent(row.typbasetype, (base) => builders.domain(row, base));

        return;
      default:
        // An array is any type with an element type, whatever its typtype —
        // there is no `typtype` of "array".
        dependent(row.typelem, (element) => builders.array(row, element));
    }
  };

  return {
    run(rows) {
      const all: number[] = [];
      let batch = [...rows];

      while (batch.length > 0) {
        const registered: number[] = [];

        for (const row of batch) registerRow(row, registered);

        all.push(...registered);

        // The rows waiting on what this round registered, and only those: a
        // round that registered nothing releases nothing, which ends the loop
        // rather than spinning on rows that can never resolve.
        batch = registered.flatMap((oid) => {
          const held = pending.get(oid) ?? [];
          pending.delete(oid);

          return held;
        });
      }

      return all;
    },

    pendingOids() {
      return [...pending.keys()];
    },
  };
}

// --- what to ask the server about ------------------------------------------

/** A built-in type and the server version it appeared in. */
export interface WellKnownType {
  name: string;
  oid: number;
  since?: number;
}

/**
 * The built-in types worth registering before asking the server anything.
 *
 * Their oids are fixed by PostgreSQL and never change, so a round trip to learn
 * them would be a query on every connection for an answer that is a constant.
 */
export const WELL_KNOWN_TYPES: readonly WellKnownType[] = [
  { name: "int2", oid: 21 },
  { name: "int4", oid: 23 },
  { name: "int8", oid: 20 },
  { name: "oid", oid: 26 },
  { name: "float4", oid: 700 },
  { name: "float8", oid: 701 },
  { name: "numeric", oid: 1700 },
  { name: "text", oid: 25 },
  { name: "varchar", oid: 1043 },
  { name: "bool", oid: 16 },
  { name: "date", oid: 1082 },
  { name: "timestamp", oid: 1114 },
  { name: "timestamptz", oid: 1184 },
  { name: "json", oid: 114 },
  { name: "jsonb", oid: 3802 },
  { name: "uuid", oid: 2950 },
  // 13 and up. Asking an older server about it returns nothing, and the type
  // stays unregistered with nothing said.
  { name: "xid8", oid: 5069, since: 130_000 },
];

/**
 * Rails' `mappings_for` — the built-in types this server has.
 *
 * Filtered by version rather than sent whole, because a name the server does
 * not know is not an error: the query simply returns no row for it, and the
 * result is a type that is missing for a reason nothing reports.
 */
export function mappingsFor(serverVersion: number): WellKnownType[] {
  return WELL_KNOWN_TYPES.filter((type) => type.since === undefined || serverVersion >= type.since);
}

/** Rails' `type_oids_for` — the oids to look up, for this server. */
export function typeOidsFor(serverVersion: number): number[] {
  return mappingsFor(serverVersion).map((type) => type.oid);
}

/**
 * Rails' `build_mappings` — name-to-oid, for this server.
 *
 * A map rather than the list, for the caller that has a name and needs the oid
 * — a bind parameter has to be sent with one, and sending the wrong oid makes
 * the server cast rather than fail.
 */
export function buildMappings(serverVersion: number): Map<string, number> {
  return new Map(mappingsFor(serverVersion).map((type) => [type.name, type.oid]));
}

/**
 * Rails' `register_types` — puts the built-ins in the store.
 *
 * Before anything the server said, so a database that defines a type shadowing
 * a built-in name cannot replace the built-in: `run` skips an oid the store
 * already knows.
 */
export function registerTypes(
  store: OidTypeMap,
  serverVersion: number,
  build: (type: WellKnownType) => OidType,
): number[] {
  const registered: number[] = [];

  for (const type of mappingsFor(serverVersion)) {
    store.register(type.oid, () => build(type));
    store.register(type.name, () => build(type));
    registered.push(type.oid);
  }

  return registered;
}

// --- an application's own types --------------------------------------------

export type TypeMappingCallback = (store: OidTypeMap) => void;

const callbacks: TypeMappingCallback[] = [];

/**
 * Rails' `register_type_mapping` — a hook run every time the map is built.
 *
 * A hook rather than a one-off registration because the map is rebuilt: a
 * migration that creates a type, a `reset!` after a schema load, a reconnect to
 * a server that was replaced. Registered once and applied once, an
 * application's own type would be present until the first reload and absent
 * afterwards — which is a bug that only appears in a long-running process.
 */
export function registerTypeMapping(callback: TypeMappingCallback): void {
  callbacks.push(callback);
}

/** Rails' `clear_type_mapping_callbacks!`. */
export function clearTypeMappingCallbacks(): void {
  callbacks.length = 0;
}

export function applyTypeMappingCallbacks(store: OidTypeMap): number {
  for (const callback of callbacks) callback(store);

  return callbacks.length;
}

/**
 * Rails' `register_class_with_precision` — a type built per column.
 *
 * A type whose behaviour depends on a column modifier — `timestamp(3)`,
 * `numeric(8,2)` — cannot be one shared instance: the precision belongs to the
 * column, not to the type. Registering the *class* and building per lookup is
 * what keeps two columns of the same type with different precision from
 * rounding each other's values.
 */
export function registerClassWithPrecision(
  store: OidTypeMap,
  key: number | string,
  build: (precision: number | undefined) => OidType,
  precisionFor: () => number | undefined = () => undefined,
): void {
  store.register(key, () => build(precisionFor()));
}
