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
 * **Do not cache anything that differs per person.** A fragment is stored
 * under its key and served to everyone who asks for that key, so a CSRF token,
 * a "welcome back, Ada", or a delete button that only admins see will be
 * handed to whoever arrives next. Rails has the same footgun and the same
 * answer: put the per-person part outside the block.
 */

import { Cache, type CacheEntryOptions } from "@altair/support";
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

  const html = await cache.fetch(["views", on], options, async () => {
    return await renderToString(children ?? null);
  });

  return new RawHtml(typeof html === "string" ? html : String(html));
}
