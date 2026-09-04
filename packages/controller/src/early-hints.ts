/**
 * Telling the browser what to fetch before the page exists, ported from
 * `ActionDispatch::Request#send_early_hints`.
 *
 * A page's stylesheet is discovered when the browser parses the `<head>`,
 * which is after the server has finished rendering. On a slow query that is
 * hundreds of milliseconds in which the connection is idle and the browser has
 * nothing to do. A 103 response sent *before* the real one carries the same
 * `Link` headers the page would have, so the fetches start while the server is
 * still working.
 *
 * The reason to be careful is that a hint is a guess, and a wrong guess costs
 * more than no guess:
 *
 * - **A hint for something the page does not use** is a fetch nobody needed,
 *   competing for connections with the ones that were.
 * - **A hint with the wrong `as`** is fetched *twice*: the preload sits in the
 *   cache under one destination and the page asks for another, so the browser
 *   fetches it again — and the page is slower than with no hint at all.
 * - **A hint for a URL the response does not end up sending** is worse than
 *   useless on a page that varies: a 103 cannot be taken back.
 */

/** What a browser will do with a preloaded resource. */
export type PreloadAs =
  | "script"
  | "style"
  | "font"
  | "image"
  | "fetch"
  | "document"
  | "audio"
  | "video"
  | "track";

export interface PreloadLink {
  href: string;
  as: PreloadAs;
  /** `preload` starts the fetch now; `preconnect` only opens the connection. */
  rel?: "preload" | "preconnect" | "modulepreload";
  type?: string;
  /**
   * Required for a font, and for anything fetched from another origin that the
   * page will request with credentials.
   */
  crossorigin?: "anonymous" | "use-credentials";
  /** A media query, so a hint for a print stylesheet costs nothing on screen. */
  media?: string;
  nonce?: string;
}

export class MissingCrossOrigin extends TypeError {
  constructor(href: string) {
    super(
      `A font preload needs a crossorigin, and ${JSON.stringify(href)} has none. Fonts are ` +
        `fetched in anonymous mode whatever the page says, so a preload without it lands in a ` +
        `different cache entry from the request the page makes — and the font is fetched twice, ` +
        `which is slower than not preloading it.`,
    );
    this.name = "MissingCrossOrigin";
  }
}

/**
 * One `Link` header value.
 *
 * The parameters are emitted in a fixed order rather than whatever order the
 * object happened to have. A header that varies by key order defeats every
 * cache and every test that compares one.
 */
export function preloadLink(link: PreloadLink): string {
  if (link.as === "font" && link.crossorigin === undefined) throw new MissingCrossOrigin(link.href);

  const parts = [`<${link.href}>`, `rel=${link.rel ?? "preload"}`, `as=${link.as}`];

  if (link.type !== undefined) parts.push(`type=${link.type}`);
  if (link.crossorigin !== undefined) parts.push(`crossorigin=${link.crossorigin}`);
  if (link.media !== undefined) parts.push(`media="${link.media}"`);
  if (link.nonce !== undefined) parts.push(`nonce=${link.nonce}`);

  return parts.join("; ");
}

/**
 * The `Link` values a 103 carries, one per hint.
 *
 * A list rather than a joined string, because every hint is checked on its own
 * — a font with no origin mode is refused here, before anything is sent, and
 * not discovered as a duplicate fetch in somebody's network tab.
 */
export function earlyHintsLinks(links: readonly PreloadLink[]): string[] {
  return links.map((link) => preloadLink(link));
}

/**
 * The headers a 103 carries. Rails' `send_early_hints`.
 *
 * Nothing at all for no links, rather than an empty `Link:` header — an empty
 * header is a 103 that told the browser nothing and cost it a round trip to
 * read.
 *
 * Appended one at a time rather than joined by hand: the platform decides how
 * repeated headers are represented, and a hand-joined value is one comma away
 * from a URL that is fetched as two.
 */
export function earlyHintsHeaders(links: readonly PreloadLink[]): Headers | undefined {
  if (links.length === 0) return undefined;

  const headers = new Headers();

  for (const value of earlyHintsLinks(links)) headers.append("link", value);

  return headers;
}

/** What a server needs to be able to do for hints to be sendable. */
export interface EarlyHintsSender {
  sendEarlyHints?: (headers: Headers) => void;
}

/**
 * Sends the hints, if the server can send them.
 *
 * Silently does nothing when it cannot, and that is deliberate: early hints
 * are an optimisation, HTTP/1.1 clients and most proxies cannot carry them,
 * and an application that raised here would be an application that cannot be
 * deployed behind an ordinary load balancer.
 *
 * Returns whether they went, so a caller that wants to know can ask rather
 * than guess.
 */
export function sendEarlyHints(sender: EarlyHintsSender, links: readonly PreloadLink[]): boolean {
  const headers = earlyHintsHeaders(links);

  if (headers === undefined || sender.sendEarlyHints === undefined) return false;

  sender.sendEarlyHints(headers);

  return true;
}
