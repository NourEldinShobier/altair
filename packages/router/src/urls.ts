/**
 * Turning a path into a full URL, and escaping the pieces correctly. Ported
 * from `ActionDispatch::Journey::Router::Utils` — `escape_path`,
 * `escape_segment`, `escape_fragment` — and `url_for`'s host handling.
 *
 * Two things here, and they are related by the same principle: a URL is not
 * one string with one escaping rule.
 *
 * `encodeURIComponent` escapes everything that could ever be a delimiter
 * anywhere in a URL. In a path segment that is too much: `:`, `@`, `&`, `=`,
 * `+`, `$` and `,` are all legal there, so `/files/report:2026` comes back as
 * `/files/report%3A2026` — which works, and is not what Rails produces, not
 * what a person types, and not what anyone greps a log for. Three escapers
 * rather than one, each allowing what its position allows.
 *
 * The host is the other half. A path is enough for a link on a page and not
 * enough for anything that leaves it: an email, a webhook, a redirect a client
 * follows, a canonical tag. Those need a host the application knows and the
 * request does not always carry.
 */

/**
 * Characters legal unescaped in a path segment, beyond the unreserved set.
 *
 * From RFC 3986's `pchar`, minus `/` — which is what separates segments and is
 * exactly the character that must not survive, since a value containing one
 * would otherwise add a segment and route somewhere else entirely.
 */
const SEGMENT_SAFE = ":@&=+$,;";

/** The same, plus `/`, for a value that is itself a path. */
const PATH_SAFE = `${SEGMENT_SAFE}/`;

/** A fragment may hold anything a path may, plus `?`. */
const FRAGMENT_SAFE = `${PATH_SAFE}?`;

function escapeWith(value: string, safe: string): string {
  return encodeURIComponent(value).replaceAll(/%[0-9A-F]{2}/gi, (escaped) => {
    const code = Number.parseInt(escaped.slice(1), 16);

    // Only single-byte escapes are candidates. Anything above 0x7F is one byte
    // of a multi-byte character, and decoding it alone is both meaningless and
    // an error — `%C3` is half of `é` and `decodeURIComponent` throws on it.
    if (code > 0x7f) return escaped;

    const character = String.fromCharCode(code);

    return safe.includes(character) ? character : escaped;
  });
}

/**
 * One path segment. Rails' `escape_segment`.
 *
 * `/` is escaped, and that is the whole point: an id or a slug containing one
 * would otherwise add a segment, and `/posts/a/b` is a different route from
 * `/posts/a%2Fb` — the first probably a 404 and the second the record somebody
 * meant.
 */
export function escapeSegment(value: string): string {
  return escapeWith(value, SEGMENT_SAFE);
}

/** A whole path, where `/` is a separator rather than data. Rails' `escape_path`. */
export function escapePath(value: string): string {
  return escapeWith(value, PATH_SAFE);
}

/** Everything after the `#`. Rails' `escape_fragment`. */
export function escapeFragment(value: string): string {
  return escapeWith(value, FRAGMENT_SAFE);
}

/** Where the application lives, for a URL that has to leave the page. */
export interface UrlOptions {
  host?: string;
  protocol?: string;
  port?: number;
  /** Prefixed to every path, for an application mounted under one. */
  scriptName?: string;
}

let defaults: UrlOptions = {};

/**
 * The host and protocol a full URL uses when none is given. Rails'
 * `default_url_options`.
 *
 * Configured once rather than passed at every call, because the alternative is
 * that some caller forgets and sends a mail containing `http://localhost:3000`
 * — which is the classic version of this bug and reaches a real person before
 * anybody notices.
 */
export function defaultUrlOptions(): UrlOptions {
  return { ...defaults };
}

export function setDefaultUrlOptions(options: UrlOptions): void {
  defaults = { ...options };
}

export function resetDefaultUrlOptions(): void {
  defaults = {};
}

/** Raised when a full URL was asked for and nothing knows the host. */
export class MissingHost extends Error {
  constructor() {
    super(
      "Cannot build a full URL without a host. Set one with setDefaultUrlOptions({ host }), " +
        "or pass `host` — a mail or a webhook has no request to take it from.",
    );
    this.name = "MissingHost";
  }
}

/**
 * A path made absolute. Rails' `url_for` with `only_path: false`.
 *
 * Throws rather than guessing when no host is known. A URL built against a
 * guessed host is a link that goes somewhere wrong, sent to somebody, and
 * discovered by them — which is worse than a failure at the point of building
 * it.
 */
export function fullUrlFor(path: string, options: UrlOptions = {}): string {
  const merged = { ...defaults, ...options };

  if (merged.host === undefined || merged.host === "") throw new MissingHost();

  const protocol = (merged.protocol ?? "https").replace(/:\/*$/, "");
  const port = portFor(merged.port, protocol);
  const script = merged.scriptName === undefined ? "" : trimSlash(merged.scriptName);
  const rest = path.startsWith("/") ? path : `/${path}`;

  return `${protocol}://${merged.host}${port}${script}${rest}`;
}

/**
 * The default port for a scheme is left off.
 *
 * A URL carrying `:443` is the same URL and does not look like it: it will not
 * match a canonical tag, an OAuth redirect registration, or a cookie's domain
 * check, and every one of those fails in a way that names something else.
 */
function portFor(port: number | undefined, protocol: string): string {
  if (port === undefined) return "";
  if (protocol === "https" && port === 443) return "";
  if (protocol === "http" && port === 80) return "";

  return `:${String(port)}`;
}

function trimSlash(value: string): string {
  const trimmed = value.replace(/\/+$/, "");

  return trimmed === "" || trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/** Whether a full URL could be built right now, for a caller that would rather ask. */
export function canBuildFullUrl(options: UrlOptions = {}): boolean {
  const host = options.host ?? defaults.host;

  return host !== undefined && host !== "";
}
