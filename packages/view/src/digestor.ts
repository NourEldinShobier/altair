/**
 * What a cached fragment's key depends on. Ported from `ActionView::Digestor`
 * and the `cache` helper's key construction.
 *
 * `cache.tsx` can store a rendered fragment under a key made from the records
 * it shows. That handles the data changing. It does not handle the *template*
 * changing, and that is the failure everybody has met:
 *
 *     you edit `_post.html.erb`, deploy, and every page still shows the old
 *     markup — because the cache key is `posts/1-20260830` either way, the
 *     record has not been touched, and nothing knows the template moved.
 *
 * The fix is to fold a digest of the template into the key. Rails computes it
 * over the template's source *and* over every template it renders, so editing
 * a partial three levels down changes the key of everything above it. That
 * recursion is the whole feature: a digest of one template alone leaves the
 * caller's cache stale, which is the same bug one level up.
 *
 * The dependency graph is explicit here rather than parsed out of the source.
 * Rails scrapes `render` calls from ERB with a regular expression and admits
 * it is a heuristic; a component tree can be declared, and a declared edge
 * that is wrong is a bug somebody can see.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { createHash } from "node:crypto";

/** How to find what a template renders, so the digest can recurse. */
export type DependencyTracker = (name: string) => string[];

const trackers = new Map<string, DependencyTracker>();

/** Rails' `register_tracker`. */
export function registerTracker(handler: string, tracker: DependencyTracker): void {
  trackers.set(handler, tracker);
}

/** Rails' `remove_tracker`. */
export function removeTracker(handler: string): boolean {
  return trackers.delete(handler);
}

/**
 * What a template renders. Rails' `find_dependencies`.
 *
 * Every registered tracker, because one template can be reached more than one
 * way — a component and the partial it wraps — and missing either leaves a
 * stale cache under the other.
 */
export function findDependencies(name: string): string[] {
  const found = new Set<string>();

  for (const tracker of trackers.values()) {
    for (const dependency of tracker(name)) found.add(dependency);
  }

  return Array.from(found);
}

/** Digests computed so far, so a template rendered fifty times is hashed once. */
const digests = new Map<string, string>();

/** The cache a `withEmptyTemplateCache` block reads and writes instead. */
const empty = new AsyncLocalStorage<Map<string, string>>();

/** The cache in force here: a block's if there is one, the process's if not. */
function cache(): Map<string, string> {
  return empty.getStore() ?? digests;
}

export function digestCache(): Map<string, string> {
  return cache();
}

/** Rails' `digest_caches`, for a report of what has been computed. */
export function digestCaches(): Record<string, string> {
  return Object.fromEntries(cache());
}

export function clearCache(): void {
  digests.clear();
  trackers.clear();
  uncacheableNames.clear();
}

/**
 * Whether digests are kept between calls. Rails' `cache_template_loading`.
 *
 * On in production, where templates cannot change under a running process.
 * Off in development, where they do — and a digest cached across an edit is
 * exactly the staleness this exists to prevent.
 */
let caching = true;

export function cacheTemplateLoading(): boolean {
  return caching;
}

export function trackCaching(enabled: boolean): void {
  caching = enabled;

  if (!enabled) digests.clear();
}

/** Runs something with no digests remembered. Rails' `with_empty_template_cache`. */
export function withEmptyTemplateCache<T>(body: () => T): T {
  // An empty cache of its own rather than emptying the shared one. Clearing
  // and refilling made every concurrent render miss the cache for the length
  // of the block, and threw away whatever those renders had computed in the
  // meantime — so the block's own promise, that nothing is remembered, held
  // for everybody instead of for the block.
  return empty.run(new Map(), body);
}

/** Templates whose content cannot be digested, so nothing above them is cached. */
const uncacheableNames = new Set<string>();

/**
 * Marks a template as one whose output must never be cached. Rails'
 * `uncacheable!`.
 *
 * For a template that reads something the key cannot describe — the current
 * time, a random sample, a per-request flag. Caching it serves one user's
 * result to everybody.
 */
export function markUncacheable(name: string): void {
  uncacheableNames.add(name);
}

/**
 * Whether a template — or anything it renders — must not be cached. Rails'
 * `uncacheable?`.
 *
 * Recursive for the same reason the digest is: a page that renders an
 * uncacheable partial cannot itself be cached, and checking only the top
 * template is how the uncacheable thing gets cached anyway.
 */
export function uncacheable(name: string, seen: Set<string> = new Set()): boolean {
  if (uncacheableNames.has(name)) return true;
  if (seen.has(name)) return false;

  seen.add(name);

  return findDependencies(name).some((dependency) => uncacheable(dependency, seen));
}

export interface DigestOptions {
  /** The template's own source, or whatever stands for it. */
  source: string;
  /** What it renders, if the trackers do not know. */
  dependencies?: readonly string[];
}

const sources = new Map<string, string>();

/** Records what a template's content is, so its digest can be computed. */
export function registerTemplateSource(name: string, source: string): void {
  sources.set(name, source);

  if (!caching) cache().delete(name);
}

export function digestPathFromTemplate(name: string): string {
  return name.replace(/^\/+/, "").replace(/\.[^./]+$/, "");
}

/**
 * The digest of a template and everything it renders. Rails' `Digestor.digest`.
 *
 * A cycle contributes its name and stops. Two components that render each
 * other is unusual and legal, and recursing forever on it would hang the
 * render rather than report anything.
 */
export function dependencyDigest(name: string, seen: Set<string> = new Set()): string {
  // No `caching` check here: nothing is ever stored while caching is off —
  // `trackCaching(false)` clears the map and `registerTemplateSource` drops
  // any entry — so a hit is only possible when caching is on.
  const held = cache().get(name);

  if (held !== undefined) return held;
  if (seen.has(name)) return shortHash(`cycle:${name}`);

  seen.add(name);

  const source = sources.get(name) ?? "";
  const dependencies = findDependencies(name).sort();
  const parts = [
    digestPathFromTemplate(name),
    source,
    ...dependencies.map((dependency) => dependencyDigest(dependency, seen)),
  ];

  const digest = shortHash(parts.join(""));

  if (caching) cache().set(name, digest);

  return digest;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

/**
 * The key a cached fragment is stored under. Rails' `cache_fragment_name`.
 *
 * The digest goes in the key rather than beside it, so a template edit
 * produces a different key rather than overwriting the old entry. The old one
 * then expires on its own, and a rollback finds its own cache still there
 * instead of the new deploy's.
 */
export function cacheFragmentName(
  name: string,
  key: readonly unknown[],
  options: { skipDigest?: boolean } = {},
): string {
  const parts = key.map((each) => String(each));

  if (options.skipDigest === true) return [name, ...parts].join("/");

  return [name, ...parts, dependencyDigest(name)].join("/");
}

/** How many fragments were served from the cache, for a log line. */
let hits = 0;

export function cacheHits(): number {
  return hits;
}

export function recordCacheHit(): void {
  hits += 1;
}

export function resetCacheHits(): void {
  hits = 0;
}

/**
 * Caches only when a condition holds. Rails' `cache_if`.
 *
 * Returns whether to cache rather than doing it, so the caller keeps one path
 * through the render — a helper that sometimes caches and sometimes calls
 * through is two code paths that diverge.
 */
export function cacheIf(condition: boolean, name: string): boolean {
  return condition && !uncacheable(name);
}

/** Rails' `cache_unless`. */
export function cacheUnless(condition: boolean, name: string): boolean {
  return cacheIf(!condition, name);
}

/** Whether caching is on at all. Rails' `disable_cache` inverted. */
let disabled = false;

export function disableCache<T>(body: () => T): T {
  const held = disabled;
  disabled = true;

  try {
    return body();
  } finally {
    disabled = held;
  }
}

export function cacheDisabled(): boolean {
  return disabled;
}

/** Forgets the recorded sources too, for a test that declared its own. */
export function resetDigestor(): void {
  clearCache();
  sources.clear();
  caching = true;
  disabled = false;
  hits = 0;
}
