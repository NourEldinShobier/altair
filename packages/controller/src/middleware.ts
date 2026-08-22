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
