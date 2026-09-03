/**
 * Rendering a template found by lookup, ported from
 * `ActionView::Renderer`, `PartialRenderer` and `Template::Handlers`.
 *
 * `lookup_context.ts` answers "which component"; `collection.tsx` renders a
 * component you already have. What sits between them is the thing Rails calls
 * `render`: given a *record*, work out the partial it belongs to, find it, and
 * hand it its locals.
 *
 * Deriving the partial name from the record is what makes a heterogeneous
 * collection render at all — a list of Posts and Photos renders each with its
 * own partial without the caller branching. It is also the part that has to be
 * careful: the name comes from the object, so an attacker-controlled type
 * would be an attacker-controlled template name. That is why derivation goes
 * through the model's declared partial path rather than anything stringly
 * derived from user input, and why a missing partial is an error rather than a
 * blank.
 *
 * Strict locals are the other half. A partial that reads whatever it likes off
 * an implicit context breaks silently when a caller stops passing something —
 * the value is `undefined`, the markup renders, and a field is just missing
 * from the page. Declaring what a partial takes turns that into an error at
 * the call site.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { LookupContext, type RegisteredTemplate, splitTemplatePath } from "./lookup_context.js";
import { type Node, RawHtml, renderToString } from "./render.js";

/** Anything that can say which partial renders it. Rails' `to_partial_path`. */
export interface Partialable {
  toPartialPath?(): string;
  constructor?: { name?: string };
}

/**
 * The partial a record belongs to. Rails' `partial_path`.
 *
 * The record's own declaration first. Falling back to the constructor name is
 * a convenience for plain objects, and it is deliberately the *class* name
 * rather than anything from the data: a `type` field naming its own template
 * would let a row choose which component renders it.
 */
export function derivePartialPath(record: unknown): string {
  if (record === null || record === undefined) {
    throw new TypeError("Cannot work out a partial for null.");
  }

  const partialable = record as Partialable;

  // Called as a method rather than read and re-bound, so `this` is whatever
  // it should be without anybody having to say so.
  if (typeof partialable.toPartialPath === "function") return partialable.toPartialPath();

  const name = (record as Partialable).constructor?.name;

  if (!name || name === "Object") {
    throw new TypeError(
      `Cannot work out which partial renders ${JSON.stringify(String(record))}. Give it a ` +
        `toPartialPath(), or pass the partial name explicitly — guessing from the data would ` +
        `let a record choose its own template.`,
    );
  }

  const plural = `${snake(name)}s`;

  return `${plural}/${snake(name)}`;
}

function snake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

/** Rails' `convert_to_model` — unwraps something that presents a model. */
export function convertToModel(value: unknown): unknown {
  const wrapper = value as { toModel?: () => unknown };

  return typeof wrapper?.toModel === "function" ? wrapper.toModel() : value;
}

/** Rails' `model_name_from_record_or_class`. */
export function modelNameFromRecordOrClass(value: unknown): string {
  const model = convertToModel(value) as { constructor?: { name?: string }; name?: string };

  if (typeof model === "function") return String((model as { name?: string }).name ?? "");

  return String(model?.constructor?.name ?? "");
}

// --- locals ----------------------------------------------------------------

export class MissingLocal extends Error {
  constructor(partial: string, missing: readonly string[], declared: readonly string[]) {
    super(
      `The partial ${JSON.stringify(partial)} needs ${missing.join(", ")} and was not given ` +
        `${missing.length === 1 ? "it" : "them"}. It declares: ${declared.join(", ")}. ` +
        `Rendering without them would leave the field silently missing from the page.`,
    );
    this.name = "MissingLocal";
  }
}

export class UnexpectedLocal extends Error {
  constructor(partial: string, extra: readonly string[], declared: readonly string[]) {
    super(
      `The partial ${JSON.stringify(partial)} was given ${extra.join(", ")}, which it does not ` +
        `declare. It takes: ${declared.join(", ")}. A local nobody reads is usually a rename ` +
        `that was only half applied.`,
    );
    this.name = "UnexpectedLocal";
  }
}

/** What a partial says it takes. Rails' `strict_locals!`. */
export interface StrictLocals {
  required: readonly string[];
  optional?: readonly string[];
}

const strict = new Map<string, StrictLocals>();

export function strictLocals(partial: string, declared: StrictLocals): void {
  strict.set(partial, declared);
}

export function declaredLocals(partial: string): StrictLocals | undefined {
  return strict.get(partial);
}

export function clearStrictLocals(): void {
  strict.clear();
}

/**
 * Checks and completes the locals a partial is given. Rails' `bind_locals`.
 *
 * Both directions are errors. A missing local renders as nothing and the page
 * is quietly wrong; an unexpected one is almost always a rename applied to the
 * caller and not the partial, which is the same bug one step earlier.
 */
export function bindLocals(
  partial: string,
  given: Record<string, unknown>,
): Record<string, unknown> {
  const declared = strict.get(partial);

  if (!declared) return given;

  const allowed = [...declared.required, ...(declared.optional ?? [])];
  const missing = declared.required.filter((name) => !(name in given));

  if (missing.length > 0) throw new MissingLocal(partial, missing, allowed);

  const extra = Object.keys(given).filter((name) => !allowed.includes(name));

  if (extra.length > 0) throw new UnexpectedLocal(partial, extra, allowed);

  return given;
}

/**
 * The locals one item of a collection gets. Rails' `locals_for`.
 *
 * The item under its own name — `post` for `posts/post` — plus the counter and
 * iteration, because a partial that needed the index otherwise has to be
 * rendered by hand.
 */
export function localsFor(
  partial: string,
  item: unknown,
  index: number,
  size: number,
  as?: string,
): Record<string, unknown> {
  const name = as ?? splitTemplatePath(partial).name;

  return {
    [name]: item,
    [`${name}Counter`]: index,
    [`${name}Iteration`]: { index, size, first: index === 0, last: index === size - 1 },
  };
}

// --- template handlers -----------------------------------------------------

/** Turns a source file into something renderable. Rails' `Template::Handler`. */
export type TemplateHandler = (source: string, locals: Record<string, unknown>) => Node;

const handlers = new Map<string, TemplateHandler>();
let defaultHandler: string | undefined;

export function registerTemplateHandler(extension: string, handler: TemplateHandler): void {
  handlers.set(normalizeExtension(extension), handler);
}

export function unregisterTemplateHandler(extension: string): void {
  const key = normalizeExtension(extension);
  handlers.delete(key);

  // Unregistering the default handler drops the default too. The lookup would
  // already miss, so this matters on the way back: re-registering that
  // extension later must not silently make it the default again, which would
  // make an unrelated registration change how every extensionless template
  // renders.
  if (defaultHandler === key) defaultHandler = undefined;
}

export function registerDefault(extension: string): void {
  defaultHandler = normalizeExtension(extension);
}

export function handlerExtensions(): string[] {
  return [...handlers.keys()].sort();
}

function normalizeExtension(extension: string): string {
  return extension.replace(/^\./, "").toLowerCase();
}

/** Rails' `handler_for_extension`. */
export function handlerForExtension(extension: string | undefined): TemplateHandler | undefined {
  const key = extension === undefined ? defaultHandler : normalizeExtension(extension);

  return key === undefined ? undefined : handlers.get(key);
}

export function clearTemplateHandlers(): void {
  handlers.clear();
  defaultHandler = undefined;
}

// --- rendering -------------------------------------------------------------

/** What a render did, for tests and for logging. Rails' `rendered_views`. */
interface RenderRecord {
  path: string;
  locals: Record<string, unknown>;
}

/**
 * What the current block has rendered, if anything is watching.
 *
 * Per-block rather than per-process. Shared, it collected every concurrent
 * render into one list and handed them back as what *this* block rendered —
 * and the flag beside it leaked the same way, so a request that opened one of
 * these turned recording on for everything running beside it.
 */
const renders = new AsyncLocalStorage<RenderRecord[]>();

/** Rails' `in_rendering_context` — collects what was rendered inside a block. */
export async function inRenderingContext<T>(body: () => Promise<T>): Promise<{
  result: T;
  rendered: RenderRecord[];
}> {
  const recorded: RenderRecord[] = [];

  // Nothing to restore: the scope ends when the body does, whether it returns
  // or throws, so recording cannot be left on for the rest of the process.
  const result = await renders.run(recorded, async () => await body());

  return { result, rendered: [...recorded] };
}

/**
 * Rails' `rendered_views` — what the enclosing `inRenderingContext` has seen.
 *
 * Empty outside one, which is the honest answer now that the list belongs to a
 * block. It used to report whatever the process had rendered since the last
 * time somebody cleared it, which in a server is every request's templates
 * mixed together.
 */
export function renderedViews(): string[] {
  return (renders.getStore() ?? []).map((each) => each.path);
}

/** Rails' `render_calls`. */
export function renderCalls(): RenderRecord[] {
  return [...(renders.getStore() ?? [])];
}

function record(path: string, locals: Record<string, unknown>): void {
  renders.getStore()?.push({ path, locals });
}

/** Rails' `render_template` — one template, with its locals bound. */
export async function renderTemplate(
  context: LookupContext,
  path: string,
  locals: Record<string, unknown> = {},
): Promise<RawHtml> {
  const template = context.findTemplate(path);
  const bound = bindLocals(path, locals);
  record(path, bound);

  return renderNode(await template.component(bound));
}

/** Rails' `render_object_with_partial`. */
export async function renderObjectWithPartial(
  context: LookupContext,
  partial: string,
  object: unknown,
  locals: Record<string, unknown> = {},
  as?: string,
): Promise<RawHtml> {
  const name = as ?? splitTemplatePath(partial).name;

  return renderTemplate(context, partial, { ...locals, [name]: convertToModel(object) });
}

/** Rails' `render_object_derive_partial` — the partial comes from the object. */
export async function renderObjectDerivePartial(
  context: LookupContext,
  object: unknown,
  locals: Record<string, unknown> = {},
): Promise<RawHtml> {
  return renderObjectWithPartial(
    context,
    derivePartialPath(convertToModel(object)),
    object,
    locals,
  );
}

/**
 * Rails' `render_collection_with_partial`.
 *
 * The lookup happens per item rather than once up front, so an empty
 * collection never looks the partial up at all. That matters: `render(@posts)`
 * with no posts must not raise because the partial happens not to exist, and an
 * empty list is the normal state of a new account.
 */
export async function renderCollectionWithPartial(
  context: LookupContext,
  partial: string,
  collection: readonly unknown[],
  locals: Record<string, unknown> = {},
  as?: string,
): Promise<RawHtml> {
  const parts: string[] = [];

  for (const [index, item] of collection.entries()) {
    const bound = {
      ...locals,
      ...localsFor(partial, convertToModel(item), index, collection.length, as),
    };
    parts.push((await renderTemplate(context, partial, bound)).value);
  }

  return new RawHtml(parts.join(""));
}

/**
 * Rails' `render_collection_derive_partial`.
 *
 * Each item's own partial, which is what makes a mixed collection render
 * without the caller branching on type.
 */
export async function renderCollectionDerivePartial(
  context: LookupContext,
  collection: readonly unknown[],
  locals: Record<string, unknown> = {},
): Promise<RawHtml> {
  const parts: string[] = [];

  for (const [index, raw] of collection.entries()) {
    const item = convertToModel(raw);
    const partial = derivePartialPath(item);
    const bound = { ...locals, ...localsFor(partial, item, index, collection.length) };
    parts.push((await renderTemplate(context, partial, bound)).value);
  }

  return new RawHtml(parts.join(""));
}

/**
 * Rails' `render_layout` — the layout receives the body it wraps.
 *
 * The body is rendered *first* and handed in. A layout that rendered the body
 * lazily would run it after its own `<head>` was already emitted, and then
 * anything the body wanted to put in the head — a title, a meta tag — would
 * arrive too late.
 */
export async function renderLayout(
  context: LookupContext,
  layout: string,
  body: Node,
  locals: Record<string, unknown> = {},
): Promise<RawHtml> {
  const rendered = await renderNode(body);

  return renderTemplate(context, layout, { ...locals, content: rendered });
}

/** Rails' `render_body` — no layout, just the template. */
export async function renderBody(
  context: LookupContext,
  path: string,
  locals: Record<string, unknown> = {},
): Promise<RawHtml> {
  return renderTemplate(context, path, locals);
}

/** Rails' `render_to_object` — the markup as a string, for a caller that is not a view. */
export async function renderToObject(
  context: LookupContext,
  path: string,
  locals: Record<string, unknown> = {},
): Promise<string> {
  return (await renderTemplate(context, path, locals)).value;
}

/** Rails' `sub_template_of` — the chain a template was rendered from. */
export function subTemplateOf(template: RegisteredTemplate, parent?: string): string {
  const own = template.prefix ? `${template.prefix}/${template.name}` : template.name;

  return parent === undefined ? own : `${parent} > ${own}`;
}

async function renderNode(node: Node): Promise<RawHtml> {
  return node instanceof RawHtml ? node : new RawHtml(await renderToString(node));
}
