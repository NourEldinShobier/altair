/**
 * A serializer that gives back what it was handed. Ported from
 * `ActiveSupport::MessagePack::Extensions` — the registry of types, the
 * `write_*`/`read_*` pairs, and the choice between refusing an unknown type
 * and falling back for it.
 *
 * JSON is what cache entries, job arguments and session payloads currently go
 * through, and JSON loses things without saying so:
 *
 *   - A `Date` comes back a string. Every caller that then does date
 *     arithmetic on it gets `NaN`, in whatever code runs after the cache warms
 *     up rather than in the code that wrote it.
 *   - A `Set` and a `Map` both come back `{}`. Not wrong-looking — empty.
 *   - `undefined` disappears from an object entirely, so a key that meant
 *     "explicitly unset" becomes a key that means "never mentioned".
 *   - `NaN` and `Infinity` become `null`.
 *   - A `bigint` throws, which is at least loud.
 *
 * Each of those is a bug that appears one deploy after the code that caused
 * it, in a job retry or a cache hit, with a stack pointing at the reader.
 *
 * The design is Rails': a registry keyed by a small integer code, each entry
 * knowing how to take one type apart and put it back together. Codes rather
 * than class names in the payload because the name of a class is a thing that
 * gets refactored, and a payload written last week has to still load.
 */

import { Duration } from "./duration.js";
import { TimeZone } from "./time_zone.js";

/** Thrown when a value is of a type nothing knows how to write. */
export class UnserializableObjectError extends Error {
  constructor(value: unknown) {
    super(`Cannot serialize ${describe(value)}. Register a type for it, or convert it first.`);
    this.name = "UnserializableObjectError";
  }
}

/** Thrown when a payload is not one of ours, or is from a format we dropped. */
export class InvalidFormatError extends Error {
  constructor(detail: string) {
    super(`Not a readable payload: ${detail}`);
    this.name = "InvalidFormatError";
  }
}

/** Thrown when a payload names a class this process does not have. */
export class MissingClassError extends Error {
  constructor(name: string) {
    super(`Payload names a class this process does not know: ${name}`);
    this.name = "MissingClassError";
  }
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (typeof value !== "object") return typeof value;

  return (value.constructor as { name?: string } | undefined)?.name ?? "an object";
}

/** What a payload looks like once written: a code and whatever that code needs. */
interface Tagged {
  /** The registry code. Short, because it is in every nested value. */
  $: number;
  v: unknown;
}

/**
 * The format stamp. Rails writes a version so an old payload is refused rather
 * than misread.
 *
 * A payload from a format we have since changed would otherwise be read with
 * today's codes against yesterday's meanings, which produces a value rather
 * than an error — the worst of the two.
 */
export const DUMP_VERSION = 1;

/** One type the registry knows. */
export interface TypeCodec<T = never> {
  code: number;
  name: string;
  /** Whether a value is this type. */
  matches(value: unknown): boolean;
  /** Takes it apart into something writable. */
  write(value: T, dump: (inner: unknown) => unknown): unknown;
  /** Puts it back together. */
  read(payload: unknown, load: (inner: unknown) => unknown): T;
}

// Each pair below is one type. They are written as named functions rather than
// inline lambdas so a stack from a malformed payload says which type failed.

export function writeDate(value: Date): number {
  // Milliseconds since the epoch, not an ISO string: a string has to be parsed
  // back, and parsing is where a timezone gets guessed.
  return value.getTime();
}

export function readDate(payload: unknown): Date {
  if (typeof payload !== "number") throw new InvalidFormatError("a date needs a number");

  return new Date(payload);
}

export function writeSet(value: Set<unknown>, dump: (inner: unknown) => unknown): unknown[] {
  return Array.from(value, dump);
}

export function readSet(payload: unknown, load: (inner: unknown) => unknown): Set<unknown> {
  if (!Array.isArray(payload)) throw new InvalidFormatError("a set needs an array");

  return new Set(payload.map(load));
}

export function writeMap(
  value: Map<unknown, unknown>,
  dump: (inner: unknown) => unknown,
): unknown[] {
  // Pairs rather than an object, because a Map's keys are not only strings and
  // an object would quietly turn every one of them into one.
  return Array.from(value, ([key, held]) => [dump(key), dump(held)]);
}

export function readMap(
  payload: unknown,
  load: (inner: unknown) => unknown,
): Map<unknown, unknown> {
  if (!Array.isArray(payload)) throw new InvalidFormatError("a map needs an array of pairs");

  return new Map(
    payload.map((pair) => {
      if (!Array.isArray(pair) || pair.length !== 2) {
        throw new InvalidFormatError("a map entry needs two values");
      }

      return [load(pair[0]), load(pair[1])] as const;
    }),
  );
}

export function writeRegexp(value: RegExp): [string, string] {
  return [value.source, value.flags];
}

export function readRegexp(payload: unknown): RegExp {
  if (!Array.isArray(payload) || typeof payload[0] !== "string") {
    throw new InvalidFormatError("a regexp needs a source and flags");
  }

  return new RegExp(payload[0], typeof payload[1] === "string" ? payload[1] : "");
}

export function writeDuration(value: Duration): Record<string, number> {
  // The parts, not the total seconds. A month is not a fixed number of
  // seconds, so collapsing to seconds and back turns "1 month" into 30 days —
  // which lands on the wrong date for eleven months of the year.
  return { ...value.parts };
}

export function readDuration(payload: unknown): Duration {
  if (typeof payload !== "object" || payload === null) {
    throw new InvalidFormatError("a duration needs its parts");
  }

  return new Duration(payload as ConstructorParameters<typeof Duration>[0]);
}

/** Rails' `dump_time_zone`: a zone is its identifier and nothing else. */
export function dumpTimeZone(value: TimeZone): string {
  return value.name;
}

export function readTimeZone(payload: unknown): TimeZone {
  if (typeof payload !== "string") throw new InvalidFormatError("a time zone needs a name");

  const zone = TimeZone.find(payload);

  if (zone === null) throw new InvalidFormatError(`unknown time zone ${payload}`);

  return zone;
}

export function writeUrl(value: URL): string {
  return value.href;
}

export function readUrl(payload: unknown): URL {
  if (typeof payload !== "string") throw new InvalidFormatError("a url needs a string");

  return new URL(payload);
}

export function writeBytes(value: Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

export function readBytes(payload: unknown): Uint8Array {
  if (typeof payload !== "string") throw new InvalidFormatError("bytes need base64");

  return new Uint8Array(Buffer.from(payload, "base64"));
}

export function writeBigInt(value: bigint): string {
  // As a string, because the whole reason a value is a bigint is that a number
  // cannot hold it.
  return value.toString();
}

export function readBigInt(payload: unknown): bigint {
  if (typeof payload !== "string") throw new InvalidFormatError("a bigint needs a string");

  return BigInt(payload);
}

/**
 * A class, by name. Rails' `dump_class`/`load_class`.
 *
 * Jobs and cache entries carry the class they belong to, and the subclass is
 * the part that matters — a payload that loses it runs the parent's code.
 */
const classes = new Map<string, unknown>();

export function registerClass(name: string, value: unknown): void {
  classes.set(name, value);
}

export function dumpClass(value: { name?: string }): string {
  const name = value.name;

  if (typeof name !== "string" || name === "") {
    throw new UnserializableObjectError(value);
  }

  return name;
}

export function readClass(payload: unknown): unknown {
  if (typeof payload !== "string") throw new InvalidFormatError("a class needs a name");

  const known = classes.get(payload);

  // Named rather than returned as undefined: a job that silently loses its
  // class runs as the wrong job, and finding out why later means reading the
  // payload by hand.
  if (known === undefined) throw new MissingClassError(payload);

  return known;
}

export function forgetRegisteredClasses(): void {
  classes.clear();
}

/** Any plain object, written key by key. Rails' `write_object`. */
export function writeObject(
  value: Record<string, unknown>,
  dump: (inner: unknown) => unknown,
): Record<string, unknown> {
  const written: Record<string, unknown> = {};

  for (const [key, held] of Object.entries(value)) written[key] = dump(held);

  return written;
}

export function readObject(
  payload: unknown,
  load: (inner: unknown) => unknown,
): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null) {
    throw new InvalidFormatError("an object needs an object");
  }

  const read: Record<string, unknown> = {};

  for (const [key, held] of Object.entries(payload)) read[key] = load(held);

  return read;
}

/** Rails' `raise_unserializable`. */
export function raiseUnserializable(value: unknown): never {
  throw new UnserializableObjectError(value);
}

/** Rails' `raise_invalid_format`. */
export function raiseInvalidFormat(detail: string): never {
  throw new InvalidFormatError(detail);
}

/**
 * The types every serializer knows. Rails' `install`.
 *
 * The codes are fixed and never reused. A code freed by dropping a type stays
 * freed, because a payload written before the drop is still out there in a
 * cache somewhere and would otherwise load as the type that took its number.
 */
export function defaultCodecs(): TypeCodec<never>[] {
  const codec = <T>(entry: TypeCodec<T>): TypeCodec<never> => entry as unknown as TypeCodec<never>;

  return [
    codec<Date>({
      code: 1,
      name: "Date",
      matches: (value) => value instanceof Date,
      write: writeDate,
      read: readDate,
    }),
    codec<Set<unknown>>({
      code: 2,
      name: "Set",
      matches: (value) => value instanceof Set,
      write: writeSet,
      read: readSet,
    }),
    codec<Map<unknown, unknown>>({
      code: 3,
      name: "Map",
      matches: (value) => value instanceof Map,
      write: writeMap,
      read: readMap,
    }),
    codec<RegExp>({
      code: 4,
      name: "RegExp",
      matches: (value) => value instanceof RegExp,
      write: writeRegexp,
      read: readRegexp,
    }),
    codec<Duration>({
      code: 5,
      name: "Duration",
      matches: (value) => value instanceof Duration,
      write: writeDuration,
      read: readDuration,
    }),
    codec<TimeZone>({
      code: 6,
      name: "TimeZone",
      matches: (value) => value instanceof TimeZone,
      write: dumpTimeZone,
      read: readTimeZone,
    }),
    codec<URL>({
      code: 7,
      name: "URL",
      matches: (value) => value instanceof URL,
      write: writeUrl,
      read: readUrl,
    }),
    codec<Uint8Array>({
      code: 8,
      name: "Uint8Array",
      matches: (value) => value instanceof Uint8Array,
      write: writeBytes,
      read: readBytes,
    }),
    codec<bigint>({
      code: 9,
      name: "BigInt",
      matches: (value) => typeof value === "bigint",
      write: writeBigInt,
      read: readBigInt,
    }),
    // `undefined` needs a code of its own because JSON has no way to hold it:
    // in an object the key vanishes, and in an array it becomes null. A key
    // that meant "explicitly unset" would come back meaning "never mentioned".
    codec<undefined>({
      code: 10,
      name: "undefined",
      matches: (value) => value === undefined,
      write: () => 0,
      read: () => undefined,
    }),
    // Non-finite numbers all become null through JSON, so a computed average
    // that overflowed comes back looking like a missing value.
    codec<number>({
      code: 11,
      name: "NonFiniteNumber",
      matches: (value) => typeof value === "number" && !Number.isFinite(value),
      write: (value) => (Number.isNaN(value) ? "nan" : value > 0 ? "inf" : "-inf"),
      read: (payload) => {
        if (payload === "nan") return Number.NaN;
        if (payload === "inf") return Number.POSITIVE_INFINITY;
        if (payload === "-inf") return Number.NEGATIVE_INFINITY;

        throw new InvalidFormatError("not a non-finite number");
      },
    }),
  ];
}

/** What to do about a type nothing knows. */
export type UnregisteredTypeBehaviour = "error" | "fallback";

export interface SerializerOptions {
  codecs?: TypeCodec<never>[];
  /**
   * `error` refuses an unknown type; `fallback` writes it as a plain object.
   *
   * Rails offers both, and the choice is real: a cache would rather store
   * something approximate than fail a request, while a job queue would rather
   * refuse now than run later with an argument that lost its class.
   */
  unregistered?: UnregisteredTypeBehaviour;
}

/**
 * A serializer over a fixed set of types.
 *
 * Values are written to plain JSON-safe structures rather than to a string, so
 * a caller can hand the result to whatever actually stores it — JSON, a
 * column, a cache backend that does its own encoding.
 */
export class TypedSerializer {
  readonly codecs: TypeCodec<never>[];
  readonly unregistered: UnregisteredTypeBehaviour;

  constructor(options: SerializerOptions = {}) {
    this.codecs = options.codecs ?? defaultCodecs();
    this.unregistered = options.unregistered ?? "error";
  }

  /** The same serializer, refusing anything it does not know. Rails' `install_unregistered_type_error`. */
  static installUnregisteredTypeError(options: SerializerOptions = {}): TypedSerializer {
    return new TypedSerializer({ ...options, unregistered: "error" });
  }

  /** The same, writing an unknown object as a plain one. Rails' `install_unregistered_type_fallback`. */
  static installUnregisteredTypeFallback(options: SerializerOptions = {}): TypedSerializer {
    return new TypedSerializer({ ...options, unregistered: "fallback" });
  }

  #codecFor(value: unknown): TypeCodec<never> | undefined {
    return this.codecs.find((codec) => codec.matches(value));
  }

  /** A value written to something JSON can hold. */
  dump(value: unknown): unknown {
    return this.#dumpValue(value, new Set());
  }

  #dumpValue(value: unknown, seen: Set<object>): unknown {
    const codec = this.#codecFor(value);

    if (codec) {
      const written = codec.write(value as never, (inner) => this.#dumpValue(inner, seen));

      return { $: codec.code, v: written } satisfies Tagged;
    }

    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") return value;

    if (Array.isArray(value)) {
      // Arrays go in `seen` too. An array holding itself has no object in the
      // loop to catch it, and would recurse until the stack ends.
      if (seen.has(value)) throw new UnserializableObjectError(value);

      seen.add(value);
      const written = value.map((each) => this.#dumpValue(each, seen));
      seen.delete(value);

      return written;
    }

    if (typeof value === "object") {
      // A cycle would otherwise recurse until the stack ends, and the stack
      // ending during a cache write is an outage rather than a bad cache
      // entry.
      if (seen.has(value)) throw new UnserializableObjectError(value);

      seen.add(value);

      const plain = Object.getPrototypeOf(value) === Object.prototype;

      if (!plain && this.unregistered === "error") raiseUnserializable(value);

      const written = writeObject(value as Record<string, unknown>, (inner) =>
        this.#dumpValue(inner, seen),
      );

      seen.delete(value);

      return written;
    }

    return raiseUnserializable(value);
  }

  /** A value read back. */
  load(payload: unknown): unknown {
    if (isTagged(payload)) {
      const codec = this.codecs.find((each) => each.code === payload.$);

      if (!codec) raiseInvalidFormat(`no type registered for code ${String(payload.$)}`);

      return codec.read(payload.v, (inner) => this.load(inner));
    }

    if (Array.isArray(payload)) return payload.map((each) => this.load(each));

    if (typeof payload === "object" && payload !== null) {
      return readObject(payload, (inner) => this.load(inner));
    }

    return payload;
  }

  /** A whole payload, stamped with the format version. */
  dumped(value: unknown): { version: number; body: unknown } {
    return { version: DUMP_VERSION, body: this.dump(value) };
  }

  /**
   * The other half, refusing a stamp it does not know.
   *
   * Refused rather than attempted: an older payload read with today's codes
   * against yesterday's meanings produces a value rather than an error, which
   * is the worse of the two outcomes.
   */
  loadDumped(payload: unknown): unknown {
    if (typeof payload !== "object" || payload === null || !("version" in payload)) {
      raiseInvalidFormat("no version stamp");
    }

    const { version, body } = payload as { version: unknown; body: unknown };

    if (version !== DUMP_VERSION) raiseInvalidFormat(`version ${String(version)}`);

    return this.load(body);
  }
}

function isTagged(value: unknown): value is Tagged {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Tagged).$ === "number" &&
    "v" in value
  );
}
