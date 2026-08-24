/**
 * Formats and content negotiation, ported from `ActionDispatch::Http::MimeNegotiation`
 * and `Mime::Type`.
 *
 * One action, several representations:
 *
 *     await this.respondTo({
 *       html: () => this.render.html(<Show post={post} />),
 *       json: () => this.render.json(post),
 *     })
 *
 * Rails decides which by looking at the path extension, then a `format`
 * parameter, then the `Accept` header — in that order, because the first two
 * are explicit and the last is a preference. A link to `/posts/1.json` means
 * JSON no matter what the browser would rather have.
 */

/** The formats Rails registers by default, and what they are sent as. */
export const MIME_TYPES: Record<string, string> = {
  html: "text/html",
  text: "text/plain",
  json: "application/json",
  xml: "application/xml",
  css: "text/css",
  js: "text/javascript",
  csv: "text/csv",
  rss: "application/rss+xml",
  atom: "application/atom+xml",
  pdf: "application/pdf",
  ics: "text/calendar",
};

/** Alternatives a client may send for a format Rails knows by another name. */
const SYNONYMS: Record<string, string> = {
  "application/xhtml+xml": "html",
  "text/javascript": "js",
  "application/javascript": "js",
  "application/x-javascript": "js",
  "text/xml": "xml",
  "application/json; charset=utf-8": "json",
};

/** Registers a format, so an application can serve one Rails does not list. */
export function registerMimeType(format: string, contentType: string): void {
  MIME_TYPES[format] = contentType;
}

/** The format a content type names, or undefined. */
export function formatFor(contentType: string): string | undefined {
  const bare = contentType.split(";")[0]?.trim().toLowerCase() ?? "";

  const direct = Object.entries(MIME_TYPES).find(([, type]) => type === bare)?.[0];
  return direct ?? SYNONYMS[bare];
}

export interface AcceptEntry {
  type: string;
  quality: number;
}

/**
 * Parses `Accept` into types in the order the client actually wants them.
 *
 * Quality values decide the order, and they are the whole point of the header.
 * A browser lists html first, then xhtml, then xml at q=0.9, then a wildcard
 * at q=0.8, and means every bit of it. Reading only the first entry is how an
 * API ends up answering HTML to something that asked for JSON.
 */
export function parseAccept(header: string | null): AcceptEntry[] {
  if (!header) return [];

  return (
    header
      .split(",")
      .map((part) => {
        const [type, ...parameters] = part.trim().split(";");
        const quality = parameters
          .map((parameter) => /^\s*q=([\d.]+)\s*$/.exec(parameter)?.[1])
          .find(Boolean);

        return {
          type: (type ?? "").trim().toLowerCase(),
          quality: quality === undefined ? 1 : Number(quality),
        };
      })
      .filter((entry) => entry.type && !Number.isNaN(entry.quality) && entry.quality > 0)
      // Stable, so equal qualities keep the order they were written in — which
      // is the order the client meant.
      .sort((a, b) => b.quality - a.quality)
  );
}

/** The extension on a path, when it names a format. Rails' `/posts/1.json`. */
export function formatFromPath(pathname: string): string | undefined {
  const extension = /\.([a-z0-9]+)$/i.exec(pathname)?.[1]?.toLowerCase();
  return extension && extension in MIME_TYPES ? extension : undefined;
}

export interface NegotiationOptions {
  /** Formats the action can produce, in the order it declared them. */
  available: readonly string[];
  /** An explicit `?format=` parameter. */
  parameter?: string | null;
}

/**
 * Works out which format to answer with.
 *
 * The order is Rails': an extension, then a parameter, then the header. The
 * first two are somebody stating what they want, and the third is a browser
 * listing what it will accept — a stated choice should not lose to a
 * preference.
 *
 * Returns undefined when nothing matches, which is a 406 rather than a guess.
 */
export function negotiateFormat(request: Request, options: NegotiationOptions): string | undefined {
  const { available } = options;
  if (available.length === 0) return undefined;

  const url = new URL(request.url);

  const explicit = formatFromPath(url.pathname) ?? options.parameter ?? undefined;
  if (explicit) return available.includes(explicit) ? explicit : undefined;

  const accepted = parseAccept(request.headers.get("accept"));

  // No Accept at all means no opinion, so the action's own first choice wins.
  if (accepted.length === 0) return available[0];

  for (const entry of accepted) {
    // `*/*` is "anything", so the action decides. Same for `text/*` within its
    // own family.
    if (entry.type === "*/*") return available[0];

    if (entry.type.endsWith("/*")) {
      const family = entry.type.slice(0, -2);
      const match = available.find((format) => MIME_TYPES[format]?.startsWith(`${family}/`));
      if (match) return match;
      continue;
    }

    const format = formatFor(entry.type);
    if (format && available.includes(format)) return format;
  }

  return undefined;
}

/** Raised when nothing the action can produce is acceptable. */
export class NotAcceptable extends Error {
  constructor(readonly available: readonly string[]) {
    super(`This action can produce ${available.join(", ")}, and none was acceptable.`);
    this.name = "NotAcceptable";
  }
}
