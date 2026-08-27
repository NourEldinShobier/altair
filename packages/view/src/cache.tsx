/**
 * Fragment caching, ported from ActionView's `cache` helper.
 *
 *     <Cached on={post}>
 *       <PostCard post={post} />
 *     </Cached>
 *
 * The last piece of the caching arc. A record's `cacheKey` carries its
 * `updated_at`, so the key changes the moment the record does and a stale
 * fragment expires by becoming unreachable rather than by being swept. `touch:
 * true` on a child association is what keeps that honest when the thing that
 * changed was a comment rather than the post.
 *
 * Nesting is the point, and is why Rails calls it Russian-doll caching:
 *
 *     <Cached on={board}>
 *       {posts.map((post) => (
 *         <Cached on={post} key={post.id}>…</Cached>
 *       ))}
 *     </Cached>
 *
 * Editing one post invalidates that post's fragment and — through `touch` —
 * the board's, while every sibling fragment is reused. Rebuilding the outer
 * shell is then cheap, because the expensive parts of it are themselves hits.
 *
 * The current locale is part of every key, so a fragment rendered in one
 * language is never served in another. That is one axis the framework knows
 * about and can handle; the rest it cannot.
 *
 * **Do not cache anything that differs per person.** A fragment is stored
 * under its key and served to everyone who asks for that key, so a CSRF token,
 * a "welcome back, Ada", or a delete button that only admins see will be
 * handed to whoever arrives next. Rails has the same footgun and the same
 * answer: put the per-person part outside the block.
 */

import { Cache, deleteMatched, i18n, type CacheEntryOptions } from "@altair/support";
import { RawHtml, renderToString, type Node } from "./render.js";

let configured: Cache | undefined;

/**
 * The cache fragments are stored in.
 *
 * Defaults to a fresh in-process one, which is right for development and for
 * tests and wrong for more than one server — the same caveat as Rails'
 * MemoryStore.
 */
export function fragmentCache(): Cache {
  configured ??= new Cache();
  return configured;
}

export function configureFragmentCache(cache: Cache | undefined): void {
  configured = cache;
}

/**
 * The key a fragment is stored under. Rails' `fragment_cache_key`.
 *
 * Public because everything below needs the same one: an `expireFragment` that
 * builds the key a different way from `Cached` deletes nothing and reports
 * success, which is the worst kind of cache bug — it looks like it worked.
 */
export function fragmentCacheKey(on: unknown): unknown[] {
  return ["views", i18n.locale, on];
}

/** A fragment already rendered, or null. Rails' `read_fragment`. */
export async function readFragment(on: unknown): Promise<string | null> {
  return await fragmentCache().read<string>(fragmentCacheKey(on));
}

/**
 * Stores a fragment directly. Rails' `write_fragment`.
 *
 * For the rare case of warming a cache — rendering the expensive fragments
 * after a deploy rather than making the first visitor pay for them.
 */
export async function writeFragment(
  on: unknown,
  html: string,
  options: CacheEntryOptions = {},
): Promise<void> {
  await fragmentCache().write(fragmentCacheKey(on), html, options);
}

/** Whether a fragment is already there. Rails' `exist_fragment?`. */
export async function existFragment(on: unknown): Promise<boolean> {
  return await fragmentCache().exists(fragmentCacheKey(on));
}

/**
 * Throws a fragment away. Rails' `expire_fragment`.
 *
 * A key expires by becoming unreachable most of the time — that is what the
 * record's `cacheKey` is for. This is for the fragments whose key does not
 * move: a sidebar keyed on nothing in particular, a footer with a count in it.
 *
 * A `RegExp` sweeps several, and only against a store that can list its keys.
 */
export async function expireFragment(on: unknown | RegExp): Promise<boolean | number> {
  const cache = fragmentCache();

  if (on instanceof RegExp) return await deleteMatched(cache.store, on);

  return await cache.delete(fragmentCacheKey(on));
}

export interface CachedProps extends CacheEntryOptions {
  /**
   * What the fragment is keyed on. A record names itself through `cacheKey`;
   * an array becomes a path, so `[post, "sidebar"]` distinguishes two
   * fragments about the same record.
   */
  on: unknown;
  /**
   * Skips the cache entirely, without moving the block. Useful for the request
   * where an editor should see their own unsaved change.
   */
  skip?: boolean;
  children?: Node;
}

/**
 * Renders its children once and reuses the HTML.
 *
 * The stored value is the rendered string, already escaped — escaping happened
 * when the fragment was built, so nothing is trusted on the way back out that
 * was not trusted on the way in.
 */
export async function Cached(props: CachedProps): Promise<Node> {
  const { on, skip, children, ...options } = props;

  if (skip) return children ?? null;

  const cache = fragmentCache();

  // The locale is part of the key, always. A fragment rendered in English and
  // stored under the record alone is handed to the next French reader, and
  // nothing about that failure looks like a bug until somebody reports the
  // wrong language. Rails leaves this to the application and it is a
  // well-worn way to lose an afternoon; the framework ships i18n, so the
  // framework can pay the one extra path segment.
  const html = await cache.fetch(fragmentCacheKey(on), options, async () => {
    return await renderToString(children ?? null);
  });

  return new RawHtml(typeof html === "string" ? html : String(html));
}
