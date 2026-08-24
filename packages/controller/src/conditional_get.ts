/**
 * HTTP caching, ported from `ActionController::ConditionalGet`.
 *
 * The cheapest response is the one with no body:
 *
 *     async show() {
 *       const post = await Post.find(this.params.get("id"))
 *       if (this.stale({ etag: post, lastModified: post.updated_at })) {
 *         this.render.json(post)
 *       }
 *     }
 *
 * When the browser already has the current version, this answers **304** with
 * no body, and the work of rendering never happens. That is the whole point,
 * and it is why `stale` returns a boolean rather than being a decorator: the
 * saving is the render that does not run, not the bytes that are not sent.
 *
 * Weak validators (`W/"…"`) by default, as Rails does. A strong one promises
 * the bytes are identical octet for octet, which nothing that renders a
 * template can honestly promise — compression, a changed footer, a different
 * locale all break it. Weak promises only that it is the same *content*, which
 * is what a cache actually needs to know.
 */

import { CryptoHasher } from "bun";

/** Something with a cache key. Rails' `cache_key_with_version`. */
export interface Cacheable {
  cacheKey?: () => string;
  id?: unknown;
  updated_at?: unknown;
}

export type EtagSource = string | number | Cacheable | readonly unknown[] | null | undefined;

export interface FreshnessOptions {
  /** What identifies this version. A record, a list of them, or a string. */
  etag?: EtagSource;
  lastModified?: Date | string | number | null;
  /** Rails' `public: true`: shared caches may store it too. */
  public?: boolean;
  /** Seconds. Sets `max-age`. */
  expiresIn?: number;
  /** Rails' `no-store`, for anything a cache must never keep. */
  noStore?: boolean;
}

/**
 * A stable string for anything an etag can be built from.
 *
 * A record's own `cacheKey` wins, because a model knows what makes it a
 * version — Rails' `posts/1-20260815120000`. Falling back to `id` alone would
 * produce an etag that never changes when the record does, which is worse than
 * no etag at all: the browser would keep a stale page forever.
 */
export function etagSource(value: EtagSource): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map((item) => etagSource(item as EtagSource)).join("/");

  const record = value as Cacheable;
  if (typeof record.cacheKey === "function") return record.cacheKey();

  const stamp = record.updated_at;
  const version = stamp instanceof Date ? stamp.toISOString() : String(stamp ?? "");

  return `${String(record.id ?? "")}-${version}`;
}

/** The header value, quoted and marked weak. */
export function etagFor(value: EtagSource, weak = true): string {
  const digest = new CryptoHasher("sha256").update(etagSource(value)).digest("hex").slice(0, 32);
  return weak ? `W/"${digest}"` : `"${digest}"`;
}

/**
 * Whether an `If-None-Match` header names this etag.
 *
 * `*` matches anything, which is what a conditional PUT uses to mean "only if
 * it exists". The weak prefix is stripped from both sides before comparing:
 * RFC 9110 says a conditional GET uses weak comparison, so `W/"x"` and `"x"`
 * are a match here even though they are not for a range request.
 */
export function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;

  const strip = (value: string) => value.trim().replace(/^W\//, "");

  return header.split(",").some((candidate) => strip(candidate) === strip(etag));
}

function asDate(value: Date | string | number | null | undefined): Date | undefined {
  if (value === null || value === undefined) return undefined;

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Whether `If-Modified-Since` says the client is current.
 *
 * Compared at second precision, because that is all the header carries. A
 * millisecond comparison would make every request stale by a fraction and
 * silently disable the whole mechanism.
 */
export function notModifiedSince(header: string | null, lastModified: Date): boolean {
  if (!header) return false;

  const since = asDate(header);
  if (!since) return false;

  return Math.floor(lastModified.getTime() / 1000) <= Math.floor(since.getTime() / 1000);
}

/** Builds the `Cache-Control` value Rails would. */
export function cacheControl(options: FreshnessOptions): string {
  if (options.noStore) return "no-store";

  const directives = [options.public ? "public" : "private"];

  if (options.expiresIn === undefined) directives.push("no-cache");
  else directives.push(`max-age=${Math.max(0, Math.floor(options.expiresIn))}`);

  return directives.join(", ");
}

export interface Freshness {
  /** Whether the client already has this version. */
  fresh: boolean;
  headers: Record<string, string>;
}

/**
 * Works out the validators and whether the request is already fresh.
 *
 * Exported on its own so something that is not a controller — a middleware, a
 * hand-written route — can use the same rules.
 */
export function freshnessFor(request: Request, options: FreshnessOptions): Freshness {
  const headers: Record<string, string> = { "cache-control": cacheControl(options) };

  const etag = options.etag === undefined ? undefined : etagFor(options.etag);
  if (etag) headers.etag = etag;

  const lastModified = asDate(options.lastModified);
  if (lastModified) headers["last-modified"] = lastModified.toUTCString();

  // Nothing to validate against means nothing can be fresh. Answering 304 for
  // a request that sent no validators would return an empty body for a page
  // the browser has never seen.
  if (!etag && !lastModified) return { fresh: false, headers };

  // Rails checks the etag first and, when one is present, lets it decide
  // alone. An etag is exact where a timestamp is a second-resolution guess, so
  // a request carrying both should be judged by the better of the two.
  const noneMatch = request.headers.get("if-none-match");
  if (etag && noneMatch !== null) {
    return { fresh: etagMatches(noneMatch, etag), headers };
  }

  if (lastModified) {
    return {
      fresh: notModifiedSince(request.headers.get("if-modified-since"), lastModified),
      headers,
    };
  }

  return { fresh: false, headers };
}

/**
 * The headers a 304 may carry.
 *
 * RFC 9110 says a 304 sends the headers that would have gone with a 200 minus
 * the ones describing a body. Sending `content-type` with no body is what
 * makes some proxies cache an empty response as the real one.
 */
export function notModified(headers: Record<string, string>): Response {
  return new Response(null, { status: 304, headers });
}
