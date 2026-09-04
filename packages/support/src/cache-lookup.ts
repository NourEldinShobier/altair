/**
 * Choosing a cache store, and deciding what is worth compressing. Ported from
 * `ActiveSupport::Cache.lookup_store`, `Store#fetch` and the compression path
 * in `Cache::Entry`.
 *
 * `cache.ts` has the stores and `cache-entry.ts` has the entries. What sits
 * between them is the set of decisions an application makes once, and the two
 * that matter are both about *not* doing something.
 *
 * **Not compressing everything.** Compression trades processor time for
 * bandwidth and memory, and below a few hundred bytes the trade is a loss: the
 * compressed form is often larger, and it costs a round of deflate on every
 * read and every write. The threshold is what makes compression a saving
 * rather than a tax on a cache full of short strings.
 *
 * **Not stampeding.** When a popular entry expires, every request that wanted
 * it misses at the same moment and every one of them recomputes it. The
 * expensive query that the cache existed to avoid then runs a hundred times at
 * once, on a database that is already the reason for the cache. Serving the
 * stale value to all but one of them is the fix, and it needs the entry to
 * carry its own version so "stale" can be told from "gone".
 */

import { deflateSync, inflateSync } from "node:zlib";
import type { Cache, CacheStore } from "./cache.js";

/** How a named store is built. */
export type StoreBuilder = (options: Record<string, unknown>) => CacheStore;

const stores = new Map<string, StoreBuilder>();

export function registerStore(name: string, build: StoreBuilder): void {
  stores.set(name.toLowerCase(), build);
}

export function storeNames(): string[] {
  return Array.from(stores.keys()).sort();
}

export class UnknownStore extends Error {
  constructor(name: string, known: readonly string[]) {
    super(
      `No cache store called "${name}". Registered: ${known.join(", ") || "none"}. ` +
        `A misspelled store must not silently fall back to one that discards everything.`,
    );
    this.name = "UnknownStore";
  }
}

/**
 * Builds the store an application asked for. Rails' `lookup_store`.
 *
 * Throws rather than falling back to a null store. A cache that silently
 * discards everything looks exactly like a cache with a very low hit rate,
 * which is a performance problem nobody traces back to a typo in a config
 * file.
 */
export function lookupStore(name: string, options: Record<string, unknown> = {}): CacheStore {
  const build = stores.get(name.toLowerCase());

  if (!build) throw new UnknownStore(name, storeNames());

  return build(options);
}

/** Rails' `build_mem_cache_store` — the in-process one, by name. */
export function buildMemCache(
  build: StoreBuilder,
  options: Record<string, unknown> = {},
): CacheStore {
  return build(options);
}

export function resetStores(): void {
  stores.clear();
}

/** Below this many bytes, compressing costs more than it saves. */
export const COMPRESS_THRESHOLD = 1024;

export interface CompressionResult {
  value: Uint8Array | string;
  compressed: boolean;
}

/**
 * Compresses a value if it is worth it. Rails' `try_compress`.
 *
 * Two checks, not one. Size first, because deflate on a short string is a
 * round of work for nothing — and then the result is kept only if it is
 * actually smaller, because already-compressed content (an image, a gzipped
 * payload, anything random) comes out *larger* and storing that would make the
 * cache both slower and bigger.
 */
export function tryCompress(value: string, threshold = COMPRESS_THRESHOLD): CompressionResult {
  const bytes = Buffer.from(value, "utf8");

  if (bytes.length < threshold) return { value, compressed: false };

  const compressed = deflateSync(bytes);

  return compressed.length < bytes.length
    ? { value: new Uint8Array(compressed), compressed: true }
    : { value, compressed: false };
}

/** The other direction. Rails' `uncompress`. */
export function dumpCompressed(result: CompressionResult): string {
  if (!result.compressed) return String(result.value);

  return inflateSync(Buffer.from(result.value as Uint8Array)).toString("utf8");
}

/**
 * Whether a store can tell one version of an entry from another. Rails'
 * `supports_cache_versioning?`.
 *
 * Worth asking, because the answer decides whether `fetch` can serve a stale
 * value while one caller recomputes. A store that cannot version has to treat
 * expired as gone, and then a popular key stampedes.
 */
export function supportsCacheVersioning(store: CacheStore): boolean {
  return typeof (store as { read?: unknown }).read === "function";
}

/** What a `fetch` did, so a caller can log or count it. */
export type FetchOutcome = "hit" | "miss" | "stale";

export interface FetchResult<T> {
  value: T;
  outcome: FetchOutcome;
}

/** An entry as this layer stores it: the value, and when it stops being fresh. */
interface Versioned<T> {
  value: T;
  freshUntil: number;
  /** How long past `freshUntil` the value may still be served while recomputing. */
  graceMs: number;
}

/**
 * Keys currently being recomputed, so only one caller does it.
 *
 * shared-block-state: deduplicating across callers is what this is for, so
 * per-caller state would defeat it — a scoped set would let every caller
 * believe it was the only one and recompute in parallel, which is the
 * stampede the whole entry exists to prevent. The `delete` in the `finally`
 * releases this caller's own key rather than restoring a saved value.
 */
const recomputing = new Set<string>();

export interface FetchOptions {
  expiresInMs?: number;
  /** How long a stale value may be served while one caller refreshes it. */
  staleWhileRevalidateMs?: number;
  /** Recompute even on a hit. */
  forceMiss?: boolean;
}

/**
 * Reads, or computes and stores. Rails' `fetch` with `race_condition_ttl`.
 *
 * The interesting path is the third one. On a plain hit it returns the value;
 * on a plain miss it computes. Between them is *stale*: the entry has expired
 * but is still within its grace window, and something else is already
 * recomputing it. Those callers get the old value immediately rather than
 * queueing behind the same expensive query — which is the difference between
 * one slow request and a hundred.
 */
export async function fetchEntry<T>(
  cache: Cache | CacheStore,
  key: string,
  compute: () => Promise<T>,
  options: FetchOptions = {},
  now: number = Date.now(),
): Promise<FetchResult<T>> {
  const held = (await (cache as CacheStore).read(key)) as Versioned<T> | null | undefined;

  if (held && !options.forceMiss && now < held.freshUntil) {
    return { value: held.value, outcome: "hit" };
  }

  const grace = held ? held.freshUntil + held.graceMs : 0;
  const withinGrace = held !== null && held !== undefined && now < grace;

  // Somebody else is already recomputing and the value is still servable, so
  // hand it over rather than joining the queue for the same query.
  if (withinGrace && recomputing.has(key) && !options.forceMiss) {
    return { value: held.value, outcome: "stale" };
  }

  recomputing.add(key);

  try {
    const value = await compute();
    const expiresIn = options.expiresInMs ?? 60_000;

    await (cache as CacheStore).write(key, {
      value,
      freshUntil: now + expiresIn,
      graceMs: options.staleWhileRevalidateMs ?? 0,
    } satisfies Versioned<T>);

    return { value, outcome: held ? "stale" : "miss" };
  } finally {
    // In a `finally`, or a computation that throws leaves the key marked
    // forever and every later caller is served a stale value that never
    // refreshes.
    recomputing.delete(key);
  }
}

/** Whether a key is being recomputed right now. */
export function isRecomputing(key: string): boolean {
  return recomputing.has(key);
}

export function clearRecomputing(): void {
  recomputing.clear();
}

/**
 * Writes only if nothing is there. Rails' `write` with `unless_exist`.
 *
 * Reads once and writes — which is *not* atomic, and saying so matters because
 * the usual reason to want this is as a lock. Two callers that both read
 * "nothing there" before either writes will both be told they won it. It is a
 * real lock only over a store whose backend offers an atomic add (Redis' `SET
 * NX`, memcached's `add`), and this signature is the seam for that; over a
 * plain read-then-write store it is a best-effort de-duplication and should be
 * used as one.
 */
export async function storeIfAbsent<T>(store: CacheStore, key: string, value: T): Promise<boolean> {
  if ((await store.read(key)) != null) return false;

  await store.write(key, value);

  return true;
}

/**
 * A per-process cache for one unit of work. Rails' `new_local_cache` and
 * `unset_local_cache`.
 *
 * `cache-local.ts` already owns the store and the `withLocalCache` wrapper;
 * what was missing are the two halves on their own, which a framework that
 * opens and closes a request in different places needs.
 *
 * Dropping it at the end of a request is not optional: one that outlives its
 * request serves one user's data to the next, which is the worst failure in
 * this file and the quietest.
 */
export function newLocalCache(): Map<string, unknown> {
  const cache = new Map<string, unknown>();
  held = cache;

  return cache;
}

let held: Map<string, unknown> | undefined;

export function currentLocalCache(): Map<string, unknown> | undefined {
  return held;
}

export function unsetLocalCache(): void {
  held = undefined;
}

/** A value remembered against an object rather than a key. Rails' `cache_for`. */
const perObject = new WeakMap<object, Map<string, unknown>>();

export function cacheFor(owner: object, key: string): unknown {
  return perObject.get(owner)?.get(key);
}

export function setCacheFor(owner: object, key: string, value: unknown): void {
  const held = perObject.get(owner);

  if (held) held.set(key, value);
  else perObject.set(owner, new Map([[key, value]]));
}

/**
 * Remembers what a function returned for an object. Rails'
 * `define_cached_method`.
 *
 * Against the object rather than in a module-level map, so the entry goes when
 * the object does. A module-level cache keyed on a record is a leak that grows
 * with traffic and is never collected.
 */
export function defineCachedMethod<T>(owner: object, key: string, compute: () => T): T {
  const held = cacheFor(owner, key);

  if (held !== undefined) return held as T;

  const value = compute();
  setCacheFor(owner, key, value);

  return value;
}
