/**
 * Rate limiting, ported from `ActionController::RateLimiting`.
 *
 * Rails 7.2 added `rate_limit to: 10, within: 3.minutes`, counted in the cache
 * store. The same here, and for the same reason: a login form with no limit is
 * a password guessing service.
 *
 *     app.middleware.use("throttle", rateLimit({ to: 10, within: minutes(3) }))
 *
 * The window is fixed rather than sliding, which is what Rails does and is
 * worth being honest about: someone can send the allowance twice across a
 * window boundary. That is a known and accepted shape, not an oversight.
 */

import type { CacheStore, Duration } from "@altair/support";

/** What a middleware is handed to continue the chain. */
type Next = (request: Request) => Promise<Response>;

export interface RateLimitOptions {
  /** How many requests are allowed in the window. */
  to: number;
  /** How long the window is. */
  within: Duration | number;
  /** Where the counters live. */
  store: CacheStore;
  /**
   * What counts as "the same caller".
   *
   * Defaults to the client's address, read from the headers a proxy sets.
   * An application behind a proxy it does not control should supply its own,
   * because a header anyone can send is not an identity.
   */
  by?: (request: Request) => string | Promise<string>;
  /** What to answer when the limit is reached. */
  with?: (request: Request) => Response | Promise<Response>;
  /** Distinguishes one limit from another on the same caller. */
  name?: string;
}

/** Seconds in a window, whichever way it was given. */
export function windowSeconds(within: Duration | number): number {
  return typeof within === "number" ? within : within.inSeconds;
}

/**
 * The address a request appears to come from.
 *
 * Only the first entry of `x-forwarded-for` is the client; the rest are the
 * proxies it passed through, and anyone can prepend to the list, which is why
 * this is a default rather than a claim.
 */
export function clientAddress(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();

  return request.headers.get("x-real-ip") ?? "unknown";
}

/**
 * The key a caller's count is stored under.
 *
 * The window's start is part of the key, so a window expires by being a
 * different key rather than by anything having to sweep the old one.
 */
export function counterKey(name: string, caller: string, seconds: number, now: number): string {
  const window = Math.floor(now / 1000 / seconds);
  return `rate-limit/${name}/${caller}/${window}`;
}

/** The response Rails sends: 429, with how long to wait. */
export function tooManyRequests(retryAfter: number): Response {
  return new Response("Too many requests", {
    status: 429,
    headers: { "retry-after": String(Math.max(1, Math.ceil(retryAfter))) },
  });
}

export interface RateLimitState {
  count: number;
  limit: number;
  remaining: number;
  /** Seconds until this window ends. */
  resetIn: number;
  exceeded: boolean;
}

/**
 * Counts one request against a caller's allowance.
 *
 * Separated from the middleware so the counting can be tested, and so an
 * application can apply a limit somewhere other than the middleware stack.
 */
export async function recordRequest(
  options: RateLimitOptions,
  request: Request,
  now: number = Date.now(),
): Promise<RateLimitState> {
  const seconds = windowSeconds(options.within);
  const caller = await (options.by ?? clientAddress)(request);
  const key = counterKey(options.name ?? "default", caller, seconds, now);

  // The window travels with the count. Setting it afterwards was a race: a
  // second request could count in between, and the write that carried the
  // expiry also carried a value, resetting the count to one.
  const count = await options.store.increment(key, 1, { expiresIn: seconds });

  const elapsed = (now / 1000) % seconds;

  return {
    count,
    limit: options.to,
    remaining: Math.max(0, options.to - count),
    resetIn: seconds - elapsed,
    exceeded: count > options.to,
  };
}

/** Adds the headers a client needs to back off on its own. */
export function withRateLimitHeaders(response: Response, state: RateLimitState): Response {
  const headers = new Headers(response.headers);

  headers.set("x-ratelimit-limit", String(state.limit));
  headers.set("x-ratelimit-remaining", String(state.remaining));
  headers.set("x-ratelimit-reset", String(Math.ceil(state.resetIn)));

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Rails' `rate_limit`, as a middleware. */
export function rateLimit(options: RateLimitOptions) {
  return async (request: Request, next: Next): Promise<Response> => {
    const state = await recordRequest(options, request);

    if (state.exceeded) {
      const response = options.with ? await options.with(request) : tooManyRequests(state.resetIn);

      return withRateLimitHeaders(response, state);
    }

    return withRateLimitHeaders(await next(request), state);
  };
}
