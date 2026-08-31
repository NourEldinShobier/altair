/**
 * Where a redirect is allowed to send someone, ported from
 * `ActionController::Redirecting` and `UnsafeRedirectError`.
 *
 * `redirect_to params[:return_to]` is the single most common way an
 * application hands its users to somebody else. The attacker sends a link to
 * `https://yourbank.example/login?return_to=https://evil.example/login`, the
 * victim reads the domain, recognises it, signs in — and the application
 * redirects them to a copy of its own login page on a host they never looked
 * at. Every part of that except the last step is the application working
 * exactly as designed.
 *
 * Rails' answer, and this one, is that a redirect to anywhere off-host is
 * refused unless the host was named. Three details make the difference between
 * a check and a checkbox:
 *
 * - It is the **parsed** host that is compared, never the string. Every bypass
 *   in this class works by making a URL that a string check reads one way and
 *   a browser reads another — `//evil.example`, `https:/\evil.example`,
 *   `https://trusted.example@evil.example`.
 * - The comparison is **exact**, not a suffix. `endsWith("example.com")`
 *   accepts `evil-example.com` and `notexample.com`, which is how a check that
 *   looks right lets everything through.
 * - A relative path is safe *only* if it cannot be read as a host. `/foo` is a
 *   path; `//foo` is a protocol-relative URL to the host `foo`, and the
 *   difference is one character.
 */

/** Hosts a redirect may leave for, beyond the request's own. */
export interface RedirectPolicy {
  /** The host currently being served. Always allowed. */
  host?: string;
  /** Rails' `allowed_redirect_hosts`. Compared exactly, never by suffix. */
  allowedHosts?: readonly string[];
  /** Whether to allow leaving at all. Rails' `allow_other_host`. */
  allowOtherHost?: boolean;
}

/**
 * Raised when a redirect would leave the host and nobody said it could.
 *
 * Lives here rather than in `controller.ts` so the parsing and the error stay
 * together; `controller.ts` re-exports it, and its `redirectAllowed` delegates
 * to `sameHost` below. One implementation of a security check is the point —
 * two would drift, and the one that drifted would still look right.
 */
export class UnsafeRedirect extends Error {
  constructor(
    readonly location: string,
    readonly allowed: readonly string[] = [],
  ) {
    super(
      `Refusing to redirect to ${JSON.stringify(location)}: it leaves this host and was not ` +
        `allowed. Permitted: ${allowed.join(", ") || "this host only"}. Pass ` +
        `{ allowOtherHost: true } if that is what you meant — a redirect to a user-supplied ` +
        `host is how a link that looks like this site delivers somebody to a copy of its ` +
        `login page.`,
    );
    this.name = "UnsafeRedirect";
  }
}

/**
 * Whether a location stays on this host. Rails' `_url_host_allowed?`.
 *
 * Parsed, not matched. Every bypass here works by writing a URL a string check
 * reads as relative and a browser reads as absolute.
 */
export function sameHost(location: string, host: string | undefined): boolean {
  const parsed = parseLocation(location, host);

  if (parsed === "relative") return true;
  if (parsed === undefined) return false;

  return host !== undefined && parsed.hostname.toLowerCase() === host.toLowerCase();
}

/**
 * What a location actually points at.
 *
 * `"relative"` is returned only for something that cannot be read as naming a
 * host. `//evil.example` is *not* relative — a browser reads it as
 * protocol-relative and goes to `evil.example` — and treating it as a path is
 * the classic bypass.
 */
export function parseLocation(location: string, host?: string): URL | "relative" | undefined {
  const trimmed = location.trim();

  // Backslashes first: browsers normalise `\` to `/` in the authority, so
  // `https:/\evil.example` and `/\evil.example` both leave the host while
  // reading, to a naive check, as something that does not.
  const normalized = trimmed.replaceAll("\\", "/");

  if (normalized.startsWith("//")) {
    try {
      return new URL(`https:${normalized}`);
    } catch {
      return undefined;
    }
  }

  if (normalized.startsWith("/")) return "relative";

  // Anything with no scheme and no `//` cannot name a host, so it is relative
  // whatever else it looks like. Deciding that by whether `new URL` throws
  // would make a bare `posts/7` unparseable and therefore refused — a working
  // relative redirect turned into an error.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(normalized)) return "relative";

  try {
    return new URL(normalized, host ? `https://${host}` : undefined);
  } catch {
    // A location with a scheme that still will not parse is not a location.
    // Passing it through would hand the browser something only it knows how to
    // interpret.
    return undefined;
  }
}

/** Rails' `allowed_redirect_hosts` check. */
export function hostAllowed(location: string, policy: RedirectPolicy): boolean {
  const parsed = parseLocation(location, policy.host);

  if (parsed === "relative") return true;
  if (parsed === undefined) return false;

  const hostname = parsed.hostname.toLowerCase();

  if (policy.host !== undefined && hostname === policy.host.toLowerCase()) return true;
  if (policy.allowOtherHost === true) return true;

  // Exact, never a suffix: `endsWith("example.com")` accepts
  // `evil-example.com` and `notexample.com`.
  return (policy.allowedHosts ?? []).some((allowed) => allowed.toLowerCase() === hostname);
}

/** Rails' `_ensure_url_is_http_header_safe`. */
export function safeRedirectHeader(location: string): boolean {
  // A newline in a Location header ends it and starts another, which is how a
  // redirect becomes an arbitrary response header — or an arbitrary body.
  return !/[\r\n\0]/.test(location);
}

/**
 * The location to redirect to, or an error. Rails' `redirect_to` with
 * `raise_on_open_redirects`.
 */
export function redirectToUrl(location: string, policy: RedirectPolicy = {}): string {
  if (!safeRedirectHeader(location)) {
    throw new UnsafeRedirect(location, policy.allowedHosts ?? []);
  }

  if (!hostAllowed(location, policy)) {
    throw new UnsafeRedirect(location, policy.allowedHosts ?? []);
  }

  return location.trim();
}

/** Rails' `open_redirect?` — the question on its own, for a caller that wants to branch. */
export function openRedirect(location: string, policy: RedirectPolicy = {}): boolean {
  return !hostAllowed(location, policy) || !safeRedirectHeader(location);
}

/**
 * Rails' `redirect_back_or_to`.
 *
 * The referrer is user-supplied — it is a request header — so it goes through
 * exactly the same check as anything else, and falls back rather than
 * throwing. A user arriving from an external search engine should land
 * somewhere sensible, not on an error page.
 */
export function redirectBackOrTo(
  referrer: string | null | undefined,
  fallback: string,
  policy: RedirectPolicy = {},
): string {
  if (referrer && !openRedirect(referrer, policy)) return referrer.trim();

  return redirectToUrl(fallback, policy);
}

/** The status a redirect uses. Rails' `redirect_to status:`. */
export type RedirectStatus = 301 | 302 | 303 | 307 | 308;

/**
 * Rails' `permanent: true`.
 *
 * 301 is cached by browsers indefinitely and is close to irreversible: a
 * mistaken permanent redirect keeps sending returning users to the wrong place
 * long after it is fixed, and there is no way to reach them to say so. So it
 * is opt-in and 302 is the default.
 */
export function redirectStatus({
  permanent = false,
  preserveMethod = false,
}: { permanent?: boolean; preserveMethod?: boolean } = {}): RedirectStatus {
  if (preserveMethod) return permanent ? 308 : 307;

  return permanent ? 301 : 302;
}

/**
 * Whether a redirect turns a POST into a GET. Rails follows the HTTP spec here.
 *
 * 303 is what a form submission should get: without it a browser may repeat
 * the POST at the new location, which for a payment is the difference between
 * one charge and two.
 */
export function changesMethod(status: RedirectStatus): boolean {
  return status !== 307 && status !== 308;
}
