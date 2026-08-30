import { escapeSegment } from "./urls.js";

/**
 * Route compilation and matching.
 *
 * A route pattern is Rails': `/posts/:id`, with `*rest` for globs and an
 * implicit optional `(.:format)` suffix. Patterns compile to a regular
 * expression once, at draw time, and matching is a scan in declaration order —
 * first match wins, exactly as Rails does it. Bun's own router sorts by
 * specificity instead, which would silently change which route answers a
 * request, so we do not delegate to it.
 */

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE" | "HEAD" | "OPTIONS";

export interface Segment {
  kind: "static" | "dynamic" | "glob";
  value: string;
}

export interface RouteOptions {
  name?: string;
  constraints?: Record<string, RegExp>;
  defaults?: Record<string, string>;
  /** Rails appends `(.:format)` to most routes; globs and root do not get it. */
  format?: boolean;
}

export interface RouteMatch {
  controller: string;
  action: string;
  params: Record<string, string>;
  route: Route;
}

const DYNAMIC = /^:(\w+)$/;
const GLOB = /^\*(\w+)$/;

function escapeLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseSegments(pattern: string): Segment[] {
  return pattern
    .split("/")
    .filter((part) => part.length > 0)
    .map((part) => {
      const dynamic = DYNAMIC.exec(part);
      if (dynamic) return { kind: "dynamic", value: dynamic[1]! } as Segment;
      const glob = GLOB.exec(part);
      if (glob) return { kind: "glob", value: glob[1]! } as Segment;
      return { kind: "static", value: part } as Segment;
    });
}

/**
 * Decodes a captured segment the way the rest of the stack expects.
 *
 * A path arrives percent-encoded — a browser sends `/posts/caf%C3%A9` for a
 * slug with an accent in it, and `%20` for one with a space — and without this
 * the action looked up `"caf%C3%A9"` and found nothing. Every route with a
 * non-numeric id was affected, which is most of the routes anybody writes.
 *
 * A constraint is checked twice and this sits between them. The route's own
 * pattern has the constraint compiled into it and matches the raw path; the
 * check after extraction sees the decoded value. That second one is why the
 * order here matters: a constraint written to keep a slash out of an id passes
 * the pattern happily, because `%2F` holds no slash, and would hand the action
 * one anyway if the value reached it undecoded.
 *
 * A malformed escape keeps its raw text rather than throwing. `decodeURI`
 * raises on `%zz`, and a request that cannot be parsed should not become a
 * stack trace — the same call the cookie parser makes for the same reason. The
 * value will not match anything, and the request ends as the 404 it is.
 */
function decodeSegment(value: string): string {
  if (!value.includes("%")) return value;

  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export class Route {
  readonly method: HttpMethod;
  readonly pattern: string;
  readonly controller: string;
  readonly action: string;
  readonly name: string | undefined;
  readonly segments: Segment[];
  readonly constraints: Record<string, RegExp>;
  readonly defaults: Record<string, string>;
  readonly acceptsFormat: boolean;

  readonly #regex: RegExp;
  readonly #captures: string[];

  constructor(
    method: HttpMethod,
    pattern: string,
    controller: string,
    action: string,
    options: RouteOptions = {},
  ) {
    this.method = method;
    this.pattern = normalizePath(pattern);
    this.controller = controller;
    this.action = action;
    this.name = options.name;
    this.segments = parseSegments(this.pattern);
    this.constraints = options.constraints ?? {};
    this.defaults = options.defaults ?? {};

    const hasGlob = this.segments.some((s) => s.kind === "glob");
    this.acceptsFormat = options.format ?? !hasGlob;

    const captures: string[] = [];
    let source = "";

    for (const segment of this.segments) {
      if (segment.kind === "static") {
        source += `/${escapeLiteral(segment.value)}`;
        continue;
      }
      captures.push(segment.value);
      if (segment.kind === "glob") {
        source += "/(.+)";
      } else {
        const constraint = this.constraints[segment.value];
        // A constraint is spliced in as a non-anchored group. Rails treats
        // constraints as segment-local, so anchors from the user's regex would
        // be wrong here and are stripped.
        source += constraint ? `/(${stripAnchors(constraint.source)})` : "/([^/.?]+)";
      }
    }

    if (source === "") source = "/";
    if (this.acceptsFormat) {
      captures.push("format");
      source += "(?:\\.([^/.?]+))?";
    }

    this.#regex = new RegExp(`^${source}$`);
    this.#captures = captures;
  }

  /** Returns the extracted params, or null when the path does not match. */
  match(path: string): Record<string, string> | null {
    const result = this.#regex.exec(normalizePath(path));
    if (!result) return null;

    const params: Record<string, string> = { ...this.defaults };
    this.#captures.forEach((capture, index) => {
      const value = result[index + 1];
      if (value !== undefined) params[capture] = decodeSegment(value);
    });

    for (const [key, constraint] of Object.entries(this.constraints)) {
      const value = params[key];
      if (value === undefined) continue;
      if (!anchored(constraint).test(value)) return null;
    }

    return params;
  }

  /** The dynamic segment names this route needs in order to build a path. */
  get requiredParams(): string[] {
    return this.segments.filter((s) => s.kind !== "static").map((s) => s.value);
  }

  /** Builds a path from named values. Throws when a required segment is missing. */
  format(values: Record<string, unknown>): string {
    let path = "";
    for (const segment of this.segments) {
      if (segment.kind === "static") {
        path += `/${segment.value}`;
        continue;
      }
      const value = values[segment.value];
      if (value === undefined || value === null) {
        throw new Error(`Missing required parameter "${segment.value}" for route ${this.pattern}`);
      }
      // Through the segment escaper rather than encodeURIComponent, which also
      // escapes `:`, `@`, `=` and the rest — all legal in a path segment, so
      // escaping them produces a URL that works, is not the one Rails builds,
      // and is not the one anybody types or greps a log for.
      path += `/${escapeSegment(String(value))}`;
    }
    return path === "" ? "/" : path;
  }
}

function stripAnchors(source: string): string {
  return source.replace(/^\^/, "").replace(/\$$/, "");
}

function anchored(constraint: RegExp): RegExp {
  return new RegExp(`^(?:${stripAnchors(constraint.source)})$`, constraint.flags.replace("g", ""));
}

export function normalizePath(path: string): string {
  const trimmed = path.split("?")[0] ?? "";
  const withLeading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withLeading.length > 1 && withLeading.endsWith("/")) return withLeading.slice(0, -1);
  return withLeading;
}
