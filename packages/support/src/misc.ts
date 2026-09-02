/**
 * The small ActiveSupport utilities that have no better home.
 *
 * Byte and number formatting, uuids, string inquirers, and the `try` that
 * makes a possibly-missing object safe to ask. Each is a few lines and each is
 * something an application otherwise writes badly once per project.
 */

/** Bytes in a kilobyte and upwards, as Rails counts them: 1024, not 1000. */
export const kilobytes = (count = 1): number => count * 1024;
export const megabytes = (count = 1): number => kilobytes(count) * 1024;
export const gigabytes = (count = 1): number => megabytes(count) * 1024;
export const terabytes = (count = 1): number => gigabytes(count) * 1024;
export const petabytes = (count = 1): number => terabytes(count) * 1024;
export const exabytes = (count = 1): number => petabytes(count) * 1024;

/**
 * A string that answers questions about itself. Rails' `StringInquirer`.
 *
 *     const env = inquiry("production")
 *     env.production   // true
 *     env.development  // false
 *
 * What makes `Rails.env.production?` read the way it does, and better than
 * comparing to a literal in nine places — a typo in a comparison is silently
 * false, and a typo here is too, which is why the known values can be given.
 */
export function inquiry<K extends string>(
  value: string,
  known?: readonly K[],
): string & Record<K, boolean> {
  // A boxed string, so the proxy has something with `length` and `toString` on
  // it to fall through to. The wrapper is the point here rather than a mistake.
  const boxed = Object(value) as Record<string | symbol, unknown>;

  return new Proxy(boxed, {
    get(target, property: string | symbol) {
      if (typeof property !== "string" || property in target) {
        const found = Reflect.get(target, property) as unknown;

        // Bound to the String rather than handed out bare: `String(env)` calls
        // `toString` through the proxy, and an unbound one gets the proxy as
        // `this`, which is not a String and throws.
        return typeof found === "function" ? found.bind(target) : found;
      }

      // A name that was never a possible value is a typo, and answering false
      // hides it. Only checked when the caller said what the values are.
      if (known && !known.includes(property as K)) {
        throw new Error(`"${property}" is not one of: ${known.join(", ")}.`);
      }

      return value === property;
    },
  }) as string & Record<K, boolean>;
}

/**
 * Calls a method if there is anything to call it on. Rails' `try`.
 *
 * JavaScript has `?.` for the common case; this is for the one it does not
 * cover — a name held in a variable.
 */
export function tryCall<T>(
  value: T | null | undefined,
  method: string,
  ...args: unknown[]
): unknown {
  if (value === null || value === undefined) return undefined;

  const fn = (value as Record<string, unknown>)[method];

  return typeof fn === "function"
    ? (fn as (...a: unknown[]) => unknown).apply(value, args)
    : undefined;
}

/** A v4 uuid, from the platform's own generator. */
export function uuidV4(): string {
  return crypto.randomUUID();
}

/** The uuid that means "none". Rails' `Digest::UUID.nil_uuid`. */
export function nilUuid(): string {
  return "00000000-0000-0000-0000-000000000000";
}

/** The namespaces Rails names, for a uuid derived from one. */
export const UUID_NAMESPACES = {
  dns: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
  url: "6ba7b811-9dad-11d1-80b4-00c04fd430c8",
  oid: "6ba7b812-9dad-11d1-80b4-00c04fd430c8",
  x500: "6ba7b814-9dad-11d1-80b4-00c04fd430c8",
} as const;

/**
 * A uuid derived from a name rather than from randomness. Rails' `uuid_v5`.
 *
 * The same namespace and name always give the same uuid, which is the point:
 * an id for an external record that needs no table to remember it.
 */
export function uuidV5(namespace: string, name: string): string {
  return derivedUuid(namespace, name, "sha1", 5);
}

/** The older, weaker version of the same idea. Rails has it, so this does. */
export function uuidV3(namespace: string, name: string): string {
  return derivedUuid(namespace, name, "md5", 3);
}

/**
 * Rails' `pack_uuid_namespace` — a namespace uuid as the sixteen bytes hashed.
 *
 * The *bytes*, not the text. Hashing the dashed string instead gives a uuid
 * that is stable, plausible, and different from what every other RFC 4122
 * implementation derives — so it agrees with itself and with nothing else,
 * which is found out when something has to interoperate.
 *
 * A namespace that is not a uuid is refused rather than read as far as it
 * parses. Parsed leniently, a typo produces zero bytes where the hex was
 * unreadable, and the result is a uuid that is wrong in a way nothing can see:
 * still stable, still the right shape, derived from a namespace nobody chose.
 */
export function packUuidNamespace(namespace: string): Uint8Array {
  const hex = namespace.replaceAll("-", "");

  if (!/^[0-9a-f]{32}$/i.test(hex)) {
    throw new TypeError(
      `Only uuids are valid namespace identifiers, got ${JSON.stringify(namespace)}.`,
    );
  }

  const bytes = new Uint8Array(16);

  for (let index = 0; index < 16; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }

  return bytes;
}

function derivedUuid(namespace: string, name: string, algorithm: string, version: number): string {
  const bytes = packUuidNamespace(namespace);

  const digest = new Uint8Array(
    new Bun.CryptoHasher(algorithm as "sha1")
      .update(bytes)
      .update(new TextEncoder().encode(name))
      .digest(),
  );

  const out = digest.slice(0, 16);

  // The version goes in the top nibble of byte 6 and the variant in byte 8,
  // which is what makes it a uuid rather than sixteen bytes of hash.
  out[6] = ((out[6] as number) & 0x0f) | (version << 4);
  out[8] = ((out[8] as number) & 0x3f) | 0x80;

  const text = [...out].map((byte) => byte.toString(16).padStart(2, "0")).join("");

  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}

/**
 * Compares two strings without giving away where they differ.
 *
 * A normal comparison stops at the first difference, so how long it took says
 * how much of the secret was right. Rails' `secure_compare`.
 */
export function secureCompare(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);

  // Lengths differ: hash both so the comparison is still fixed-time, rather
  // than returning early and leaking the length.
  if (a.length !== b.length) {
    return fixedLengthSecureCompare(
      new Bun.CryptoHasher("sha256").update(a).digest(),
      new Bun.CryptoHasher("sha256").update(b).digest(),
    );
  }

  return fixedLengthSecureCompare(a, b);
}

/** The same, for two values already known to be the same length. */
export function fixedLengthSecureCompare(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;

  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] as number) ^ (right[index] as number);
  }

  return difference === 0;
}

/** Whitespace collapsed and trimmed. Rails' `squish`. */
export function squish(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/** Every line indented. Rails' `indent`. */
export function indent(value: string, amount: number, by = " "): string {
  const padding = by.repeat(amount);

  return value.replace(/^(?!$)/gm, padding);
}

/** Cut to a number of bytes rather than characters, without splitting one. */
export function truncateBytes(value: string, limit: number, omission = "…"): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).length <= limit) return value;

  const room = limit - encoder.encode(omission).length;
  let cut = "";

  for (const character of value) {
    if (encoder.encode(cut + character).length > room) break;
    cut += character;
  }

  return cut + omission;
}
