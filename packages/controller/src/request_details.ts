/**
 * The parts of a request that take parsing before they answer a question.
 *
 * The neighbouring [request_info.ts](./request_info.ts) reads what is already
 * a value — the host, the format, the address. These are the headers whose
 * contents are a small grammar of their own: Cache-Control, If-None-Match, and
 * the method, whose meaning is a classification rather than a string.
 */

/**
 * Methods that only read. RFC 9110 calls these safe.
 *
 * The classification is what CSRF protection and caching both branch on, and
 * spelling it out beats the comparison written inline in each: a check that
 * forgets TRACE is not obviously wrong when you read it.
 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS", "TRACE"]);

/**
 * Methods that can be repeated without repeating their effect.
 *
 * PUT and DELETE join the safe ones. POST and PATCH do not, which is why a
 * retry on a flaky connection can charge a card twice.
 */
const IDEMPOTENT_METHODS = new Set([...SAFE_METHODS, "PUT", "DELETE"]);

/** Rails' `request_method`, normalised to upper case. */
export function requestMethod(request: Request): string {
  return request.method.toUpperCase();
}

/** Whether this method only reads. Rails' `safe_method?`. */
export function safeMethod(request: Request): boolean {
  return SAFE_METHODS.has(requestMethod(request));
}

/** Whether this method can change something. Rails' `unsafe_method?`. */
export function unsafeMethod(request: Request): boolean {
  return !safeMethod(request);
}

/** Whether repeating it repeats its effect. */
export function idempotentMethod(request: Request): boolean {
  return IDEMPOTENT_METHODS.has(requestMethod(request));
}

/** The query string without its leading `?`. Rails' `query_string`. */
export function queryString(request: Request): string {
  return new URL(request.url).search.slice(1);
}

/** The path and query, without scheme or host. Rails' `request_uri`. */
export function requestUri(request: Request): string {
  const url = new URL(request.url);

  return `${url.pathname}${url.search}`;
}

/** The URL as it arrived. Rails' `original_url`. */
export function originalUrl(request: Request): string {
  return request.url;
}

/** The scheme, without the colon. Rails' `protocol`. */
export function protocol(request: Request): string {
  return new URL(request.url).protocol.replace(":", "");
}

/**
 * The port, filled in from the scheme when the URL leaves it out.
 *
 * A URL only carries a port when it is not the default, so reading it straight
 * off gives an empty string for the overwhelmingly common case.
 */
export function port(request: Request): number {
  const url = new URL(request.url);

  if (url.port) return Number(url.port);

  return url.protocol === "https:" ? 443 : 80;
}

/**
 * Whether the request came from this machine. Rails' `local?`.
 *
 * What detailed error pages are gated on, which is why the list is the
 * loopback addresses themselves and not a subnet: anything broader shows
 * stack traces to somebody else on the network.
 */
const LOCAL_ADDRESSES = new Set(["127.0.0.1", "::1", "localhost", "[::1]"]);

export function isLocal(request: Request): boolean {
  return LOCAL_ADDRESSES.has(new URL(request.url).hostname);
}

/**
 * The content type without its parameters. Rails' `media_type`.
 *
 * `application/json; charset=utf-8` is one media type with a parameter
 * attached, and comparing the whole header against `application/json` fails on
 * exactly the requests that spell the charset out.
 */
export function mediaType(request: Request): string | null {
  const header = request.headers.get("content-type");

  return header ? (header.split(";")[0] as string).trim().toLowerCase() : null;
}

/** Whether a content type was declared at all. Rails' `has_content_type?`. */
export function hasContentType(request: Request): boolean {
  return request.headers.get("content-type") !== null;
}

/**
 * The Cache-Control directives, parsed. Rails' `cache_control_directives`.
 *
 * A directive is either a bare token or `token=value`, and the value may be
 * quoted. A bare token maps to `true` so that presence and value read the same
 * way at the call site.
 */
export function cacheControlDirectives(request: Request): Record<string, string | true> {
  const header = request.headers.get("cache-control");
  if (!header) return {};

  const directives: Record<string, string | true> = {};

  for (const part of header.split(",")) {
    const [name, ...rest] = part.trim().split("=");
    if (!name) continue;

    const value = rest.join("=").trim().replace(/^"|"$/g, "");
    directives[name.toLowerCase()] = value.length > 0 ? value : true;
  }

  return directives;
}

/** Whether the client asked to skip the cache. Rails' `no_cache?`. */
export function noCache(request: Request): boolean {
  return "no-cache" in cacheControlDirectives(request);
}

/** Whether the client will only take a cached answer. Rails' `only_if_cached?`. */
export function onlyIfCached(request: Request): boolean {
  return "only-if-cached" in cacheControlDirectives(request);
}

/** Whether the client forbids transforming the payload. */
export function noTransform(request: Request): boolean {
  return "no-transform" in cacheControlDirectives(request);
}

/** Whether the client requires every directive to be understood. */
export function mustUnderstand(request: Request): boolean {
  return "must-understand" in cacheControlDirectives(request);
}

/**
 * How stale an answer the client will accept, in seconds.
 *
 * `max-stale` with no value means any staleness at all, which is a different
 * answer from zero and has to stay distinguishable — hence the string rather
 * than `Infinity`, which would compare as a number and quietly pass a bounds
 * check.
 */
export function maxStale(request: Request): number | "unlimited" | null {
  const directive = cacheControlDirectives(request)["max-stale"];

  if (directive === undefined) return null;
  if (directive === true) return "unlimited";

  const seconds = Number(directive);

  return Number.isFinite(seconds) ? seconds : "unlimited";
}

/** The If-Modified-Since date, or null if it is absent or unparseable. */
export function ifModifiedSince(request: Request): Date | null {
  const header = request.headers.get("if-modified-since");
  if (!header) return null;

  const date = new Date(header);

  return Number.isNaN(date.getTime()) ? null : date;
}

/** The raw If-None-Match header. Rails' `if_none_match`. */
export function ifNoneMatch(request: Request): string | null {
  return request.headers.get("if-none-match");
}

/**
 * The etags in If-None-Match, unquoted and without their weakness marker.
 *
 * A client sends what the server gave it, so the quotes and the `W/` come back
 * along with the value; comparing the header to a bare etag never matches.
 * `*` is left as it is, since it means "any" rather than naming one.
 */
export function ifNoneMatchEtags(request: Request): string[] {
  const header = ifNoneMatch(request);
  if (!header) return [];

  return header
    .split(",")
    .map((one) => one.trim().replace(/^W\//, "").replace(/^"|"$/g, ""))
    .filter((one) => one.length > 0);
}
