/**
 * Turning a value into a response body, by the name the action used. Ported
 * from `ActionController::Renderers` and the parts of `Mime::Type` that decide
 * which type a name refers to.
 *
 * An action says `render({ json: invoice })` and something has to know that
 * `json` means "serialise it and answer `application/json`". Rails keeps that
 * in a registry rather than in a chain of conditionals, which buys two things
 * worth having:
 *
 * A format the framework never heard of works the same way as one it did.
 * `render({ csv: rows })` is a three-line registration, and every action gets
 * it — rather than each one building a Response by hand and each one picking a
 * slightly different content type, charset and filename.
 *
 * And it makes the content type follow from the name, in one place. A CSV
 * served as `text/html` opens in the browser instead of downloading, a JSON
 * body served without a charset is decoded by guesswork, and both are the kind
 * of bug that is found by a user rather than a test.
 */

import { MIME_TYPES, registerMimeType } from "./mime.js";

/** What a renderer is handed and what it gives back. */
export interface RenderedBody {
  body: string | Uint8Array;
  contentType: string;
}

export type Renderer = (value: unknown, options: RenderOptions) => RenderedBody;

export interface RenderOptions {
  status?: number;
  contentType?: string;
  /** For the JSONP case, and anything else a renderer wants. */
  [key: string]: unknown;
}

const renderers = new Map<string, Renderer>();

/**
 * Registers one. Rails' `Renderers.add`.
 *
 * Replacing an existing name is allowed, because an application overriding the
 * JSON renderer to add its own envelope is the ordinary reason to call this,
 * and refusing would mean it had to remove first.
 */
export function addRenderer(name: string, renderer: Renderer): void {
  renderers.set(name, renderer);
}

/** Rails' `Renderers.remove`. */
export function removeRenderer(name: string): boolean {
  return renderers.delete(name);
}

/** Every name that can be rendered. Rails' `_all_renderers`. */
export function allRenderers(): string[] {
  return Array.from(renderers.keys());
}

/**
 * The renderers one controller will use. Rails' `use_renderers`.
 *
 * A controller can narrow the set, which is not decoration: an endpoint that
 * only ever answers JSON should not gain an XML response because somebody
 * registered one globally for a different part of the application.
 */
export function useRenderers(names: readonly string[]): Map<string, Renderer> {
  const chosen = new Map<string, Renderer>();

  for (const name of names) {
    const renderer = renderers.get(name);

    if (renderer) chosen.set(name, renderer);
  }

  return chosen;
}

/**
 * Renders whichever key in the options a renderer knows. Rails'
 * `_render_to_body_with_renderer`.
 *
 * Undefined rather than an error when nothing matches: the caller has other
 * ways to render, and this is only the first one asked.
 */
export function renderToBody(
  options: RenderOptions,
  available: Map<string, Renderer> = renderers,
): RenderedBody | undefined {
  for (const [name, renderer] of available) {
    if (!(name in options)) continue;

    const rendered = renderer(options[name], options);

    // An explicit content type wins. A caller that passed one has a reason —
    // an API version in the type, a vendor tree — and the renderer's default
    // is a default.
    return options.contentType === undefined
      ? rendered
      : { ...rendered, contentType: options.contentType };
  }

  return undefined;
}

/**
 * What to answer when there is nothing to send. Rails' `_handle_no_content?`.
 *
 * 204 and 304 must have no body at all — not an empty one. A `Content-Length:
 * 0` on a 304 makes some caches treat the response as a zero-length body and
 * serve that in place of what they had, which empties the page rather than
 * refreshing it.
 */
export function handleNoContent(status: number): boolean {
  return status === 204 || status === 304 || (status >= 100 && status < 200);
}

/**
 * What an action renders when it says nothing. Rails' `default_render`.
 *
 * 204 rather than 200 with an empty body, because a client cannot tell an
 * empty 200 from a 200 whose body it failed to parse, and will usually try to
 * parse it.
 */
export function defaultRender(): { status: number } {
  return { status: 204 };
}

/** Restores the built-in set, for a test that registered its own. */
export function resetRenderers(): void {
  renderers.clear();
  setupRenderers();
}

/**
 * The renderers every application starts with. Rails' `setup_renderer!`.
 *
 * Each names its charset. A JSON body without one is decoded by guesswork,
 * and the guess is wrong exactly when the body contains a name that is not
 * ASCII — which is to say, on the records people complain about.
 */
export function setupRenderers(): void {
  addRenderer("json", (value, options) => {
    const json = typeof value === "string" ? value : JSON.stringify(value);
    const callback = options["callback"];

    // JSONP is a script, not data, and serving it as JSON means the browser
    // will not execute it — which is the whole point of the callback.
    if (typeof callback === "string" && callback !== "") {
      // The leading comment is Rails': it defeats the Rosetta Flash attack,
      // where a response that is *entirely* valid Flash bytecode gets loaded
      // as a cross-domain policy by a crafted SWF.
      return {
        body: `/**/${callback}(${json})`,
        contentType: "text/javascript; charset=utf-8",
      };
    }

    return { body: json, contentType: "application/json; charset=utf-8" };
  });

  addRenderer("js", (value) => ({
    body: String(value),
    contentType: "text/javascript; charset=utf-8",
  }));

  addRenderer("xml", (value) => ({
    body: String(value),
    contentType: "application/xml; charset=utf-8",
  }));

  addRenderer("plain", (value) => ({
    body: String(value),
    contentType: "text/plain; charset=utf-8",
  }));

  addRenderer("html", (value) => ({
    body: String(value),
    contentType: "text/html; charset=utf-8",
  }));

  addRenderer("svg", (value) => ({
    body: String(value),
    // No charset: an SVG declares its own encoding in the document, and a
    // header saying something else is what makes a file render as boxes.
    contentType: "image/svg+xml",
  }));
}

setupRenderers();

/**
 * Another name for a type already registered. Rails' `Mime::Type.register` with
 * aliases.
 *
 * Needed because the same thing has more than one official name and clients
 * pick differently: `text/javascript` and `application/javascript` are the
 * same file, and a `respond_to` that knows only one of them answers 406 to
 * half the callers.
 */
const aliases = new Map<string, string>();

export function registerAlias(alias: string, canonical: string): void {
  aliases.set(alias.toLowerCase(), canonical.toLowerCase());
}

/** The canonical spelling of a content type. */
export function canonicalMimeType(contentType: string): string {
  const bare = (contentType.split(";")[0] ?? "").trim().toLowerCase();

  return aliases.get(bare) ?? bare;
}

/** Every extension registered for a type, so a filename can be built from one. */
const extensions = new Map<string, string>();

export function registerExtension(extension: string, contentType: string): void {
  extensions.set(extension.toLowerCase().replace(/^\./, ""), contentType.toLowerCase());
  registerMimeType(extension.toLowerCase().replace(/^\./, ""), contentType);
}

/** Rails' `Mime::Type.lookup_by_extension`. */
export function lookupByExtension(extension: string): string | undefined {
  return extensions.get(extension.toLowerCase().replace(/^\./, ""));
}

/** Rails' `Mime::Type.unregister`. */
export function unregister(extension: string): void {
  const bare = extension.toLowerCase().replace(/^\./, "");

  extensions.delete(bare);
  aliases.delete(bare);
}

/**
 * How a request body of a given type becomes parameters. Rails'
 * `parameter_parsers`.
 */
export type BodyParser = (body: string) => unknown;

const parsers = new Map<string, BodyParser>();

export function registerBodyParser(contentType: string, parser: BodyParser): void {
  parsers.set(canonicalMimeType(contentType), parser);
}

/** The parser for a response or request of this type. Rails' `response_parser`. */
export function responseParser(contentType: string): BodyParser | undefined {
  return parsers.get(canonicalMimeType(contentType));
}

/** How a value of a given type is written. Rails' `register_encoder`. */
export type BodyEncoder = (value: unknown) => string;

const encoders = new Map<string, BodyEncoder>();

export function registerEncoder(format: string, encoder: BodyEncoder): void {
  encoders.set(format.toLowerCase(), encoder);
}

export function encoderFor(format: string): BodyEncoder | undefined {
  return encoders.get(format.toLowerCase());
}

/** The `Accept` header, taken apart into the types it names, best first. */
export function acceptHeader(request: Request): string[] {
  const header = request.headers.get("accept");

  if (header === null || header.trim() === "") return [];

  return (
    header
      .split(",")
      .map((part) => {
        const [type = "", ...rest] = part.split(";");
        const quality = rest
          .map((each) => /^\s*q=([\d.]+)/.exec(each)?.[1])
          .find((each) => each !== undefined);

        return { type: type.trim().toLowerCase(), quality: quality ? Number(quality) : 1 };
      })
      .filter((each) => each.type !== "")
      // A stable sort, so two types of equal quality stay in the order the
      // client wrote them — which is the order it prefers, and the only signal
      // it has left once the qualities tie.
      .map((each, index) => ({ ...each, index }))
      .sort((a, b) => b.quality - a.quality || a.index - b.index)
      .map((each) => canonicalMimeType(each.type))
  );
}

/**
 * Picks the format to answer with. Rails' `negotiate_mime`.
 *
 * Undefined rather than a default when nothing matches, so the caller can
 * answer 406 — which is a true answer. Falling back to HTML for a client that
 * asked for JSON sends a page to something that will try to parse it, and the
 * error it then reports names the parser rather than the negotiation.
 */
export function negotiateMime(request: Request, offered: readonly string[]): string | undefined {
  const accepted = acceptHeader(request);
  const available = offered.map((format) => ({ format, type: formatContentType(format) }));

  if (accepted.length === 0) return offered[0];

  for (const wanted of accepted) {
    if (wanted === "*/*") return offered[0];

    const match = available.find(
      (each) => each.type === wanted || wildcardMatches(wanted, each.type),
    );

    if (match) return match.format;
  }

  return undefined;
}

/** `text/*` matches `text/html`, and nothing else does. */
function wildcardMatches(wanted: string, offered: string): boolean {
  if (!wanted.endsWith("/*")) return false;

  return offered.startsWith(`${wanted.slice(0, -1)}`);
}

/**
 * The content type a short format name means.
 *
 * `lookupByExtension` first, so an application that registered its own
 * `csv` — or replaced ours — wins over the built-in table.
 */
function formatContentType(format: string): string {
  return canonicalMimeType(lookupByExtension(format) ?? MIME_TYPES[format] ?? format);
}

/**
 * Whether a client will take anything. Rails' `Mime::ALL` / `any` in
 * `respond_to`.
 *
 * Worth a name because it is the case a `respond_to` block has to handle
 * separately: a client sending the match-anything type has expressed no
 * preference, so the
 * application picks, and picking by iterating the Accept header would pick
 * whatever happened to be listed.
 */
export function anyResponse(request: Request): boolean {
  const accepted = acceptHeader(request);

  return accepted.length === 0 || accepted.includes("*/*");
}

/** Restores the registries, for a test that added to them. */
export function resetMimeRegistrations(): void {
  aliases.clear();
  extensions.clear();
  parsers.clear();
  encoders.clear();
  setupMimeRegistrations();
}

export function setupMimeRegistrations(): void {
  registerAlias("text/javascript", "application/javascript");
  registerAlias("application/x-javascript", "application/javascript");
  registerAlias("text/xml", "application/xml");

  registerExtension("csv", "text/csv");
  registerExtension("md", "text/markdown");
  registerExtension("svg", "image/svg+xml");

  registerBodyParser("application/json", (body) => JSON.parse(body) as unknown);
}

setupMimeRegistrations();
