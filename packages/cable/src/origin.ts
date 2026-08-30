/**
 * Who is allowed to open a socket, ported from
 * `ActionCable::Server::Base#allow_request_origin?` and
 * `ActionCable::Connection::Base#reject_unauthorized_connection`.
 *
 * This is the check that stops cross-site WebSocket hijacking, and it is worth
 * being precise about why it cannot be left out. A WebSocket handshake is not
 * subject to the same-origin policy the way `fetch` is: any page on any site
 * can open one to `wss://your-app/cable`, the browser attaches the user's
 * cookies to it, and nothing in the protocol stops the handshake. If the
 * server does not look at `Origin` itself, that page is now connected as the
 * user — it receives every broadcast the user is subscribed to and can send
 * commands under their identity. There is no preflight, no CORS response
 * header, and no browser-side error. `Origin` is the only signal, and it is
 * the server's job to read it.
 *
 * The default is therefore to allow nothing but the host the request arrived
 * at, and the escape hatches are named for what they are.
 */

/** How an allowed origin may be spelled. */
export type OriginPattern = string | RegExp | ((origin: string) => boolean);

export interface OriginPolicy {
  /**
   * Origins allowed beyond the request's own host. Rails'
   * `allowed_request_origins`.
   *
   * A string matches exactly, a regular expression is tested, a function
   * decides. Exact rather than prefix, because `https://example.com.evil.test`
   * starts with nothing useful but ends up matching a careless prefix check.
   */
  allowedRequestOrigins?: OriginPattern[];
  /**
   * Whether a page served by this host may connect. Rails'
   * `allow_same_origin_as_host`. On by default, as in Rails — it is what makes
   * an ordinary application work with no configuration at all.
   */
  allowSameOriginAsHost?: boolean;
  /**
   * Turns the check off entirely. Rails'
   * `disable_request_forgery_protection`.
   *
   * Named after the protection it removes rather than after the convenience it
   * buys, so that setting it is a decision somebody made rather than a line
   * that looked harmless in a config file.
   */
  disableRequestForgeryProtection?: boolean;
  /** Told about a refusal, since a socket that never opens is otherwise silent. */
  onRejected?: (origin: string | null) => void;
}

function sameOriginAsHost(request: Request, origin: string): boolean {
  const url = new URL(request.url);

  // Against the URL the request actually arrived at rather than a configured
  // hostname, so an application reached by more than one name — a staging
  // alias, a custom domain — works at each of them without listing them.
  return origin === `${url.protocol}//${url.host}`;
}

function matches(pattern: OriginPattern, origin: string): boolean {
  if (typeof pattern === "string") return pattern === origin;
  if (typeof pattern === "function") return pattern(origin);

  return pattern.test(origin);
}

/**
 * Whether this handshake may proceed. Rails' `allow_request_origin?`.
 *
 * A missing `Origin` is refused rather than allowed. Every browser sends one
 * on a WebSocket handshake, so its absence means the caller is not a browser —
 * and a non-browser caller has no cookies to be hijacked and can use a token
 * instead. Allowing it would make the check trivially bypassable by anything
 * that can omit a header, which is everything except the browsers the check
 * exists to constrain.
 */
export function allowRequestOrigin(request: Request, policy: OriginPolicy = {}): boolean {
  if (policy.disableRequestForgeryProtection === true) return true;

  const origin = request.headers.get("origin");

  if (origin === null) {
    policy.onRejected?.(null);

    return false;
  }

  if ((policy.allowSameOriginAsHost ?? true) && sameOriginAsHost(request, origin)) return true;

  if ((policy.allowedRequestOrigins ?? []).some((pattern) => matches(pattern, origin))) return true;

  policy.onRejected?.(origin);

  return false;
}

/** What a refused handshake answers with. Rails returns 404 for the same reason. */
export const FORBIDDEN_ORIGIN = 404;

/**
 * The response for a handshake that is not allowed to proceed.
 *
 * 404 rather than 403, following Rails: a 403 confirms there is a cable server
 * at this path and that the only thing wrong was who asked, which is more than
 * an unrecognised origin needs to be told.
 */
export function originRejectedResponse(): Response {
  return new Response("Not Found", { status: FORBIDDEN_ORIGIN });
}

/**
 * Thrown by a connection that decides it does not want this user. Rails'
 * `reject_unauthorized_connection`.
 *
 * Separate from returning null out of `authorize`, because the two read
 * differently at the call site: returning null is "I could not identify
 * anybody", and this is "I know who this is and they may not connect".
 */
export class UnauthorizedConnection extends Error {
  constructor(message = "An unauthorized connection attempt was rejected") {
    super(message);
    this.name = "UnauthorizedConnection";
  }
}

/** Refuses the connection being set up. Rails' `reject_unauthorized_connection`. */
export function rejectUnauthorizedConnection(message?: string): never {
  throw new UnauthorizedConnection(message);
}
