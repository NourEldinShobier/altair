/**
 * Serving files from a directory, ported from `ActionDispatch::Static`.
 *
 *     app.middleware.use("static", serveStatic({ root: "./public" }))
 *
 * In production most applications put a CDN or nginx in front and never reach
 * this. In development there is nothing in front, and Rails ships it for the
 * same reason.
 *
 * The whole subject is which files it will not serve. A static server that
 * joins a request path onto a directory and opens the result will serve
 * `/../../etc/passwd`, and that has been the defect in a great many of them.
 */

import type { Middleware } from "./middleware.js";

export interface StaticOptions {
  /** The directory to serve from. */
  root: string;
  /** Sent with every file. Defaults to an hour. */
  cacheControl?: string;
  /** What a directory resolves to. */
  index?: string;
}

/**
 * Decides what path inside the root a request is asking for, or null.
 *
 * Returns null rather than throwing, because "not a file I will serve" and
 * "an attempt to leave the directory" get the same answer: the request falls
 * through to the application and becomes an ordinary 404. Telling the two
 * apart would tell an attacker which of their guesses was interesting.
 */
export function resolveStaticPath(pathname: string, index = "index.html"): string | null {
  let decoded: string;

  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A malformed escape is not a path.
    return null;
  }

  // A backslash is a separator on Windows and a literal character in a URL, so
  // `..\..\` would climb on the platform where it matters and read as an
  // ordinary filename on the check.
  if (decoded.includes("\\") || decoded.includes("\0")) return null;

  const segments = decoded.split("/").filter((segment) => segment.length > 0);

  // `..` never survives, and neither does `.`. Resolving the path first and
  // comparing prefixes afterwards is the other way to write this, and it is
  // the way that keeps being got wrong: `/public-secret` starts with
  // `/public`.
  if (segments.some((segment) => segment === ".." || segment === ".")) return null;

  if (segments.length === 0) return index;

  // A path ending in a slash is a directory, and a directory is its index.
  return pathname.endsWith("/") ? `${segments.join("/")}/${index}` : segments.join("/");
}

/** The type a browser should read the file as. */
function contentTypeFor(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();

  const types: Record<string, string> = {
    html: "text/html; charset=utf-8",
    css: "text/css; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    mjs: "text/javascript; charset=utf-8",
    json: "application/json; charset=utf-8",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    ico: "image/x-icon",
    woff: "font/woff",
    woff2: "font/woff2",
    txt: "text/plain; charset=utf-8",
    xml: "application/xml",
    pdf: "application/pdf",
    map: "application/json; charset=utf-8",
  };

  return types[extension] ?? "application/octet-stream";
}

/**
 * Serves a file from the root when one matches, and gets out of the way when
 * none does.
 *
 * Only GET and HEAD: a POST to a path that happens to name a file is a request
 * for the application, not for the file.
 */
export function serveStatic(options: StaticOptions): Middleware {
  const root = options.root.replace(/\/+$/, "");
  const index = options.index ?? "index.html";
  const cacheControl = options.cacheControl ?? "public, max-age=3600";

  return async (request, next) => {
    if (request.method !== "GET" && request.method !== "HEAD") return await next(request);

    const relative = resolveStaticPath(new URL(request.url).pathname, index);
    if (relative === null) return await next(request);

    const file = Bun.file(`${root}/${relative}`);
    if (!(await file.exists())) return await next(request);

    // HEAD answers the headers and no body, which is what it is for.
    return new Response(request.method === "HEAD" ? null : file, {
      headers: {
        "content-type": contentTypeFor(relative),
        "content-length": String(file.size),
        "cache-control": cacheControl,
      },
    });
  };
}
