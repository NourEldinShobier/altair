/**
 * Finding the right template for a request, ported from
 * `ActionView::LookupContext`, `ActionView::PathRegistry` and
 * `ActionView::Resolver`.
 *
 * Rendering here is JSX, so a "template" is a component rather than a file, but
 * the lookup problem is the same one and we did not have it: `render("posts/
 * post")` has to pick between a plain component, a `.json` one, a `phone`
 * variant, and a French translation — and the answer depends on the request,
 * not the call site. Without this the caller has to know which of those exists,
 * which puts a conditional in every action.
 *
 * The details are ordered, and that order is the whole feature. A request that
 * accepts `[html, text]` and runs the `phone` variant must get the phone HTML
 * component if there is one, plain HTML if not, and only then text. Sorting by
 * "most specific match" would be wrong: `[text, html]` from an Accept header
 * means the client *prefers* text, and a lookup that returned HTML because HTML
 * matched more details would ignore what the client asked for.
 *
 * The other half is the cache key. Lookups happen per render and a miss walks
 * every registered path, so the result is cached — and the key has to include
 * every detail that could change the answer. A key missing `variant` is how a
 * phone user gets served the desktop component that a previous request warmed
 * the cache with, which is invisible in every test that runs one request.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import type { Component } from "./render.js";

/** What a template was registered for. */
export interface TemplateDetails {
  /** `html`, `json`, `text` — the format the component renders. */
  format?: string;
  /** `phone`, `tablet` — Rails' `variant`. */
  variant?: string;
  locale?: string;
  /** The prefix a partial was registered under, e.g. `posts`. */
  prefix?: string;
}

/** What a request is asking for, each list in order of preference. */
export interface RequestedDetails {
  formats?: readonly string[];
  variants?: readonly string[];
  locales?: readonly string[];
  prefixes?: readonly string[];
}

export interface RegisteredTemplate extends TemplateDetails {
  /** The logical name, without prefix: `post`, `index`. */
  name: string;
  component: Component;
  /** Where it came from, for error messages. Rails' `short_identifier`. */
  identifier?: string;
}

/** The order details are compared in, and the order a cache key is built in. */
export const DETAIL_NAMES = ["locale", "format", "variant"] as const;

export type DetailName = (typeof DETAIL_NAMES)[number];

const registeredDetailDefaults: Record<string, () => readonly string[]> = {
  locale: () => [],
  format: () => ["html"],
  variant: () => [],
};

/**
 * Adds a detail templates can be selected on. Rails' `register_detail`.
 *
 * Open rather than fixed because a detail is how an application says "this
 * component is for the print stylesheet" or "for the embedded viewer" without
 * either the renderer or the caller learning about it.
 */
export function registerDetail(name: string, fallback: () => readonly string[]): void {
  registeredDetailDefaults[name] = fallback;
}

export function registeredDetails(): string[] {
  return Object.keys(registeredDetailDefaults);
}

// --- the registry ----------------------------------------------------------

/**
 * A place templates are registered. Rails' `Resolver`, one per view path.
 *
 * Separate objects rather than one flat map because order matters between
 * them: an engine's templates are found only when the application has none of
 * its own by that name, and that is what makes overriding an engine's view a
 * matter of adding a file rather than editing one.
 */
export class TemplateResolver {
  readonly templates: RegisteredTemplate[] = [];

  #cache = new Map<string, RegisteredTemplate | null>();

  constructor(readonly name = "application") {}

  add(template: RegisteredTemplate): void {
    this.templates.push(template);
    this.clearCache();
  }

  /** Rails' `all_template_paths`. */
  allTemplatePaths(): string[] {
    return this.templates.map((each) => templatePath(each));
  }

  findAll(
    name: string,
    prefix: string | undefined,
    requested: RequestedDetails,
  ): RegisteredTemplate[] {
    const matching = this.templates.filter(
      (each) => each.name === name && (prefix === undefined || each.prefix === prefix),
    );

    return sortByPreference(matching, requested);
  }

  clearCache(): void {
    this.#cache.clear();
  }

  /** Reads through the resolver's own cache. */
  cached(key: string, find: () => RegisteredTemplate | undefined): RegisteredTemplate | undefined {
    if (this.#cache.has(key)) return this.#cache.get(key) ?? undefined;

    const found = find();
    // A miss is cached too. Without it, a `render` of something that does not
    // exist — which is the normal way an optional sidebar partial is written —
    // walks every registered path on every request.
    this.#cache.set(key, found ?? null);

    return found;
  }
}

/** The paths a boot installs, and the ones a block is rendering from. */
const resolvers: TemplateResolver[] = [];
const scoped = new AsyncLocalStorage<readonly TemplateResolver[]>();

/** Rails' `PathRegistry.all_resolvers`. */
export function allResolvers(): TemplateResolver[] {
  return [...resolvers];
}

export function appendViewPath(resolver: TemplateResolver): void {
  resolvers.push(resolver);
}

/** Rails' `prepend_view_path` — searched first, which is how an override wins. */
export function prependViewPath(resolver: TemplateResolver): void {
  resolvers.unshift(resolver);
}

export function setViewPaths(paths: readonly TemplateResolver[]): void {
  resolvers.length = 0;
  resolvers.push(...paths);
}

export function getViewPaths(): TemplateResolver[] {
  return [...(scoped.getStore() ?? resolvers)];
}

/** Rails' `with_view_paths` — a scoped swap that always puts them back. */
export async function withViewPaths<T>(
  paths: readonly TemplateResolver[],
  body: () => T | Promise<T>,
): Promise<T> {
  // Scoped rather than swapped. Swapping made one request's paths every
  // concurrent request's paths for as long as the block ran, so a render
  // inside a plugin's view paths could hand a concurrent request the plugin's
  // template instead of the application's — and there is nothing left to put
  // back when a body throws.
  return await scoped.run(paths, async () => await body());
}

export function clearResolverCaches(): void {
  for (const resolver of resolvers) resolver.clearCache();
}

// --- ordering --------------------------------------------------------------

function preferenceIndex(
  value: string | undefined,
  requested: readonly string[] | undefined,
): number {
  // A template that declares nothing fits any request, but only after one that
  // declares the right thing — an `html` component beats a format-agnostic one
  // for an HTML request, and the agnostic one is still there for `json`.
  if (value === undefined) return (requested?.length ?? 0) + 1;

  const index = requested?.indexOf(value) ?? -1;

  return index === -1 ? Number.POSITIVE_INFINITY : index;
}

function scoreOf(template: RegisteredTemplate, requested: RequestedDetails): number[] {
  return [
    preferenceIndex(template.format, requested.formats),
    preferenceIndex(template.variant, requested.variants),
    preferenceIndex(template.locale, requested.locales),
  ];
}

/**
 * Puts the templates a request can use in the order it wants them.
 *
 * Format first, then variant, then locale — the order the client's own
 * preferences arrive in. Anything that names a detail the request did not ask
 * for is dropped rather than ranked last: a `json` component must never be
 * returned for an HTML request just because nothing better existed.
 */
export function sortByPreference(
  templates: readonly RegisteredTemplate[],
  requested: RequestedDetails,
): RegisteredTemplate[] {
  return templates
    .map((template) => ({ template, score: scoreOf(template, requested) }))
    .filter(({ score }) => score.every((part) => Number.isFinite(part)))
    .sort((left, right) => {
      for (let index = 0; index < left.score.length; index += 1) {
        const difference = (left.score[index] as number) - (right.score[index] as number);

        if (difference !== 0) return difference;
      }

      return 0;
    })
    .map(({ template }) => template);
}

// --- the cache key ---------------------------------------------------------

/**
 * The key a lookup result is cached under. Rails' `details_cache_key`.
 *
 * Every detail that could change the answer goes in. One missing `variant` is
 * how a phone user is served the desktop component a previous request warmed
 * the cache with — invisible in any test that makes one request, and reported
 * as "the site looks wrong on my phone sometimes".
 */
export function detailsCacheKey(
  name: string,
  prefix: string | undefined,
  requested: RequestedDetails,
): string {
  return [
    prefix ?? "",
    name,
    (requested.formats ?? []).join(","),
    (requested.variants ?? []).join(","),
    (requested.locales ?? []).join(","),
  ].join("");
}

/** Rails' `details_key` — the same thing as an object, for a nested cache. */
export function detailsKey(requested: RequestedDetails): RequestedDetails {
  return {
    formats: [...(requested.formats ?? [])],
    variants: [...(requested.variants ?? [])],
    locales: [...(requested.locales ?? [])],
  };
}

export function detailsKeys(requested: RequestedDetails): string[] {
  return [
    `formats=${(requested.formats ?? []).join(",")}`,
    `variants=${(requested.variants ?? []).join(",")}`,
    `locales=${(requested.locales ?? []).join(",")}`,
  ];
}

/**
 * Fills in what a request did not say. Rails' `normalized_formats`.
 *
 * An empty list means "no preference", which is not the same as "nothing is
 * acceptable" — treating it as the latter makes every request with no Accept
 * header a 406.
 */
export function normalizedFormats(formats: readonly string[] | undefined): readonly string[] {
  if (formats && formats.length > 0) return formats;

  return registeredDetailDefaults["format"]?.() ?? ["html"];
}

/** Rails' `any_formats?`. */
export function anyFormats(formats: readonly string[] | undefined): boolean {
  return (formats?.length ?? 0) > 0;
}

export class InvalidFormat extends Error {
  constructor(format: string, known: readonly string[]) {
    super(
      `"${format}" is not a format anything renders. Known: ${known.join(", ") || "none"}. ` +
        `A format nothing handles must fail here rather than fall through to HTML, or an ` +
        `API client asking for JSON is quietly handed a web page.`,
    );
    this.name = "InvalidFormat";
  }
}

/**
 * Rails' `validate_formats`.
 *
 * Refuses rather than falling back. A client that asked for a format nothing
 * renders is better told so than handed HTML it will try to parse as JSON.
 */
export function validateFormats(
  formats: readonly string[],
  known: readonly string[],
): readonly string[] {
  for (const format of formats) {
    if (!known.includes(format)) throw new InvalidFormat(format, known);
  }

  return formats;
}

// --- looking up ------------------------------------------------------------

/** A path as a template is known by. Rails' `virtual_path`. */
export function templatePath(template: TemplateDetails & { name: string }): string {
  return template.prefix ? `${template.prefix}/${template.name}` : template.name;
}

/** Rails' `short_identifier`. */
export function shortIdentifier(template: RegisteredTemplate): string {
  return template.identifier ?? templatePath(template);
}

/** Splits `posts/post` into its prefix and name. */
export function splitTemplatePath(path: string): { prefix?: string; name: string } {
  const cut = path.lastIndexOf("/");

  if (cut === -1) return { name: path };

  return { prefix: path.slice(0, cut), name: path.slice(cut + 1) };
}

export class MissingTemplate extends Error {
  constructor(path: string, requested: RequestedDetails, tried: readonly string[]) {
    super(
      `No template for ${JSON.stringify(path)} matching formats ` +
        `[${(requested.formats ?? []).join(", ")}], variants ` +
        `[${(requested.variants ?? []).join(", ")}]. Registered under that name: ` +
        `${tried.join(", ") || "none"}.`,
    );
    this.name = "MissingTemplate";
  }
}

/**
 * Where a lookup happens, holding the details for one request. Rails'
 * `LookupContext`.
 *
 * One per request rather than a set of arguments threaded through every render
 * call, because a partial rendered five levels down has to see the same variant
 * as the action did — and passing it by hand is a thing that gets forgotten
 * exactly once, in the one branch nobody renders in development.
 */
export class LookupContext {
  formats: readonly string[];
  variants: readonly string[];
  locales: readonly string[];
  prefixes: readonly string[];

  constructor(requested: RequestedDetails = {}) {
    this.formats = normalizedFormats(requested.formats);
    this.variants = requested.variants ?? [];
    this.locales = requested.locales ?? [];
    this.prefixes = requested.prefixes ?? [];
  }

  get details(): RequestedDetails {
    return {
      formats: this.formats,
      variants: this.variants,
      locales: this.locales,
      prefixes: this.prefixes,
    };
  }

  /** Rails' `details_key`. */
  detailsKey(): RequestedDetails {
    return detailsKey(this.details);
  }

  /** Rails' `find_all`. */
  findTemplates(path: string): RegisteredTemplate[] {
    const { prefix, name } = splitTemplatePath(path);
    const prefixes = prefix === undefined ? [...this.prefixes, undefined] : [prefix];
    const found: RegisteredTemplate[] = [];

    for (const resolver of resolvers) {
      for (const each of prefixes) {
        found.push(...resolver.findAll(name, each, this.details));
      }
    }

    return found;
  }

  /** Rails' `template_exists?`. */
  templateExists(path: string): boolean {
    return this.findTemplates(path).length > 0;
  }

  /** Rails' `any_templates?`. */
  anyTemplates(paths: readonly string[]): boolean {
    return paths.some((path) => this.templateExists(path));
  }

  /**
   * The one to render. Rails' `find_template`.
   *
   * Cached against a key built from every detail — see `detailsCacheKey`.
   */
  findTemplate(path: string): RegisteredTemplate {
    const { prefix, name } = splitTemplatePath(path);
    const key = detailsCacheKey(name, prefix, this.details);
    const first = resolvers[0];

    const found = first
      ? first.cached(key, () => this.findTemplates(path)[0])
      : this.findTemplates(path)[0];

    if (!found) {
      throw new MissingTemplate(
        path,
        this.details,
        resolvers.flatMap((resolver) =>
          resolver.templates.filter((each) => each.name === name).map(shortIdentifier),
        ),
      );
    }

    return found;
  }

  /** A copy with some details replaced. Rails' `with_prepended_formats`/`_set_detail`. */
  with(overrides: RequestedDetails): LookupContext {
    return new LookupContext({ ...this.details, ...overrides });
  }
}
