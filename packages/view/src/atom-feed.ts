/**
 * An Atom feed, ported from `ActionView::Helpers::AtomFeedHelper`.
 *
 * Feeds are read by strict XML parsers, not by browsers, and that one fact is
 * behind most of what is here. A browser guesses at broken markup; a feed
 * reader rejects the document. So an unescaped `&` in one post's title does
 * not break that post — it takes down the whole feed, for every subscriber, at
 * once, and the only symptom is that nobody's reader updates any more.
 *
 * The rest is Atom's own requirements, which are stricter than RSS's and are
 * the reason to prefer it:
 *
 * - **Every entry needs a permanent, globally unique id**, and it must not be
 *   the URL. A post that moves keeps its id; a reader that used the URL shows
 *   the moved post as new, and everybody who subscribed sees a year of
 *   archives arrive again. `tagUri` builds the `tag:` URI Atom recommends for
 *   this — the date in it is *fixed*, not today's, because an id built from
 *   the current date is a new id every day.
 * - **The feed must link to itself.** Without `rel="self"` an aggregator that
 *   was handed the document — rather than fetching it — has no base to resolve
 *   relative URLs against, and some refuse it outright.
 * - **Timestamps are RFC 3339**, which `Date#toISOString` already is. The one
 *   that gets forgotten is that `updated` is *required*, on the feed and on
 *   every entry.
 */

import { escapeHtml } from "./render.js";

export interface AtomAuthor {
  name: string;
  email?: string;
  uri?: string;
}

/** How an entry's content should be read. */
export type AtomContentType = "text" | "html" | "xhtml";

export interface AtomEntry {
  /** Permanent and unique. Use `tagUri`, not the URL. */
  id: string;
  title: string;
  /** The page this entry is about. */
  url?: string;
  updated: Date;
  published?: Date;
  summary?: string;
  content?: string;
  /**
   * `text` and `html` are escaped. `xhtml` is not — it is markup, and it is
   * emitted inside the namespaced `div` the spec requires.
   */
  contentType?: AtomContentType;
  author?: AtomAuthor;
}

export interface AtomFeedOptions {
  title: string;
  /** Where this feed itself lives, for the `self` link. */
  url: string;
  /** The page a reader should be sent to. */
  alternateUrl: string;
  /** Permanent and unique. Defaults to the feed's own URL as a tag URI. */
  id?: string;
  subtitle?: string;
  /** Defaults to the newest entry's. */
  updated?: Date;
  language?: string;
  author?: AtomAuthor;
}

/**
 * A `tag:` URI, the identifier scheme Atom recommends. Rails builds these in
 * `atom_feed` and `entry`.
 *
 * The date is a *fixed* date the publisher chose once — the year they took the
 * domain, usually — and never changes. It is there so that two people who have
 * owned the same domain at different times cannot mint the same id. Passing
 * today's date instead, which is the obvious thing to do, makes every id
 * change daily and every subscriber see the whole archive as new every
 * morning.
 */
export function tagUri(host: string, schemaDate: string, path: string): string {
  return `tag:${host},${schemaDate}:${path}`;
}

/**
 * The feed document.
 *
 * `updated` falls back to the newest entry's, because a feed whose `updated`
 * is older than an entry's is one a conditional-request cache will serve
 * stale forever. An empty feed with no `updated` is refused rather than
 * stamped with the current time: a feed that changes on every request defeats
 * every cache between here and the reader, and `If-Modified-Since` stops
 * meaning anything.
 */
export function atomFeed(options: AtomFeedOptions, entries: readonly AtomEntry[]): string {
  const updated = options.updated ?? newest(entries);

  if (updated === undefined) {
    throw new TypeError(
      "An Atom feed needs an `updated`, and this one has no entries to take it from. Pass the " +
        "time the feed itself last changed — stamping it with the current time would make every " +
        "response different and defeat every cache between here and the reader.",
    );
  }

  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="${escapeHtml(options.language ?? "en-US")}">`,
    element("id", options.id ?? options.url),
    element("title", options.title),
    ...(options.subtitle === undefined ? [] : [element("subtitle", options.subtitle)]),
    element("updated", updated.toISOString()),
    `  <link rel="alternate" type="text/html" href="${escapeHtml(options.alternateUrl)}"/>`,
    `  <link rel="self" type="application/atom+xml" href="${escapeHtml(options.url)}"/>`,
    ...author(options.author),
    ...entries.map((entry) => atomEntry(entry)),
    `</feed>`,
  ];

  return `${lines.join("\n")}\n`;
}

/** One entry. */
export function atomEntry(entry: AtomEntry): string {
  const lines = [
    `  <entry>`,
    indent(element("id", entry.id)),
    indent(element("title", entry.title)),
    indent(element("updated", entry.updated.toISOString())),
    ...(entry.published === undefined
      ? []
      : [indent(element("published", entry.published.toISOString()))]),
    ...(entry.url === undefined
      ? []
      : [`    <link rel="alternate" type="text/html" href="${escapeHtml(entry.url)}"/>`]),
    ...(entry.summary === undefined ? [] : [indent(element("summary", entry.summary))]),
    ...content(entry),
    ...author(entry.author).map((line) => indent(line)),
    `  </entry>`,
  ];

  return lines.join("\n");
}

/**
 * The content element.
 *
 * `xhtml` is the case with a rule of its own: the markup has to sit inside a
 * `div` in the XHTML namespace. Without the wrapper a reader has no way to
 * tell the entry's markup from Atom's own elements, and the well-behaved ones
 * drop the content rather than guess.
 */
function content(entry: AtomEntry): string[] {
  if (entry.content === undefined) return [];

  const type = entry.contentType ?? "html";

  if (type !== "xhtml") {
    return [indent(`<content type="${type}">${escapeHtml(entry.content)}</content>`)];
  }

  return [
    `    <content type="xhtml">`,
    `      <div xmlns="http://www.w3.org/1999/xhtml">${entry.content}</div>`,
    `    </content>`,
  ];
}

function author(who: AtomAuthor | undefined): string[] {
  if (who === undefined) return [];

  return [
    `  <author>`,
    indent(element("name", who.name)),
    ...(who.email === undefined ? [] : [indent(element("email", who.email))]),
    ...(who.uri === undefined ? [] : [indent(element("uri", who.uri))]),
    `  </author>`,
  ];
}

/** One element with escaped text. Everything that is not markup goes through here. */
function element(name: string, text: string): string {
  return `  <${name}>${escapeHtml(text)}</${name}>`;
}

function indent(line: string): string {
  return `  ${line}`;
}

/** The newest entry's `updated`, or nothing when there are no entries. */
function newest(entries: readonly AtomEntry[]): Date | undefined {
  let latest: Date | undefined;

  for (const entry of entries) {
    if (latest === undefined || entry.updated > latest) latest = entry.updated;
  }

  return latest;
}
