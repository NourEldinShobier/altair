/**
 * A per-request memory in front of the cache store, ported from
 * `ActiveSupport::Cache::Strategy::LocalCache`.
 *
 *     await withLocalCache(cache, async () => handle(request))
 *
 * One request commonly reads the same key several times — a layout, a
 * navigation fragment, a settings blob read by three partials that do not know
 * about each other. Each read is a network round trip to Redis or Memcached,
 * and they all return the same bytes. This holds the first answer for the
 * length of the block.
 *
 * Scoped to the block rather than kept, because the whole point of a shared
 * cache is that another process can change it. Holding a value past the
 * request would turn a cache into a stale copy, and the bug that produces —
 * one process serving old data indefinitely — is far worse than the round trip
 * it saved.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { Cache, CacheEntryOptions } from "./cache.js";

/** What a local cache holds: the value, and whether the store had it at all. */
interface LocalEntry {
  value: unknown;
}

const local = new AsyncLocalStorage<Map<string, LocalEntry>>();

/** The local cache in force, if there is one. */
export function localCache(): Map<string, LocalEntry> | undefined {
  return local.getStore();
}

/** Whether reads are being memoized right now. */
export function localCacheEnabled(): boolean {
  return local.getStore() !== undefined;
}

/**
 * Runs the block with reads memoized.
 *
 * Nested calls share the outer map rather than starting a second one, so a
 * middleware wrapping a request and a job wrapping its own work do not each
 * pay for the same key.
 */
export async function withLocalCache<T>(body: () => T | Promise<T>): Promise<T> {
  const existing = local.getStore();
  if (existing) return await body();

  return await local.run(new Map<string, LocalEntry>(), body);
}

/** Forgets what the local cache holds, without ending the block. */
export function clearLocalCache(): void {
  local.getStore()?.clear();
}

/**
 * A cache whose reads are served from the local map when there is one.
 *
 * A wrapper rather than a flag inside `Cache`, so a caller that does not want
 * memoization cannot get it by accident, and so the store keeps one job.
 */
export class LocalCacheProxy {
  constructor(readonly cache: Cache) {}

  async read<T = unknown>(key: unknown): Promise<T | null> {
    const map = local.getStore();
    const expanded = expandCacheKey(key);

    if (map?.has(expanded)) return map.get(expanded)!.value as T | null;

    const value = await this.cache.read<T>(key);
    map?.set(expanded, { value });

    return value;
  }

  /**
   * Writes through, and updates the local map.
   *
   * Updated rather than invalidated, because the writer knows the new value
   * and a later read in the same request wanting it is the common case — an
   * invalidation would send that read back to the store for something it just
   * put there.
   */
  async write(key: unknown, value: unknown, options?: CacheEntryOptions): Promise<void> {
    await this.cache.write(key, value, options);
    local.getStore()?.set(expandCacheKey(key), { value });
  }

  async delete(key: unknown): Promise<boolean> {
    local.getStore()?.delete(expandCacheKey(key));

    return await this.cache.delete(key);
  }

  /**
   * Reads, or computes and writes — through the local map both ways.
   *
   * The second call in a request neither reads the store nor recomputes, which
   * is what makes this worth having over `fetch` alone.
   */
  async fetch<T>(
    key: unknown,
    compute: () => T | Promise<T>,
    options?: CacheEntryOptions,
  ): Promise<T> {
    const map = local.getStore();
    const expanded = expandCacheKey(key);

    if (map?.has(expanded)) {
      const held = map.get(expanded)!.value;
      if (held !== null) return held as T;
    }

    const value = await this.cache.fetch(key, options ?? {}, compute);
    map?.set(expanded, { value });

    return value;
  }
}

/**
 * A cache key from whatever the caller had in hand. Rails' `expand_cache_key`.
 *
 * An array is joined, an object with a `cacheKey` is asked for it, and
 * everything else is stringified. The point is that a model, a relation and a
 * plain string can all be keys without the caller building the string —
 * because a hand-built key is where the version gets left out and a stale
 * fragment survives a deploy.
 */
export function expandCacheKey(key: unknown): string {
  if (typeof key === "string") return key;
  if (key === null || key === undefined) return String(key);
  if (Array.isArray(key)) return key.map(expandCacheKey).join("/");

  const holder = key as { cacheKey?: unknown };

  if (typeof holder.cacheKey === "function") {
    return expandCacheKey((holder.cacheKey as () => unknown)());
  }

  if (typeof holder.cacheKey === "string") return holder.cacheKey;
  if (typeof key === "object") return JSON.stringify(key);

  return String(key);
}
