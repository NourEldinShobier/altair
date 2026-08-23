/**
 * Content Security Policy, ported from `ActionDispatch::ContentSecurityPolicy`.
 *
 * A policy is a list of directives, each naming where one kind of resource may
 * come from. Written by hand it is a long string with easy mistakes in it —
 * `'self'` without the quotes is a hostname called self, and a missing
 * semicolon silently merges two directives. This builds the string.
 *
 *     const policy = new ContentSecurityPolicy()
 *       .defaultSrc("self")
 *       .scriptSrc("self", "https://cdn.example.com")
 *       .imgSrc("self", "data:")
 *
 *     app.middleware.use("csp", contentSecurityPolicy(policy))
 *
 * The nonce is the reason this is worth having rather than a constant header:
 * a per-request nonce lets a page keep one inline script without opening the
 * door to every inline script, and a view reads it from the request scope.
 */

import { Current } from "@altair/support";

/** Sources that mean something to the policy rather than naming a host. */
const KEYWORDS = new Set([
  "self",
  "none",
  "unsafe-inline",
  "unsafe-eval",
  "unsafe-hashes",
  "strict-dynamic",
  "report-sample",
  "wasm-unsafe-eval",
]);

/**
 * Quotes a source if the specification requires it.
 *
 * `self` is a keyword and `'self'` is what a browser looks for; written bare
 * it is read as a hostname, and the policy silently does nothing.
 */
export function quoteSource(source: string): string {
  if (KEYWORDS.has(source)) return `'${source}'`;
  return source;
}

/** Directives, in the spelling browsers expect. */
export type Directive =
  | "base-uri"
  | "child-src"
  | "connect-src"
  | "default-src"
  | "font-src"
  | "form-action"
  | "frame-ancestors"
  | "frame-src"
  | "img-src"
  | "manifest-src"
  | "media-src"
  | "object-src"
  | "prefetch-src"
  | "report-uri"
  | "script-src"
  | "script-src-attr"
  | "script-src-elem"
  | "style-src"
  | "style-src-attr"
  | "style-src-elem"
  | "worker-src";

/** Directives that carry no sources and are present or absent. */
export type BooleanDirective = "upgrade-insecure-requests" | "block-all-mixed-content";

export class ContentSecurityPolicy {
  #directives = new Map<string, string[]>();
  #flags = new Set<string>();
  /** Directives a nonce is added to when one is in scope. */
  #nonceFor = new Set<string>(["script-src", "style-src"]);

  /** Sets a directive, replacing whatever it held. */
  set(directive: Directive, ...sources: string[]): this {
    this.#directives.set(directive, sources.map(quoteSource));
    return this;
  }

  /** Adds to a directive rather than replacing it. */
  add(directive: Directive, ...sources: string[]): this {
    const existing = this.#directives.get(directive) ?? [];
    this.#directives.set(directive, [...existing, ...sources.map(quoteSource)]);
    return this;
  }

  defaultSrc(...sources: string[]): this {
    return this.set("default-src", ...sources);
  }
  scriptSrc(...sources: string[]): this {
    return this.set("script-src", ...sources);
  }
  styleSrc(...sources: string[]): this {
    return this.set("style-src", ...sources);
  }
  imgSrc(...sources: string[]): this {
    return this.set("img-src", ...sources);
  }
  fontSrc(...sources: string[]): this {
    return this.set("font-src", ...sources);
  }
  connectSrc(...sources: string[]): this {
    return this.set("connect-src", ...sources);
  }
  frameAncestors(...sources: string[]): this {
    return this.set("frame-ancestors", ...sources);
  }
  formAction(...sources: string[]): this {
    return this.set("form-action", ...sources);
  }
  objectSrc(...sources: string[]): this {
    return this.set("object-src", ...sources);
  }
  baseUri(...sources: string[]): this {
    return this.set("base-uri", ...sources);
  }
  reportUri(uri: string): this {
    return this.set("report-uri", uri);
  }

  /** A directive that is present or absent rather than a list. */
  flag(directive: BooleanDirective): this {
    this.#flags.add(directive);
    return this;
  }

  /** Which directives a nonce joins. Rails' `nonce_directives`. */
  nonceDirectives(...directives: Directive[]): this {
    this.#nonceFor = new Set(directives);
    return this;
  }

  /** A copy, so a per-action change does not edit the application's policy. */
  clone(): ContentSecurityPolicy {
    const copy = new ContentSecurityPolicy();
    for (const [directive, sources] of this.#directives)
      copy.#directives.set(directive, [...sources]);
    copy.#flags = new Set(this.#flags);
    copy.#nonceFor = new Set(this.#nonceFor);
    return copy;
  }

  get isEmpty(): boolean {
    return this.#directives.size === 0 && this.#flags.size === 0;
  }

  /** The header value. A nonce joins the directives that asked for one. */
  toHeader(nonce?: string): string {
    const parts: string[] = [];

    for (const [directive, sources] of this.#directives) {
      const values = [...sources];
      if (nonce && this.#nonceFor.has(directive)) values.push(`'nonce-${nonce}'`);

      // A directive with no sources at all would be `script-src;`, which means
      // nothing; `'none'` is how the specification says to forbid everything.
      parts.push(values.length > 0 ? `${directive} ${values.join(" ")}` : `${directive} 'none'`);
    }

    for (const flag of this.#flags) parts.push(flag);

    return parts.join("; ");
  }

  toString(): string {
    return this.toHeader();
  }
}

/** A nonce is only worth having if it cannot be guessed. */
export function generateNonce(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
}

export interface CspOptions {
  /**
   * Reports violations without enforcing them.
   *
   * The way to deploy a policy to a site that has never had one: watch what
   * breaks before it breaks for anybody.
   */
  reportOnly?: boolean;
  /** Off means no nonce is generated and none is added to any directive. */
  nonce?: boolean;
}

/** What a middleware is handed to continue the chain. */
type Next = (request: Request) => Promise<Response>;

/**
 * Sets the policy on every response.
 *
 * The nonce goes into the request scope before the response is built, so a
 * view rendering an inline script can reach the same one that ends up in the
 * header — which is the only way the pair is any use.
 */
export function contentSecurityPolicy(policy: ContentSecurityPolicy, options: CspOptions = {}) {
  const header = options.reportOnly
    ? "content-security-policy-report-only"
    : "content-security-policy";

  return async (request: Request, next: Next): Promise<Response> => {
    const nonce = options.nonce === false ? undefined : generateNonce();
    if (nonce && Current.isActive) Current.cspNonce = nonce;

    const response = await next(request);
    if (policy.isEmpty) return response;

    const headers = new Headers(response.headers);
    // An application that set one deliberately keeps it.
    if (!headers.has(header)) headers.set(header, policy.toHeader(nonce));

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}
