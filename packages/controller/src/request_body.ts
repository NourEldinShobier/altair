/**
 * The request's body, who sent it, and where it was going. Ported from
 * `ActionDispatch::Request` and `Http::URL`.
 *
 * `request_details.ts` covers the headers and `request_info.ts` the host.
 * What is left is the part that is awkward for a reason: a body can only be
 * read once.
 *
 * `Request.body` is a stream, and consuming it consumes it. That is fine until
 * two things want it — a JSON parser and an error reporter, a rate limiter and
 * a controller, a signature check and everything after it. The second one gets
 * an empty body and no error, and what it reports is "missing parameter"
 * rather than "somebody read this already".
 *
 * So the body is read once and kept, and everything that wants it gets the
 * same string. Rails calls the kept copy `raw_post` and does the same thing
 * for the same reason.
 *
 * The identity half — `remoteIp`, `userAgent` — is separate but shares a
 * hazard: every value here arrives from the client or from a proxy the client
 * can sometimes influence, so none of it is evidence of anything on its own.
 */

import { Current } from "@altair/support";
import { clientIp } from "./client_ip.js";
import type { ClientIpOptions } from "./client_ip.js";

/** Where the body of a request is kept once read. */
const bodies = new WeakMap<Request, string>();

/**
 * The body as a string, read once however often it is asked for. Rails'
 * `raw_post`.
 *
 * Cached against the Request object rather than passed around, because the
 * whole problem is that the second caller does not know there was a first one.
 */
export async function rawPost(request: Request): Promise<string> {
  const held = bodies.get(request);

  if (held !== undefined) return held;

  // `clone()` so the original stream is left intact for anything holding a
  // reference to it — including whatever framework code eventually sends the
  // request on.
  const body = await request.clone().text();
  bodies.set(request, body);

  return body;
}

/** Whether the body has already been read and kept. */
export function bodyRead(request: Request): boolean {
  return bodies.has(request);
}

/** Forgets it, for a long-lived object that must not hold a body. */
export function forgetBody(request: Request): void {
  bodies.delete(request);
}

/** A reader over the kept body. Rails' `body_stream`. */
export class BodyStream {
  #body: string;
  #position = 0;

  constructor(body: string) {
    this.#body = body;
  }

  static async of(request: Request): Promise<BodyStream> {
    return new BodyStream(await rawPost(request));
  }

  /** Rails' `read`. Everything from here on, or a fixed number of characters. */
  read(length?: number): string {
    const from = this.#position;
    const to =
      length === undefined ? this.#body.length : Math.min(from + length, this.#body.length);

    this.#position = to;

    return this.#body.slice(from, to);
  }

  /**
   * Back to the beginning. Rails' `rewind`.
   *
   * What makes a second reader possible at all, and what a middleware that
   * peeked at the body owes the one after it.
   */
  rewind(): void {
    this.#position = 0;
  }

  /** Rails' `eof?`. */
  eof(): boolean {
    return this.#position >= this.#body.length;
  }

  get position(): number {
    return this.#position;
  }

  get length(): number {
    return this.#body.length;
  }
}

/**
 * The path with its query string. Rails' `fullpath`.
 *
 * Together, because a log line or a cache key that drops the query treats
 * `/posts?page=2` and `/posts` as the same request — and then page two is
 * served from page one's cache.
 */
export function fullpath(request: Request): string {
  const url = new URL(request.url);

  return `${url.pathname}${url.search}`;
}

/**
 * The path before anything rewrote it. Rails' `original_fullpath`.
 *
 * A middleware that rewrites the path — a locale prefix, a legacy redirect —
 * leaves the application seeing the rewritten one, which is the wrong thing to
 * log and the wrong thing to build a canonical URL from.
 */
export function originalFullpath(request: Request): string {
  const original = request.headers.get("x-original-url") ?? request.headers.get("x-rewrite-url");

  return original ?? fullpath(request);
}

/** Rails' `user_agent`. */
export function userAgent(request: Request): string | null {
  return request.headers.get("user-agent");
}

/** Rails' `server_software`, from the response side of a proxy. */
export function serverSoftware(headers: Headers): string | null {
  const server = headers.get("server");

  return server === null ? null : (/^[a-zA-Z0-9_-]+/.exec(server)?.[0] ?? null);
}

/**
 * Whether the request came from XHR. Rails' `xml_http_request?`.
 *
 * A hint and not a fact: the header is set by the JavaScript library making
 * the call, so anything can send it. Fine for choosing a response format,
 * never for deciding whether something is allowed.
 */
export function xmlHttpRequest(request: Request): boolean {
  return (request.headers.get("x-requested-with") ?? "").toLowerCase() === "xmlhttprequest";
}

/** The address the connection came from, before any proxy header. Rails' `remote_addr`. */
export function remoteAddr(request: Request, connectionAddress?: string): string | null {
  // The observed address before the header, always. `X-Real-Ip` is written by
  // a proxy in a correct deployment and by anybody at all in the rest of them,
  // so it is the last resort rather than the first.
  return connectionAddress ?? Current.peerAddress ?? request.headers.get("x-real-ip");
}

/** Addresses that are not routable, so a proxy chain entry naming one tells you nothing. */
const PRIVATE = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^::1$/,
  /^[fF][cCdD]/,
];

export function isPrivateAddress(address: string): boolean {
  return PRIVATE.some((pattern) => pattern.test(address.trim()));
}

/**
 * The client's address, as best it can be known. Rails' `remote_ip`.
 *
 * Delegates to `client_ip.ts`, which already resolves the chain — a second
 * answer to this question is worse than none, because the two would disagree
 * and a rate limiter and an audit log would then be throttling and recording
 * different addresses.
 */
export function remoteIp(request: Request, options: ClientIpOptions = {}): string | null {
  return clientIp(request, options) ?? remoteAddr(request);
}

/** The subdomains of a host, given how many labels the domain itself has. Rails' `subdomains_from`. */
export function subdomainsFrom(host: string, tldLength = 1): string[] {
  const labels = host.split(".").filter((each) => each !== "");

  // An address is not a name and has no subdomains — splitting one on dots
  // gives four "labels" that mean nothing.
  if (labels.length <= tldLength + 1 || /^\d/.test(host)) return [];

  return labels.slice(0, labels.length - (tldLength + 1));
}

/** The registrable part of a host. Rails' `domain_from`. */
export function domainFrom(host: string, tldLength = 1): string | null {
  const labels = host.split(".").filter((each) => each !== "");

  if (labels.length < tldLength + 1 || /^\d/.test(host)) return null;

  return labels.slice(labels.length - (tldLength + 1)).join(".");
}

/**
 * Builds a URL from its parts. Rails' `url_from`.
 *
 * The default port for the scheme is left off: a URL carrying `:443` is the
 * same URL and does not look like it, so it fails to match a canonical tag or
 * an OAuth redirect registration.
 */
export function urlFrom(parts: {
  protocol?: string;
  host: string;
  port?: number;
  path?: string;
  query?: string;
}): string {
  const protocol = (parts.protocol ?? "https").replace(/:\/*$/, "");
  const standard =
    (protocol === "https" && parts.port === 443) || (protocol === "http" && parts.port === 80);
  const port = parts.port === undefined || standard ? "" : `:${String(parts.port)}`;
  const path = parts.path === undefined || parts.path === "" ? "" : parts.path;
  const query =
    parts.query === undefined || parts.query === "" ? "" : `?${parts.query.replace(/^\?/, "")}`;

  return `${protocol}://${parts.host}${port}${path}${query}`;
}
