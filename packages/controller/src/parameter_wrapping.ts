/**
 * Nesting a JSON body under the model's name, ported from
 * `ActionController::ParamsWrapper`, and the registry of body parsers from
 * `ActionDispatch::Http::Parameters`.
 *
 * The problem is that the same action serves two clients that disagree about
 * shape. A form generated for `Post` posts `post[title]=x`, so the action reads
 * `params.require("post")`. An API client posts `{"title": "x"}` — flat,
 * because that is what every other JSON API in the world takes — and the same
 * `require("post")` finds nothing.
 *
 * Without wrapping, an application either writes the action twice or asks its
 * API clients to nest, which no other API does and every client gets wrong once.
 * Rails wraps instead: a flat JSON body is nested under the controller's model
 * name before the action sees it, so one piece of strong-parameters code serves
 * both and the API stays the shape people expect.
 *
 * It applies to JSON only. A form body is already nested — wrapping it again
 * would produce `post[post][title]`.
 */

/** How one controller wants its bodies wrapped. Rails' `wrap_parameters`. */
export interface WrapOptions {
  /** The key to nest under. Usually the model's name, lowercased. */
  name: string;
  /**
   * Only these keys are moved inside. Rails derives them from the model's
   * columns, which is what stops a client smuggling `admin` in beside the
   * attributes an action means to permit.
   */
  include?: readonly string[];
  /** These are never moved, whatever else is. */
  exclude?: readonly string[];
}

/**
 * Keys that stay at the top level however a controller is configured.
 *
 * They are protocol, not attributes. Wrapping the authenticity token would put
 * it where forgery protection does not look, so every JSON post would start
 * failing its CSRF check for a reason nothing reports.
 */
const NEVER_WRAPPED = new Set(["controller", "action", "_json", "authenticity_token", "format"]);

/**
 * Nests a flat body under its model name. Rails' `wrap_parameters`.
 *
 * The wrapped copy is added beside the original keys rather than replacing
 * them, which is Rails' behaviour: an action that was reading `params.get
 * ("title")` keeps working, and one reading `params.require("post")` starts
 * working. Replacing them would break every existing action the day wrapping
 * was switched on.
 */
export function wrapParameters(
  params: Record<string, unknown>,
  options: WrapOptions,
): Record<string, unknown> {
  // Already nested — a form body, or a client that wrapped it itself. Wrapping
  // again gives post[post][title], which nothing reads.
  if (options.name in params) return params;

  const exclude = new Set(options.exclude ?? []);
  const wrapped: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(params)) {
    if (NEVER_WRAPPED.has(key) || exclude.has(key)) continue;
    if (options.include !== undefined && !options.include.includes(key)) continue;

    wrapped[key] = value;
  }

  if (Object.keys(wrapped).length === 0) return params;

  return { ...params, [options.name]: wrapped };
}

/** Whether a content type is one wrapping applies to. */
export function isWrappableContentType(contentType: string | null | undefined): boolean {
  const type = contentType?.split(";")[0]?.trim().toLowerCase();

  if (type === undefined) return false;

  return type === "application/json" || type.endsWith("+json");
}

/** Reads a body of one content type into params. Rails' parameter parser. */
export type ParameterParser = (request: Request) => Promise<Record<string, unknown>>;

const parsers = new Map<string, ParameterParser>();

/**
 * Registers a parser for a content type. Rails' `parameter_parsers`.
 *
 * The extension point that makes a body format the framework does not know
 * about — msgpack, CBOR, a vendor type — reachable as ordinary params, rather
 * than something every action has to read off the request itself and every
 * action gets subtly differently.
 */
export function registerParameterParser(contentType: string, parser: ParameterParser): void {
  parsers.set(normalizeType(contentType), parser);
}

/** Forgets a registered parser. */
export function removeParameterParser(contentType: string): void {
  parsers.delete(normalizeType(contentType));
}

/** Forgets every registered parser. For a test, and for a reload. */
export function resetParameterParsers(): void {
  parsers.clear();
}

/** The content types a parser has been registered for. */
export function parameterParsers(): string[] {
  return [...parsers.keys()];
}

/**
 * The parser for a content type, or undefined.
 *
 * Matched on the type alone, so a charset or a boundary on the header does not
 * stop a registered parser being found — which is the failure that looks like
 * the registration never happened.
 */
export function parameterParserFor(
  contentType: string | null | undefined,
): ParameterParser | undefined {
  const type = contentType?.split(";")[0]?.trim().toLowerCase();

  return type === undefined ? undefined : parsers.get(type);
}

function normalizeType(contentType: string): string {
  return (contentType.split(";")[0] ?? "").trim().toLowerCase();
}
