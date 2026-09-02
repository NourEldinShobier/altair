/**
 * Digests for cache keys and fingerprints, ported from
 * `ActiveSupport::Digest`.
 *
 * Deliberately not for passwords or signatures. These are fast hashes, which
 * is what a cache key wants and precisely what a password does not — the
 * property that makes a digest cheap to compute a million times is the same
 * one that makes it cheap to guess a million times. Passwords go through the
 * password hashing in secure_password; signatures through the message
 * verifier.
 */

import { createHash } from "node:crypto";
import { UUID_NAMESPACES, uuidV5 } from "./misc.js";

/** Which algorithm the digests use. Rails' `hash_digest_class`. */
let algorithm = "sha256";

export function setHashDigestAlgorithm(name: string): void {
  // Checked here rather than at first use, so a bad name fails at
  // configuration time with the line that set it, not on a request.
  createHash(name);
  algorithm = name;
}

export function hashDigestAlgorithm(): string {
  return algorithm;
}

/**
 * A digest of some text. Rails' `Digest.hexdigest`.
 *
 * Truncated to 32 characters, as Rails truncates it, because a cache key is
 * read by people and compared by machines: 64 hex characters is no less
 * collision-proof in practice and makes every log line harder to scan.
 */
export function hexdigest(value: string, length = 32): string {
  return createHash(algorithm).update(value).digest("hex").slice(0, length);
}

/**
 * A digest of anything, by way of a stable serialization.
 *
 * Object keys are sorted before hashing, or two objects that mean the same
 * thing produce different digests depending on the order they happened to be
 * built in — which turns a cache key into a cache miss on every other request.
 */
export function digestOf(value: unknown, length = 32): string {
  return hexdigest(stableJson(value), length);
}

function stableJson(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;

  if (typeof value === "object") {
    if (value instanceof Date) return value.toISOString();

    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, one]) => `${JSON.stringify(key)}:${stableJson(one)}`);

    return `{${entries.join(",")}}`;
  }

  return JSON.stringify(value);
}

/**
 * A uuid derived from a value rather than randomly. Rails' `uuid_from_hash`.
 *
 * The derivation lives in `misc.ts` as `uuidV5`, and this is the one-argument
 * form of it: a name under the OID namespace, which is what Rails' fixtures
 * use. Two derivations of one idea is how the fixture ids stopped matching
 * Rails' — this one hashed the name alone and ignored the namespace entirely,
 * so it agreed with nothing, including itself under another name.
 */
export function uuidFromHash(name: string, namespace: string = UUID_NAMESPACES.oid): string {
  return uuidV5(namespace, name);
}
