/**
 * The middleware stack, ported from `ActionDispatch::MiddlewareStack`.
 *
 * Rails needs 4,749 lines because Rack middleware is a class with a `call`
 * method wrapping another one, plus the machinery to insert, reorder and swap
 * them by class name. A middleware here is a function:
 *
 *     const requestId: Middleware = async (request, next) => {
 *       const response = await next(request)
 *       response.headers.set("x-request-id", Current.requestId ?? "")
 *       return response
 *     }
 *
 * Ordering is the whole point of a stack, so insertBefore and insertAfter are
 * kept — an application that cannot say "compression after caching" ends up
 * with middleware that does not work.
 */

export type Next = (request: Request) => Promise<Response>;

export type Middleware = (request: Request, next: Next) => Response | Promise<Response>;

export interface NamedMiddleware {
  name: string;
  handler: Middleware;
}

/** Raised when a middleware is referenced by a name the stack does not hold. */
export class UnknownMiddleware extends Error {
  constructor(name: string, known: string[]) {
    super(
      `No middleware named "${name}" in the stack. It holds: ${known.length > 0 ? known.join(", ") : "nothing"}.`,
    );
    this.name = "UnknownMiddleware";
  }
}

export class MiddlewareStack {
  #entries: NamedMiddleware[] = [];

  get names(): string[] {
    return this.#entries.map((entry) => entry.name);
  }

  get length(): number {
    return this.#entries.length;
  }

  /** Appends to the end of the stack, so it runs closest to the application. */
  use(name: string, handler: Middleware): this {
    this.#entries.push({ name, handler });
    return this;
  }

  /** Puts one at the front, so it runs first and sees every request. */
  unshift(name: string, handler: Middleware): this {
    this.#entries.unshift({ name, handler });
    return this;
  }

  insertBefore(existing: string, name: string, handler: Middleware): this {
    this.#entries.splice(this.#indexOf(existing), 0, { name, handler });
    return this;
  }

  insertAfter(existing: string, name: string, handler: Middleware): this {
    this.#entries.splice(this.#indexOf(existing) + 1, 0, { name, handler });
    return this;
  }

  /** Replaces one in place, keeping its position. Rails' `swap`. */
  swap(existing: string, handler: Middleware): this {
    this.#entries[this.#indexOf(existing)] = { name: existing, handler };
    return this;
  }

  delete(name: string): this {
    this.#entries.splice(this.#indexOf(name), 1);
    return this;
  }

  has(name: string): boolean {
    return this.#entries.some((entry) => entry.name === name);
  }

  #indexOf(name: string): number {
    const index = this.#entries.findIndex((entry) => entry.name === name);
    if (index === -1) throw new UnknownMiddleware(name, this.names);
    return index;
  }

  /**
   * Folds the stack into one handler around the application.
   *
   * Built once rather than per request: the closures are the same every time,
   * and rebuilding them on every request is work for nothing.
   */
  build(application: Next): Next {
    return this.#entries.reduceRight<Next>(
      (next, entry) => async (request) => await entry.handler(request, next),
      application,
    );
  }
}

/**
 * Adds a request id header, generating one when the client did not send it.
 *
 * The first middleware most applications want: it is what makes a log line and
 * a query traceable back to the request that caused them.
 */
export function requestId(headerName = "x-request-id"): Middleware {
  return async (request, next) => {
    const id = request.headers.get(headerName) ?? crypto.randomUUID();
    const response = await next(request);

    // Response headers are immutable once constructed, so this rebuilds.
    const headers = new Headers(response.headers);
    headers.set(headerName, id);

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

/** What a form may ask to become. */
const OVERRIDABLE = new Set(["PATCH", "PUT", "DELETE"]);

export const METHOD_OVERRIDE_PARAM = "_method";
export const METHOD_OVERRIDE_HEADER = "x-http-method-override";

/**
 * Lets a form say it meant PATCH, PUT or DELETE.
 *
 * Ported from `Rack::MethodOverride`. A browser sends only GET and POST from a
 * form, so everything else travels as a hidden `_method` field — which is what
 * `ButtonTo` writes, and what nothing read: a delete button posted to a path
 * with no POST route and came back 404.
 *
 * Only a POST is overridden, and that is the whole point rather than a detail.
 * Honouring it on a GET would let a link carry `?_method=delete`, and a link
 * is followed by crawlers, prefetchers and the back button — which is the
 * failure `ButtonTo` exists to avoid, reintroduced one layer down.
 */
export function methodOverride(): Middleware {
  return async (request, next) => {
    if (request.method !== "POST") return await next(request);

    const wanted = await overrideFor(request);
    if (!wanted) return await next(request);

    // A fresh Request over the same body: `method` is read-only, and the body
    // has to survive because the dispatcher parses it again for params.
    return await next(new Request(request, { method: wanted }));
  };
}

/** What this request asked to be, if anything, and if it is allowed. */
async function overrideFor(request: Request): Promise<string | null> {
  const header = request.headers.get(METHOD_OVERRIDE_HEADER);
  if (header) return normalizeOverride(header);

  const type = request.headers.get("content-type") ?? "";
  const form =
    type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data");

  if (!form) return null;

  try {
    // Cloned, because reading a body consumes it and the dispatcher needs it.
    const fields = await request.clone().formData();

    return normalizeOverride(fields.get(METHOD_OVERRIDE_PARAM));
  } catch {
    // A body that will not parse is not a request that meant DELETE.
    return null;
  }
}

function normalizeOverride(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const wanted = value.toUpperCase();

  return OVERRIDABLE.has(wanted) ? wanted : null;
}

export interface HostAuthorizationOptions {
  /**
   * Hosts this application answers to.
   *
   * A string matches exactly, a leading dot matches the domain and everything
   * under it (`.example.com` allows `app.example.com`), and a RegExp is
   * matched against the whole host. Empty means every host, which is what
   * Rails does when `config.hosts` is empty.
   */
  allowed?: readonly (string | RegExp)[];
  /** Paths that answer whatever the Host says — a load balancer's health check. */
  exclude?: (path: string) => boolean;
}

/**
 * Refuses a request whose Host header this application does not answer to.
 *
 * Ported from `ActionDispatch::HostAuthorization`, which Rails added in 6.0
 * for two attacks that both start with a Host header nobody checked.
 *
 * The first is DNS rebinding, and it is aimed at a development machine: a page
 * on the attacker's site resolves their domain to 127.0.0.1 after the page has
 * loaded, and the browser then sends requests to the server on your laptop
 * with their origin's cookies and no cross-origin check, because as far as it
 * is concerned nothing changed. That is why the default here covers
 * development and not production — it is the machine on the café wifi that is
 * exposed, not the one behind a load balancer that already rejects unknown
 * hosts.
 *
 * The second works anywhere: an application that builds a URL from the Host
 * header — a password reset link, most often — sends the user a link to
 * whatever host the attacker asked for.
 */
export function hostAuthorization(options: HostAuthorizationOptions = {}): Middleware {
  const allowed = options.allowed ?? [];

  return async (request, next) => {
    if (allowed.length === 0) return await next(request);

    const url = new URL(request.url);
    if (options.exclude?.(url.pathname)) return await next(request);

    // The Host header, not the parsed URL's host: they are the same here, and
    // being explicit about which one is checked is the whole subject.
    const host = (request.headers.get("host") ?? url.host).toLowerCase();

    if (allows(allowed, host)) return await next(request);

    return new Response(`Blocked host: ${host}`, {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  };
}

/** Whether any rule covers this host. */
function allows(rules: readonly (string | RegExp)[], host: string): boolean {
  // A port is not part of a host name, and a browser sends one whenever the
  // server is not on 443 or 80 — which, in development, is always.
  const name = host.replace(/:\d+$/, "");

  return rules.some((rule) => {
    if (rule instanceof RegExp) return rule.test(name);

    const allowed = rule.toLowerCase();

    // A leading dot means the domain and everything under it, as Rails reads
    // it — and `.example.com` allows `example.com` itself too.
    if (allowed.startsWith(".")) {
      return name === allowed.slice(1) || name.endsWith(allowed);
    }

    return name === allowed;
  });
}

export interface CorsOptions {
  origin?: string | string[] | ((origin: string) => boolean);
  methods?: string[];
  headers?: string[];
  credentials?: boolean;
  maxAge?: number;
}

/**
 * Cross-origin headers.
 *
 * The default origin is nothing, not `*`. A framework whose CORS middleware is
 * permissive by default ships applications that accept requests from anywhere,
 * and the person who added it will not find out until it matters.
 */
export function cors(options: CorsOptions = {}): Middleware {
  const allowed = (origin: string): boolean => {
    if (!options.origin) return false;
    if (typeof options.origin === "function") return options.origin(origin);
    if (Array.isArray(options.origin)) return options.origin.includes(origin);
    return options.origin === "*" || options.origin === origin;
  };

  const headersFor = (origin: string): Record<string, string> => {
    const headers: Record<string, string> = {
      "access-control-allow-origin": options.origin === "*" ? "*" : origin,
      "access-control-allow-methods": (
        options.methods ?? ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"]
      ).join(", "),
      "access-control-allow-headers": (options.headers ?? ["content-type", "authorization"]).join(
        ", ",
      ),
    };

    if (options.credentials) headers["access-control-allow-credentials"] = "true";
    if (options.maxAge !== undefined) headers["access-control-max-age"] = String(options.maxAge);

    // Any response that varies by origin must say so, or a shared cache will
    // serve one origin's response to another.
    headers.vary = "Origin";
    return headers;
  };

  return async (request, next) => {
    const origin = request.headers.get("origin");

    if (request.method === "OPTIONS" && request.headers.get("access-control-request-method")) {
      return origin && allowed(origin)
        ? new Response(null, { status: 204, headers: headersFor(origin) })
        : new Response(null, { status: 403 });
    }

    const response = await next(request);
    if (!origin || !allowed(origin)) return response;

    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(headersFor(origin))) headers.set(key, value);

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

/** Headers every application should send, from Rails' default set. */
export function securityHeaders(overrides: Record<string, string> = {}): Middleware {
  const defaults: Record<string, string> = {
    "x-content-type-options": "nosniff",
    "x-frame-options": "SAMEORIGIN",
    "referrer-policy": "strict-origin-when-cross-origin",
    ...overrides,
  };

  return async (request, next) => {
    const response = await next(request);
    const headers = new Headers(response.headers);

    // An application that set one deliberately keeps it.
    for (const [key, value] of Object.entries(defaults)) {
      if (!headers.has(key)) headers.set(key, value);
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

/** Redirects http to https. Rails' `force_ssl`. */
export function forceSsl(): Middleware {
  return async (request, next) => {
    const url = new URL(request.url);
    const proto = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");

    if (proto === "https" || url.hostname === "localhost") return await next(request);

    url.protocol = "https:";
    // 301 rather than 302: this is permanent, and a browser that remembers it
    // stops sending the first request in plaintext at all.
    return new Response(null, { status: 301, headers: { location: url.toString() } });
  };
}
