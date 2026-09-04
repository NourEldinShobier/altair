/**
 * HTTP authentication, ported from `ActionController::HttpAuthentication`.
 *
 * Basic and Bearer. The whole of it is reading one header and answering 401
 * with the right challenge, and the whole of getting it wrong is comparing the
 * password with `===` — which stops at the first wrong byte and so says how
 * much of it was right.
 *
 *     const who = await authenticateWithHttpBasic(request, (user, password) =>
 *       user === "admin" && verify(password),
 *     )
 *
 *     if (!who) return requestHttpBasicAuthentication("Admin")
 */

import { secureCompare } from "@altair/support";

export interface BasicCredentials {
  name: string;
  password: string;
}

/** The `Authorization` header, split into its scheme and its payload. */
export function authorizationHeader(request: Request): [scheme: string, payload: string] | null {
  const header = request.headers.get("authorization");
  if (!header) return null;

  const space = header.indexOf(" ");
  if (space === -1) return null;

  return [header.slice(0, space).toLowerCase(), header.slice(space + 1).trim()];
}

/** The name and password out of a Basic header, or null. */
export function decodeCredentials(request: Request): BasicCredentials | null {
  const parsed = authorizationHeader(request);
  if (!parsed || parsed[0] !== "basic") return null;

  let decoded: string;

  try {
    decoded = atob(parsed[1]);
  } catch {
    // Not base64 at all. A malformed header is a failed attempt, not a crash.
    return null;
  }

  // Only the first colon separates them: a password may contain colons, and a
  // split on all of them quietly truncates it.
  const colon = decoded.indexOf(":");
  if (colon === -1) return null;

  return { name: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

/** The header a client sends. Rails' `encode_credentials`. */
export function encodeCredentials(name: string, password: string): string {
  return `Basic ${btoa(`${name}:${password}`)}`;
}

/**
 * Runs a check against the credentials, if there are any.
 *
 * Answers whatever the check answers, or null when the header was missing or
 * unreadable — so a caller can tell "wrong password" from "did not try".
 */
export async function authenticateWithHttpBasic<T>(
  request: Request,
  check: (name: string, password: string) => T | Promise<T>,
): Promise<T | null> {
  const credentials = decodeCredentials(request);
  if (!credentials) return null;

  return await check(credentials.name, credentials.password);
}

/**
 * A fixed name and password, compared without leaking how much was right.
 *
 * The comparison is the reason this exists rather than being left to the
 * caller: `password === "s3cret"` stops at the first wrong byte, and the time
 * that takes is a measurement of how many were correct.
 */
export async function authenticateBasic(
  request: Request,
  name: string,
  password: string,
): Promise<boolean> {
  const given = decodeCredentials(request);
  if (!given) return false;

  // Both, always: stopping after the name fails would say whether the name was
  // right, which is half the secret.
  const nameOk = secureCompare(given.name, name);
  const passwordOk = secureCompare(given.password, password);

  return nameOk && passwordOk;
}

/** The 401 that makes a browser ask. Rails' `request_http_basic_authentication`. */
export function requestHttpBasicAuthentication(
  realm = "Application",
  message = "HTTP Basic: Access denied.\n",
): Response {
  return new Response(message, {
    status: 401,
    headers: {
      // The realm is quoted and its quotes removed, because a realm containing
      // one would end the header and start something else.
      "www-authenticate": `Basic realm="${realm.replaceAll('"', "")}", charset="UTF-8"`,
      "content-type": "text/plain; charset=utf-8",
    },
  });
}

/** Runs a check, or answers the challenge. Rails' `authenticate_or_request_with_http_basic`. */
export async function authenticateOrRequestWithHttpBasic<T>(
  request: Request,
  realm: string,
  check: (name: string, password: string) => T | Promise<T>,
): Promise<T | Response> {
  const result = await authenticateWithHttpBasic(request, check);

  return result ? result : requestHttpBasicAuthentication(realm);
}

/** The token out of a `Bearer` header, or null. */
export function bearerToken(request: Request): string | null {
  const parsed = authorizationHeader(request);

  return parsed && parsed[0] === "bearer" ? parsed[1] : null;
}

export async function authenticateWithHttpToken<T>(
  request: Request,
  check: (token: string) => T | Promise<T>,
): Promise<T | null> {
  const token = bearerToken(request);

  return token === null ? null : await check(token);
}

export function requestHttpTokenAuthentication(
  realm = "Application",
  message = "HTTP Token: Access denied.\n",
): Response {
  return new Response(message, {
    status: 401,
    headers: {
      "www-authenticate": `Bearer realm="${realm.replaceAll('"', "")}"`,
      "content-type": "text/plain; charset=utf-8",
    },
  });
}

export async function authenticateOrRequestWithHttpToken<T>(
  request: Request,
  realm: string,
  check: (token: string) => T | Promise<T>,
): Promise<T | Response> {
  const result = await authenticateWithHttpToken(request, check);

  return result ? result : requestHttpTokenAuthentication(realm);
}

/** What a middleware is handed to continue the chain. */
type Next = (request: Request) => Promise<Response>;

export interface BasicAuthOptions {
  realm?: string;
  /** Paths to leave alone — a health check nothing can authenticate to. */
  exclude?: (path: string) => boolean;
}

/**
 * Basic authentication over a whole application. Rails'
 * `http_basic_authenticate_with`.
 *
 * For a staging site or an internal tool, which is what it is for and the only
 * thing it is good enough for: one name and password for everybody, and no way
 * to know who did anything.
 */
export function httpBasicAuthenticate(
  name: string,
  password: string,
  options: BasicAuthOptions = {},
) {
  return async (request: Request, next: Next): Promise<Response> => {
    if (options.exclude?.(new URL(request.url).pathname)) return await next(request);

    if (!(await authenticateBasic(request, name, password))) {
      return requestHttpBasicAuthentication(options.realm ?? "Application");
    }

    return await next(request);
  };
}
