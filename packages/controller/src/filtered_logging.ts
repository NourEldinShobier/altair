/**
 * What a request looks like once the secrets are taken out, ported from
 * `ActionDispatch::Http::FilterParameters` — `filtered_path`,
 * `filtered_parameters`, and the three parameter sources kept apart.
 *
 * `ParameterFilter` already redacted a body. Nothing redacted a *path*, and
 * that is where the leak is: a request log line carries the URL, a URL carries
 * its query string, and a query string carries the password-reset token, the
 * API key somebody put in a link, the signed download URL. Every one of those
 * then sits in the log aggregator, in the load balancer's access log, and in
 * whatever a support engineer pastes into a ticket.
 *
 * The three sources are kept apart for a different reason. Knowing whether a
 * value came from the route, the query string or the body is a security
 * question — a token that is only valid in a body should not be accepted from
 * a URL, where it will be logged and shared — and merging them first makes
 * that question unanswerable.
 */

import { ParameterFilter } from "@altair/support";

/** The values a request carries, by where they came from. */
export interface ParameterSources {
  /** Filled in by the router from the path: `/posts/:id`. */
  path: Record<string, string>;
  /** The query string. */
  query: Record<string, unknown>;
  /** The body. */
  request: Record<string, unknown>;
}

/** The path parameters the router matched. Rails' `path_parameters`. */
export function pathParameters(sources: Partial<ParameterSources>): Record<string, string> {
  return { ...sources.path };
}

/** The query string's parameters. Rails' `query_parameters`. */
export function queryParametersOf(request: Request): Record<string, unknown> {
  const found: Record<string, unknown> = {};

  for (const [key, value] of new URL(request.url).searchParams) {
    const existing = found[key];

    // Repeated keys become a list rather than the last one winning: `?tag=a&
    // tag=b` means both, and keeping only `b` silently drops half a filter.
    if (existing === undefined) found[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else found[key] = [existing, value];
  }

  return found;
}

/** The body's parameters. Rails' `request_parameters`. */
export function requestParameters(sources: Partial<ParameterSources>): Record<string, unknown> {
  return { ...sources.request };
}

/**
 * The parameters with every secret replaced. Rails' `filtered_parameters`.
 *
 * All three sources together, because this is for a log line and a log line
 * wants what the action saw. The separation matters to code making decisions,
 * not to somebody reading a log.
 */
export function filteredParameters(
  sources: Partial<ParameterSources>,
  filter: ParameterFilter = new ParameterFilter(),
): Record<string, unknown> {
  return filter.filter({
    ...sources.path,
    ...sources.query,
    ...sources.request,
  }) as Record<string, unknown>;
}

/**
 * The path with its query string redacted. Rails' `filtered_path`.
 *
 * The value replaced rather than the parameter dropped, so the shape of the
 * request is still legible: `?token=[FILTERED]` says a token was sent and
 * `?` says nothing at all, and the difference matters when the question is
 * why a request failed.
 */
export function filteredPath(
  request: Request | string,
  filter: ParameterFilter = new ParameterFilter(),
): string {
  const url = typeof request === "string" ? asUrl(request) : new URL(request.url);

  if (url === null) return typeof request === "string" ? request : "";

  if (url.search === "") return url.pathname;

  const parameters = new URLSearchParams();

  for (const [key, value] of url.searchParams) {
    parameters.append(key, filter.matches(key) ? "[FILTERED]" : value);
  }

  // Written back with the parameters in the order they arrived, so a filtered
  // path and an unfiltered one can be compared line for line.
  return `${url.pathname}?${decodeBrackets(parameters.toString())}`;
}

/**
 * The full path, filtered, including the fragment-free query. Rails'
 * `filtered_path` is what a log writes; this is the same for a URL that has to
 * keep its host — a redirect being logged, an outbound call being recorded.
 */
export function filteredUrl(
  request: Request | string,
  filter: ParameterFilter = new ParameterFilter(),
): string {
  const url = typeof request === "string" ? asUrl(request) : new URL(request.url);

  if (url === null) return typeof request === "string" ? request : "";

  return `${url.origin}${filteredPath(url.toString(), filter)}`;
}

function asUrl(value: string): URL | null {
  try {
    return new URL(value, "https://placeholder.invalid");
  } catch {
    return null;
  }
}

/**
 * `a%5B%5D=1` back to `a[]=1`.
 *
 * Brackets are legal in a query string and every framework writes them
 * unescaped, so a log line that escapes them does not match the one the client
 * sent — which is the thing somebody is grepping for.
 */
function decodeBrackets(query: string): string {
  return query.replaceAll("%5B", "[").replaceAll("%5D", "]");
}
