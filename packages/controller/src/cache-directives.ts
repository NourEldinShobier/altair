/**
 * The caching directives beyond a plain `expiresIn`, ported from
 * `ActionController::ConditionalGet#http_cache_forever`, the strong/weak etag
 * distinction in `ActionDispatch::Http::Cache`, and the `Vary` handling in
 * `ActionController::ContentNegotiation`.
 *
 * `conditional-get.ts` answers "has this changed". These answer the three
 * questions that come after it, each of which is a real failure when got
 * wrong.
 */

import { etagSource, type EtagSource } from "./conditional-get.js";
import { CryptoHasher } from "bun";

/**
 * A validator that means "byte for byte this". Rails' strong etag.
 *
 * The difference from a weak one is not cosmetic. A range request — a resumed
 * download, a video seeking — sends `If-Range` with the etag it has, and a
 * server may only serve the requested range if the etag is strong. Given a
 * weak one, a correct client throws away its partial file and starts again,
 * which for a large download is the whole point of resuming undone.
 *
 * So a strong etag is a promise: this exact URL will produce these exact
 * bytes for as long as this etag holds. Only give one when that is true.
 */
export function strongEtag(value: EtagSource): string {
  return `"${digestOf(value)}"`;
}

/**
 * A validator that means "the same thing, near enough". Rails' weak etag, and
 * the default.
 *
 * The right one almost always, because almost nothing is byte-stable: a
 * rendered page carries a CSRF token, a timestamp, a nonce. Claiming byte
 * equality for those breaks range requests in a way that is very hard to
 * attribute later.
 */
export function weakEtag(value: EtagSource): string {
  return `W/"${digestOf(value)}"`;
}

function digestOf(value: EtagSource): string {
  return new CryptoHasher("sha256").update(etagSource(value)).digest("hex").slice(0, 32);
}

/** Whether an etag claims byte equality. */
export function isStrongEtag(etag: string): boolean {
  return !etag.trimStart().startsWith("W/");
}

export interface ForeverOptions {
  /** Whether a shared cache may keep it. Off by default, as in Rails. */
  public?: boolean;
}

/** A year, which is the longest `max-age` the spec asks caches to honour. */
export const FOREVER_SECONDS = 31_536_000;

/**
 * Headers for something that will never change at this URL. Rails'
 * `http_cache_forever`.
 *
 * For a digest-stamped asset — `app-a1b2c3.js` — where a change to the content
 * changes the URL, so the old URL keeping the old bytes for ever is correct
 * rather than merely tolerable.
 *
 * `immutable` is the part that earns its place. Without it a browser still
 * revalidates on reload, which is a round trip per asset per reload that can
 * only ever answer 304 — so the page a developer reloads most is the one that
 * pays for it. With it, the browser does not ask.
 *
 * Only ever use this where the URL changes with the content. On a URL that
 * serves different bytes later, a year of `immutable` is a year of people
 * seeing the old thing with no way to tell them otherwise.
 */
export function httpCacheForever(options: ForeverOptions = {}): Record<string, string> {
  const scope = options.public === true ? "public" : "private";

  return { "cache-control": `${scope}, max-age=${String(FOREVER_SECONDS)}, immutable` };
}

/**
 * Whether a response's `Vary` should name a header. Rails'
 * `should_apply_vary_header?`.
 *
 * The failure it prevents is a shared cache handing a JSON body to a browser
 * that asked for HTML. If what was served depended on a request header, every
 * cache in front of the application has to be told which one, or it will treat
 * two different requests as one.
 *
 * Only when the response actually varied. `Vary: Accept` on a response that
 * would have been the same either way splits the cache for nothing, and a
 * cache split by `Accept` is a cache with roughly one entry per browser
 * version.
 */
export function shouldApplyVaryHeader(negotiated: boolean, alreadyVaries: string | null): boolean {
  if (!negotiated) return false;

  return !varyNames(alreadyVaries).includes("accept");
}

/** Adds a header name to a `Vary`, keeping what was there. */
export function addVary(existing: string | null, name: string): string {
  const wanted = name.toLowerCase();
  const names = varyNames(existing);

  // `*` means "varies by everything", and naming a header beside it says less
  // than `*` already did.
  if (names.includes("*")) return "*";
  if (names.includes(wanted)) return names.join(", ");

  return [...names, wanted].join(", ");
}

function varyNames(header: string | null): string[] {
  if (header === null || header.trim() === "") return [];

  return header
    .split(",")
    .map((one) => one.trim().toLowerCase())
    .filter((one) => one !== "");
}

/**
 * A request asking for anything cached, however old. Rails'
 * `max_stale_unlimited`.
 *
 * What a client sends when it would rather have something stale than nothing —
 * a page rendered from cache while the origin is down. Recognised here so an
 * application serving its own cache can honour it rather than treating the
 * request as ordinary.
 */
export function acceptsUnlimitedStale(request: {
  headers: { get(name: string): string | null };
}): boolean {
  const control = request.headers.get("cache-control");

  if (control === null) return false;

  return (
    control
      .split(",")
      .map((one) => one.trim().toLowerCase())
      // Bare `max-stale`, with no value, is the unlimited form. `max-stale=600`
      // is a bounded one and means something quite different.
      .includes("max-stale")
  );
}
