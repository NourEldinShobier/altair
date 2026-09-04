/**
 * The types Rails registers with its serializer that a plain object graph
 * cannot carry — ported from `ActiveSupport::MessagePack::Extensions`.
 *
 * `typed-serializer.ts` owns the registry and the types every application
 * uses. These are the ones that only matter once an application stores
 * something structured: a range in a cache key, an exact decimal in a job
 * argument, an address in a session.
 *
 * They share one problem, which is why they need codecs rather than being left
 * to a generic object dump. **Each of them round-trips through a plain object
 * into something that is equal and behaves differently.** A range dumped as
 * `{begin, end}` comes back as an object that no longer covers anything; a
 * rational dumped as a float comes back as a number that no longer sums
 * exactly; a zone-aware time dumped as an ISO string comes back in UTC and
 * prints differently to every user who is not.
 *
 * The codes here continue from `defaultCodecs`' and are never reused. A code
 * freed by dropping a type stays freed, because a payload written before the
 * drop is still in a cache somewhere and would otherwise load as whatever took
 * its number.
 */

import type { TypeCodec } from "./typed-serializer.js";

// --- ranges -----------------------------------------------------------------------------

export interface SerializableRange {
  begin: unknown;
  end: unknown;
  excludeEnd: boolean;
}

export function isRange(value: unknown): value is SerializableRange {
  return (
    typeof value === "object" &&
    value !== null &&
    "begin" in value &&
    "end" in value &&
    "excludeEnd" in value
  );
}

/**
 * Rails' `write_range`.
 *
 * The exclusivity travels with it. A range dumped without it comes back
 * inclusive, so `1...5` becomes `1..5` — one extra element, silently, in
 * whatever the range was filtering.
 */
export function writeRange(
  value: SerializableRange,
  dump: (inner: unknown) => unknown,
): [unknown, unknown, boolean] {
  return [dump(value.begin), dump(value.end), value.excludeEnd];
}

export function readRange(payload: unknown, load: (inner: unknown) => unknown): SerializableRange {
  const [begin, end, excludeEnd] = payload as [unknown, unknown, boolean];

  return { begin: load(begin), end: load(end), excludeEnd: excludeEnd === true };
}

// --- exact numbers -----------------------------------------------------------------------

export interface Rational {
  numerator: number;
  denominator: number;
}

export function isRational(value: unknown): value is Rational {
  return (
    typeof value === "object" && value !== null && "numerator" in value && "denominator" in value
  );
}

/**
 * Rails' `write_rational`.
 *
 * The pair, not the quotient. Dumped as a float, `1/3` comes back as
 * `0.3333333333333333` — a number that is close, sums differently, and cannot
 * be told apart from a value that was always approximate.
 */
export function writeRational(value: Rational): [number, number] {
  return [value.numerator, value.denominator];
}

export function readRational(payload: unknown): Rational {
  const [numerator, denominator] = payload as [number, number];

  if (denominator === 0) {
    throw new Error(
      "A rational with a zero denominator is not a number. Reading one back as Infinity would " +
        "let a corrupt payload become a value that spreads through every later calculation.",
    );
  }

  return { numerator, denominator };
}

export interface Complex {
  real: number;
  imaginary: number;
}

export function isComplex(value: unknown): value is Complex {
  return typeof value === "object" && value !== null && "real" in value && "imaginary" in value;
}

/** Rails' `write_complex`. */
export function writeComplex(value: Complex): [number, number] {
  return [value.real, value.imaginary];
}

export function readComplex(payload: unknown): Complex {
  const [real, imaginary] = payload as [number, number];

  return { real, imaginary };
}

// --- times that know their zone -----------------------------------------------------------

export interface ZonedTime {
  epochMs: number;
  zone: string;
}

export function isZonedTime(value: unknown): value is ZonedTime {
  return typeof value === "object" && value !== null && "epochMs" in value && "zone" in value;
}

/**
 * Rails' `write_time_with_zone`.
 *
 * The instant *and* the zone, as two fields. An ISO string carries an offset,
 * which is not a zone: `-05:00` is New York in January and nowhere in
 * particular in July, so a value round-tripped through one prints an hour out
 * for half the year.
 */
export function writeTimeWithZone(value: ZonedTime): [number, string] {
  return [value.epochMs, value.zone];
}

export function readTimeWithZone(payload: unknown): ZonedTime {
  const [epochMs, zone] = payload as [number, string];

  return { epochMs, zone };
}

/**
 * Rails' `write_time_zone` — a zone on its own.
 *
 * The reader is `typed-serializer.ts`'s `readTimeZone`, which already resolves
 * a name against the zone table; writing is the half that was missing.
 */
export function writeTimeZone(zone: { name: string }): string {
  return zone.name;
}

/**
 * Rails' `write_time` — an instant with no zone attached.
 *
 * Milliseconds since the epoch. Distinct from `Date` in the registry only in
 * that it survives a sub-millisecond precision field alongside it; the two
 * would otherwise be one codec.
 */
export function writeTime(value: { epochMs: number; nanos?: number }): [number, number] {
  return [value.epochMs, value.nanos ?? 0];
}

export function readTime(payload: unknown): { epochMs: number; nanos: number } {
  const [epochMs, nanos] = payload as [number, number];

  return { epochMs, nanos };
}

/** Rails' `write_datetime` — a civil date and time, with no instant attached. */
export function writeDatetime(value: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}): [number, number, number, number, number, number] {
  return [value.year, value.month, value.day, value.hour, value.minute, value.second];
}

export function readDatetime(payload: unknown): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const [year, month, day, hour, minute, second] = payload as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];

  return { year, month, day, hour, minute, second };
}

// --- addresses ---------------------------------------------------------------------------

export interface IpAddress {
  address: string;
  prefix?: number;
}

export function isIpAddress(value: unknown): value is IpAddress {
  return typeof value === "object" && value !== null && "address" in value;
}

/**
 * Rails' `write_ipaddr`.
 *
 * The prefix travels with it. An address dumped without one comes back as a
 * single host rather than a network, so a rule written about `10.0.0.0/8`
 * silently applies to one machine.
 */
export function writeIpaddr(value: IpAddress): [string, number | null] {
  return [value.address, value.prefix ?? null];
}

export function readIpaddr(payload: unknown): IpAddress {
  const [address, prefix] = payload as [string, number | null];

  return prefix === null ? { address } : { address, prefix };
}

// --- markup that has already been escaped ----------------------------------------------------

export interface SafeBuffer {
  html: string;
  htmlSafe: true;
}

export function isSafeBuffer(value: unknown): value is SafeBuffer {
  return (
    typeof value === "object" &&
    value !== null &&
    "html" in value &&
    (value as { htmlSafe?: unknown }).htmlSafe === true
  );
}

/**
 * Rails' `write_safe_buffer`.
 *
 * The safety flag is what is being preserved. A safe buffer dumped as a plain
 * string comes back unsafe, so a cached fragment renders escaped — `&lt;p&gt;`
 * on the page — and a cache warm-up makes the bug appear only for users who
 * missed the cache.
 *
 * The reverse is worse and is why this is a distinct type rather than a flag
 * on strings: a plain string read back as safe renders whatever a user typed
 * as markup.
 */
export function writeSafeBuffer(value: SafeBuffer): string {
  return value.html;
}

export function readSafeBuffer(payload: unknown): SafeBuffer {
  return { html: String(payload), htmlSafe: true };
}

/**
 * Rails' `write_class` — a class referred to by name.
 *
 * The name only. A class cannot be reconstructed from a payload, so what
 * crosses is a name the other side looks up in its own registry — and a name
 * it does not know has to fail there rather than produce a stand-in that
 * answers to nothing.
 */
export function writeClass(value: { name: string }): string {
  return value.name;
}

// --- the registry additions --------------------------------------------------------------------

/**
 * Rails' `type_for_string` — which codec a name refers to.
 *
 * By name rather than by code when reading a configuration, because the codes
 * are an implementation detail and a configuration file naming one would break
 * the moment a type was added.
 */
export function typeForString(
  name: string,
  codecs: readonly TypeCodec<never>[],
): TypeCodec<never> | undefined {
  return codecs.find((codec) => codec.name === name);
}

/**
 * Rails' `message_pack_factory` — the registry with these types added.
 *
 * Codes continue from `defaultCodecs`' and are never reused. A code freed by
 * dropping a type stays freed, because a payload written before the drop is
 * still in a cache somewhere and would otherwise load as whatever took its
 * number.
 */
export function extraCodecs(): TypeCodec<never>[] {
  const codec = <T>(entry: TypeCodec<T>): TypeCodec<never> => entry as unknown as TypeCodec<never>;

  return [
    codec<SerializableRange>({
      code: 20,
      name: "Range",
      matches: isRange,
      write: writeRange,
      read: readRange,
    }),
    codec<Rational>({
      code: 21,
      name: "Rational",
      matches: isRational,
      write: writeRational,
      read: readRational,
    }),
    codec<Complex>({
      code: 22,
      name: "Complex",
      matches: isComplex,
      write: writeComplex,
      read: readComplex,
    }),
    codec<ZonedTime>({
      code: 23,
      name: "TimeWithZone",
      matches: isZonedTime,
      write: writeTimeWithZone,
      read: readTimeWithZone,
    }),
    codec<IpAddress>({
      code: 24,
      name: "IPAddr",
      // Checked after TimeWithZone and Range, which are also plain objects —
      // the first matching codec wins, so a looser test placed earlier would
      // claim values belonging to a stricter one.
      matches: isIpAddress,
      write: writeIpaddr,
      read: readIpaddr,
    }),
    codec<SafeBuffer>({
      code: 25,
      name: "SafeBuffer",
      matches: isSafeBuffer,
      write: writeSafeBuffer,
      read: readSafeBuffer,
    }),
  ];
}

/** Rails' `message_pack_factory` — the whole registry, in match order. */
export function messagePackFactory(base: readonly TypeCodec<never>[]): TypeCodec<never>[] {
  const codes = new Set(base.map((each) => each.code));
  const added = extraCodecs();

  for (const each of added) {
    if (codes.has(each.code)) {
      throw new Error(
        `Code ${each.code} is already taken. Codes are never reused, because a payload written ` +
          `before a type was dropped is still in a cache somewhere and would load as whatever ` +
          `took its number.`,
      );
    }
  }

  // The added codecs first. The rule is that the first codec whose `matches`
  // answers yes is the one used, and several of these are plain objects — so
  // the order is what would decide any future overlap, and putting the
  // narrower set ahead of the general one is the safer default. No two current
  // codecs claim the same value.
  return [...added, ...base];
}

/** Rails' `pack` — one value, tagged. */
export function pack(value: unknown, codecs: readonly TypeCodec<never>[]): unknown {
  const codec = codecs.find((each) => each.matches(value));

  if (codec === undefined) return value;

  return { $: codec.code, v: codec.write(value as never, (inner) => pack(inner, codecs)) };
}

/** Rails' `unpack`. */
export function unpack(payload: unknown, codecs: readonly TypeCodec<never>[]): unknown {
  if (typeof payload !== "object" || payload === null || !("$" in payload)) return payload;

  const { $: code, v } = payload as { $: number; v: unknown };
  const codec = codecs.find((each) => each.code === code);

  if (codec === undefined) {
    throw new Error(
      `No codec is registered for type ${code}. A payload naming one this process does not have ` +
        `was written by a version that did — reading it as a plain object would produce a value ` +
        `that is the right shape and the wrong type.`,
    );
  }

  return codec.read(v, (inner) => unpack(inner, codecs));
}
