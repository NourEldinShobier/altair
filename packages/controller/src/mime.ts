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

/** What happens when the registry changes. Rails' `on_change`. */
export type MimeChange = (format: string, registered: boolean) => void;

const changeCallbacks: MimeChange[] = [];

/**
 * Rails' `on_change` — told when a format is registered or removed.
 *
 * A hook because the registry is read into other structures: a router's format
 * constraint, a renderer's table, a cached Accept parse. Those are built once
 * and would otherwise never learn about a format an initializer added, so the
 * new format negotiates correctly in one place and 406s in another.
 */
export function onChange(callback: MimeChange): void {
  changeCallbacks.push(callback);
}

/** Rails' `register_callback` — told only about registrations. */
export function registerCallback(callback: (format: string) => void): void {
  onChange((format, registered) => {
    if (registered) callback(format);
  });
}

export function resetMimeCallbacks(): void {
  changeCallbacks.length = 0;
}

/** Registers a format, so an application can serve one Rails does not list. */
export function registerMimeType(format: string, contentType: string): void {
  MIME_TYPES[format] = contentType;

  for (const callback of changeCallbacks) callback(format, true);
}

/**
 * Rails' `unregister` — takes a format back out.
 *
 * Mostly a test's concern, and it has to tell the callbacks too: a renderer
 * that kept a format the registry no longer has answers with a content type
 * nothing will now parse.
 */
export function unregisterMimeType(format: string): void {
  if (!(format in MIME_TYPES)) return;

  delete MIME_TYPES[format];

  for (const callback of changeCallbacks) callback(format, false);
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

  const entries = header
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
    // A family is expanded here rather than at negotiation, so everything
    // downstream sees a list of concrete types and nothing has to know that
    // `text/*` was ever written.
    .flatMap((entry) => {
      const family = parseTrailingStar(entry.type);

      if (family === undefined) return [entry];

      return family.map((format) => ({
        type: MIME_TYPES[format] as string,
        quality: entry.quality,
      }));
    })
    // Stable, so equal qualities keep the order they were written in — which
    // is the order the client meant.
    .sort((a, b) => b.quality - a.quality);

  return sortAcceptEntries(entries);
}

/**
 * Rails' `parse_data_with_trailing_star` — every format in a media family.
 *
 * `text` gives every `text/*` format the application can produce. Which ones
 * those are is a question about the *registry*, not about the header, which is
 * why an application that registered a format gets it here for free.
 */
export function parseDataWithTrailingStar(mediaType: string): string[] {
  const prefix = `${mediaType.toLowerCase()}/`;

  return Object.entries(MIME_TYPES)
    .filter(([, contentType]) => contentType.toLowerCase().startsWith(prefix))
    .map(([format]) => format);
}

/**
 * Rails' `parse_trailing_star` — a family in an Accept header, expanded.
 *
 * `Accept: text/*` is a client saying "any text format you have". Matched
 * literally it matches nothing the application declares, and the request gets a
 * 406 for a header that was in fact satisfiable — which is how a `curl` with a
 * broad Accept, or a proxy that rewrote one, fails against an API that would
 * have answered.
 *
 * Only `text` and `application` expand. `image/*` is a family this framework
 * negotiates nothing in, and a bare wildcard is not a family at
 * all — it is "anything", which the negotiation already handles as a last
 * resort.
 */
export function parseTrailingStar(entry: string): string[] | undefined {
  const family = /^(text|application)\/\*/.exec(entry.trim().toLowerCase())?.[1];

  return family === undefined ? undefined : parseDataWithTrailingStar(family);
}

/**
 * Rails' `find_item_by_name` — where a type sits in a parsed Accept list.
 *
 * By index rather than by value, because the fix-ups that use it *reorder* the
 * list, and a reorder needs to know where both entries are.
 */
export function findItemByName(entries: readonly AcceptEntry[], type: string): number {
  return entries.findIndex((entry) => entry.type === type);
}

/**
 * Rails' `AcceptList.sort!` — the two orderings a raw quality sort gets wrong.
 *
 * `text/xml` and `application/xml` are the same thing, and a client that sends
 * both means one preference, not two. Left as two entries the weaker spelling
 * can outrank a genuinely different format sitting between them.
 *
 * A more specific XML type — `application/atom+xml`, `application/rss+xml` —
 * sorts ahead of plain `application/xml` at the same quality. A feed reader
 * sends both and means the specific one; answering generic XML gives it a
 * document it cannot read, with a 200.
 */
export function sortAcceptEntries(entries: readonly AcceptEntry[]): AcceptEntry[] {
  const sorted = [...entries];
  const textXml = findItemByName(sorted, "text/xml");
  const appXml = findItemByName(sorted, "application/xml");

  if (textXml !== -1 && appXml !== -1) {
    // One preference, at the higher of the two qualities: a client that spelled
    // it both ways did not ask for it twice, and did not ask for it more weakly
    // than its strongest spelling.
    sorted[appXml] = {
      type: "application/xml",
      quality: Math.max(sorted[appXml]?.quality ?? 0, sorted[textXml]?.quality ?? 0),
    };
    sorted.splice(textXml, 1);
  } else if (textXml !== -1) {
    sorted[textXml] = { type: "application/xml", quality: sorted[textXml]?.quality ?? 1 };
  }

  const xmlAt = findItemByName(sorted, "application/xml");

  if (xmlAt !== -1) {
    const xml = sorted[xmlAt] as AcceptEntry;
    const specific = sorted.findIndex(
      (entry, at) => at > xmlAt && entry.quality >= xml.quality && entry.type.endsWith("+xml"),
    );

    if (specific !== -1) {
      sorted[xmlAt] = sorted[specific] as AcceptEntry;
      sorted[specific] = xml;
    }
  }

  return sorted;
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
