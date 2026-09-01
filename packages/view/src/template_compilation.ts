/**
 * How a template file becomes something that can be rendered, ported from
 * `ActionView::Template::Handlers`, `Template::Resolver`'s path matching, and
 * the digest cache in `ActionView::Digestor`.
 *
 * `lookup_context.ts` decides *which* file; `view_context.ts` decides what is
 * in scope while it runs. This is the step between: reading the name, choosing
 * a handler, compiling once, and knowing when the compiled version is stale.
 *
 * Three decisions carry almost all the weight:
 *
 * - **The filename is the declaration.** `show.html.erb` says format, handler
 *   and — with `show.en.html.erb` — locale, in that order, and every one of
 *   those pieces is optional. Parsing it with anything less than a full
 *   pattern is how `post.json.jbuilder` ends up rendered as HTML: the format
 *   is guessed from the wrong dot.
 * - **A template is compiled once and the compiled form is cached by digest,
 *   not by mtime.** Two machines in a deploy have different mtimes for
 *   identical files, so an mtime cache means the fragment caches on those two
 *   machines disagree — and nothing reports it, because both are internally
 *   consistent.
 * - **A digest includes the templates a template renders.** Changing a partial
 *   has to invalidate every page containing it, and the only way to know which
 *   those are is to record the dependency at compile time. Missing that gives
 *   a cache that serves last week's partial with this week's page around it.
 */

// --- reading a filename ------------------------------------------------------------

export interface TemplatePath {
  prefix: string;
  name: string;
  partial: boolean;
  locale?: string;
  format?: string;
  variant?: string;
  handler?: string;
}

/**
 * Rails' `build_path_regex` — the pattern a template filename is read with.
 *
 * Built from the registered handlers rather than hardcoded, because a handler
 * added by a gem has to be recognised in a filename or its templates are
 * invisible — and "template not found" is what an application sees, which
 * sends the reader to the view directory rather than to the handler.
 */
export function buildPathRegex(
  handlers: readonly string[],
  formats: readonly string[] = ["html", "json", "xml", "text", "js", "css"],
): RegExp {
  const alternatives = (values: readonly string[]) =>
    values.map((value) => value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");

  return new RegExp(
    `^(?<prefix>.*?)(?:^|/)(?<partial>_)?(?<name>[^/]+?)` +
      `(?:\\.(?<locale>[a-z]{2}(?:-[A-Z]{2})?))?` +
      `(?:\\.(?<format>${alternatives(formats)}))?` +
      `(?:\\+(?<variant>[^.]+))?` +
      `(?:\\.(?<handler>${alternatives(handlers)}))?$`,
  );
}

const DEFAULT_HANDLERS = ["erb", "tsx", "jsx", "builder", "raw", "html", "jbuilder"];

let pathPattern = buildPathRegex(DEFAULT_HANDLERS);

/** Rails' `path_regex` — the current pattern, rebuilt when a handler registers. */
export function pathRegex(): RegExp {
  return pathPattern;
}

/**
 * Reads a template path into its pieces.
 *
 * Every piece is optional, which is the awkward part: `show`, `show.erb`,
 * `show.html.erb` and `posts/show.en.html+phone.erb` are all valid and mean
 * different things.
 */
export function parseTemplatePath(path: string): TemplatePath {
  const match = pathPattern.exec(path);
  const groups = match?.groups ?? {};

  return {
    prefix: groups["prefix"] ?? "",
    name: groups["name"] ?? path,
    partial: groups["partial"] !== undefined,
    ...(groups["locale"] === undefined ? {} : { locale: groups["locale"] }),
    ...(groups["format"] === undefined ? {} : { format: groups["format"] }),
    ...(groups["variant"] === undefined ? {} : { variant: groups["variant"] }),
    ...(groups["handler"] === undefined ? {} : { handler: groups["handler"] }),
  };
}

// --- handlers -----------------------------------------------------------------------

export interface Handler {
  name: string;
  compile: (source: string) => string;
  /** Whether the handler produces markup that must not be escaped again. */
  handlesEncoding?: boolean;
}

const handlers = new Map<string, Handler>();

/**
 * Rails' `register_template_handler`.
 *
 * Rebuilds the path pattern, because a handler nothing recognises in a
 * filename has invisible templates — and the application sees "template not
 * found", which sends the reader to the view directory rather than here.
 */
export function registerParser(handler: Handler): void {
  handlers.set(handler.name, handler);
  pathPattern = buildPathRegex([...new Set([...DEFAULT_HANDLERS, ...handlers.keys()])]);
}

export function registeredHandlers(): string[] {
  return [...handlers.keys()];
}

export function resetHandlers(): void {
  handlers.clear();
  pathPattern = buildPathRegex(DEFAULT_HANDLERS);
}

/**
 * Rails' `handles_encoding?`.
 *
 * Whether the handler has already dealt with escaping. A handler that produces
 * markup and is escaped again renders `&lt;p&gt;` to the reader; one that
 * produces text and is *not* escaped renders whatever a user typed as markup.
 * The two failures are opposite and only one of them is visible.
 */
export function handlesEncoding(handlerName: string): boolean {
  return handlers.get(handlerName)?.handlesEncoding ?? false;
}

/**
 * Rails' `erb_trim_mode`.
 *
 * `-` by default, which makes `<%- -%>` strip the newline around a tag.
 * Without it every `<% if %>` leaves a blank line, and a template of nested
 * conditionals produces a page whose source is mostly whitespace — which
 * matters for anything comparing rendered output, including most view tests.
 */
export function erbTrimMode(configured?: string): string {
  return configured ?? "-";
}

/** Rails' `erb_implementation`. */
export function erbImplementation(configured?: string): string {
  return configured ?? "erubi";
}

/** Rails' `mime_types_implementation`. */
export function mimeTypesImplementation(configured?: string): string {
  return configured ?? "mini_mime";
}

/**
 * Rails' `escape_ignore_list` — formats whose output is not HTML-escaped.
 *
 * JavaScript and JSON. Escaping there is not merely unnecessary, it is
 * corrupting: `&quot;` inside a JSON document is not a quote, and the document
 * fails to parse in the browser with an error that names a character position.
 */
export const ESCAPE_IGNORE_LIST: readonly string[] = ["text/javascript", "application/json"];

export function escapeIgnoreList(): string[] {
  return [...ESCAPE_IGNORE_LIST];
}

/**
 * Rails' `force_encoding` — the encoding a template's source is read as.
 *
 * UTF-8 unless the file declares otherwise with a magic comment. Guessing from
 * the bytes is what turns one stray Latin-1 character into a whole template
 * that renders as mojibake, and the guess succeeds — so nothing reports it.
 */
export function forceEncoding(source: string): { encoding: string; source: string } {
  const magic = /^#\s*encoding:\s*([\w-]+)\s*\r?\n/.exec(source);

  if (magic === null) return { encoding: "UTF-8", source };

  return { encoding: magic[1]!.toUpperCase(), source: source.slice(magic[0].length) };
}

// --- compiling ------------------------------------------------------------------------

export interface CompiledTemplate {
  identifier: string;
  body: string;
  digest: string;
  dependencies: string[];
}

const compiled = new Map<string, CompiledTemplate>();

/**
 * Rails' `compile!` — once per template, keyed by source digest.
 *
 * By digest rather than by mtime: two machines in a deploy have different
 * mtimes for identical files, so an mtime key means their fragment caches
 * disagree — and nothing reports it, because each machine is internally
 * consistent.
 */
export function compile(
  identifier: string,
  source: string,
  handler: Handler,
  dependencies: readonly string[] = [],
): CompiledTemplate {
  const digest = digestOf(source);
  const key = `${identifier}:${digest}`;
  const held = compiled.get(key);

  if (held !== undefined) return held;

  const built: CompiledTemplate = {
    identifier,
    body: handler.compile(source),
    digest,
    dependencies: [...dependencies],
  };

  compiled.set(key, built);

  return built;
}

/** Rails' `built_templates` — everything compiled so far. */
export function builtTemplates(): CompiledTemplate[] {
  return [...compiled.values()];
}

export function resetCompiled(): void {
  compiled.clear();
}

function digestOf(value: string): string {
  let hash = 0x811c9dc5;

  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193) >>> 0;
  }

  return hash.toString(16).padStart(8, "0");
}

/**
 * Rails' `eager_load_templates!`.
 *
 * Compiles everything at boot in production. Compiling lazily leaves the first
 * request for each page paying for it — and worse, makes compilation happen
 * under concurrency for the life of the process rather than once, on a single
 * thread, before anything is serving.
 *
 * Reports failures rather than raising on the first, so a deploy that would
 * break four templates says so once.
 */
export function eagerLoadTemplates(
  templates: readonly { identifier: string; source: string; handler: Handler }[],
): { compiled: number; failures: { identifier: string; error: Error }[] } {
  const failures: { identifier: string; error: Error }[] = [];
  let count = 0;

  for (const template of templates) {
    try {
      compile(template.identifier, template.source, template.handler);
      count += 1;
    } catch (error) {
      failures.push({ identifier: template.identifier, error: error as Error });
    }
  }

  return { compiled: count, failures };
}

// --- digests and dependencies -----------------------------------------------------------

const digestCache = new Map<string, string>();

/** Rails' `digest_cache_store`. */
export function digestCacheStore(): Map<string, string> {
  return digestCache;
}

/**
 * Rails' `Digestor#digest` — a template's digest including what it renders.
 *
 * A page's digest folds in its partials', so changing a partial invalidates
 * every page containing it. Without that a fragment cache serves last week's
 * partial inside this week's page, which is a rendering bug nobody can
 * reproduce locally because the local cache is empty.
 *
 * A cycle stops at the template already being visited rather than looping:
 * two partials rendering each other is unusual and not impossible, and hanging
 * at boot is a worse way to report it than a slightly weaker digest.
 */
export function digestTemplate(
  identifier: string,
  ownDigest: string,
  dependenciesOf: (identifier: string) => readonly string[],
  digestOfTemplate: (identifier: string) => string,
  visiting: Set<string> = new Set(),
): string {
  const cached = digestCache.get(identifier);

  if (cached !== undefined) return cached;
  if (visiting.has(identifier)) return ownDigest;

  visiting.add(identifier);

  const parts = [ownDigest];

  for (const dependency of dependenciesOf(identifier)) {
    parts.push(
      digestTemplate(
        dependency,
        digestOfTemplate(dependency),
        dependenciesOf,
        digestOfTemplate,
        visiting,
      ),
    );
  }

  const combined = digestOf(parts.join("/"));
  digestCache.set(identifier, combined);

  return combined;
}

export function resetDigestCache(): void {
  digestCache.clear();
}

/**
 * Rails' `to_dep_map` — the dependency graph as a plain map.
 *
 * Every template appears as a key even with no dependencies, so a caller can
 * tell "renders nothing" from "was never scanned". The two need different
 * responses: the first is a leaf, the second is a hole in the graph that makes
 * every digest downstream of it wrong.
 */
export function toDepMap(
  templates: readonly { identifier: string; dependencies: readonly string[] }[],
): Map<string, string[]> {
  return new Map(templates.map((each) => [each.identifier, [...each.dependencies]]));
}

// --- errors in a template ------------------------------------------------------------------

/**
 * Rails' `translate_location` — a line in compiled output back to the template.
 *
 * A compiled template has a preamble, so an error at compiled line 12 is at
 * template line 12 minus the preamble. Reporting the compiled line sends the
 * reader to a file they cannot open, which is the single most common
 * complaint about template errors in any framework that compiles them.
 */
export function translateLocation(compiledLine: number, preambleLines: number): number {
  return Math.max(1, compiledLine - preambleLines);
}

/**
 * Rails' `source_extract` — the lines around a failure.
 *
 * Marked rather than merely included, because the point is which line failed
 * and a block of five unannotated lines makes the reader count.
 */
export function sourceExtract(
  source: string,
  line: number,
  { context = 2 }: { context?: number } = {},
): string {
  const lines = source.split("\n");
  const from = Math.max(0, line - 1 - context);
  const to = Math.min(lines.length, line + context);

  return lines
    .slice(from, to)
    .map((text, index) => {
      const number = from + index + 1;

      return `${number === line ? ">" : " "} ${String(number).padStart(4)}: ${text}`;
    })
    .join("\n");
}

// --- what a renderer supports ---------------------------------------------------------------

/**
 * Rails' `supports_streaming?`.
 *
 * Only the handlers that can produce output before they have finished.
 * Streaming a handler that builds its result in memory sends nothing until the
 * end and then everything, which is slower than not streaming — the response
 * headers went out early and nothing could be changed afterwards.
 */
export function supportsStreaming(handlerName: string): boolean {
  return handlerName === "erb";
}

let recording = false;

/** Rails' `should_record?` — whether to keep a list of what rendered. */
export function shouldRecord(): boolean {
  return recording;
}

export function setRecording(record: boolean): void {
  recording = record;
}

/**
 * Rails' `render_start` — begins a render, recording it if anything is
 * listening.
 *
 * Returns a function that ends it, so the pair cannot come apart: a start
 * without an end leaves the recorded stack growing for the life of the
 * process, and the tenth render appears nested ten deep inside the first.
 */
export function renderStart(identifier: string, stack: string[] = []): () => void {
  if (!recording) return () => undefined;

  stack.push(identifier);

  return () => {
    stack.pop();
  };
}

/**
 * Rails' `each_with_info` — templates paired with what their filename said.
 *
 * Both together, because a caller choosing between two templates needs the
 * details to compare and the identifier to load, and pairing them afterwards
 * by index is how the two lists get out of step.
 */
export function eachWithInfo(
  identifiers: readonly string[],
): { identifier: string; info: TemplatePath }[] {
  return identifiers.map((identifier) => ({ identifier, info: parseTemplatePath(identifier) }));
}
