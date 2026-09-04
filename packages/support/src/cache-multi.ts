/**
 * Reading and writing several cache entries at once, ported from
 * `ActiveSupport::Cache::Store`'s multi operations.
 *
 * One round trip instead of N. Against a local memory store the difference is
 * nothing; against a Redis across a network it is the difference between a
 * page that renders and a page that waits — twenty keys at a millisecond each
 * is twenty milliseconds of doing nothing.
 *
 *     const found = await readMulti(cache, ["a", "b", "c"])
 *     const all = await fetchMulti(cache, ids, async (id) => await load(id))
 */

import type { CacheEntryOptions, CacheStore } from "./cache.js";

/**
 * Several keys at once. Missing ones are absent from the map rather than
 * present as null, so `has` answers the question a caller actually has.
 */
export async function readMulti<T = unknown>(
  store: CacheStore,
  keys: readonly string[],
): Promise<Map<string, T>> {
  const found = new Map<string, T>();

  // A store with its own multi-read uses it; the rest are read in parallel,
  // which is still one round trip's worth of waiting rather than N.
  const values = await Promise.all(
    keys.map(async (key) => [key, await store.read<T>(key)] as const),
  );

  for (const [key, value] of values) {
    if (value !== null && value !== undefined) found.set(key, value);
  }

  return found;
}

/** Several entries written at once. */
export async function writeMulti(
  store: CacheStore,
  entries: Record<string, unknown> | Map<string, unknown>,
  options: CacheEntryOptions = {},
): Promise<void> {
  const pairs = entries instanceof Map ? [...entries] : Object.entries(entries);

  await Promise.all(pairs.map(([key, value]) => store.write(key, value, options)));
}

/**
 * Rails' `fetch_multi`: read what is cached, compute the rest, cache those.
 *
 * The block is called only for the misses, and only once each — which is the
 * whole point, and the part a hand-written version usually gets wrong by
 * recomputing everything when one key is cold.
 */
export async function fetchMulti<T>(
  store: CacheStore,
  keys: readonly string[],
  compute: (key: string) => T | Promise<T>,
  options: CacheEntryOptions = {},
): Promise<Map<string, T>> {
  const found = await readMulti<T>(store, keys);
  const missing = keys.filter((key) => !found.has(key));

  const computed = await Promise.all(
    missing.map(async (key) => [key, await compute(key)] as const),
  );

  for (const [key, value] of computed) found.set(key, value);

  if (computed.length > 0) {
    await writeMulti(store, new Map(computed), options);
  }

  // In the order asked for, so a caller can zip the answers back against the
  // list it handed over.
  return new Map(keys.filter((key) => found.has(key)).map((key) => [key, found.get(key) as T]));
}

/**
 * Everything whose key matches. Rails' `delete_matched`.
 *
 * Needs a store that can list its keys, which a memory store can and a Redis
 * can only by scanning — so it says what it cannot do rather than silently
 * deleting nothing.
 */
export async function deleteMatched(
  store: CacheStore & { keys?(): Promise<string[]> },
  pattern: RegExp,
): Promise<number> {
  if (!store.keys) {
    throw new Error(
      "This cache cannot list its keys, so it cannot delete by pattern. Delete the keys you know about instead.",
    );
  }

  const matching = (await store.keys()).filter((key) => pattern.test(key));

  await Promise.all(matching.map((key) => store.delete(key)));

  return matching.length;
}
