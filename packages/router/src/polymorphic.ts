/**
 * Paths worked out from a record, ported from `ActionDispatch::Routing::
 * PolymorphicRoutes`.
 *
 *     pathTo(post)                  // "/posts/1"
 *     pathTo(post, { action: "edit" })  // "/posts/1/edit"
 *     pathTo(Post)                  // "/posts"
 *
 * This is what makes `redirect_to(post)` and `<Form model={post}>` work, and
 * why a Rails form does not need to be told where to submit. The record knows
 * what it is; the route table knows where that lives; nothing in between has
 * to be written down twice.
 *
 * A new record goes to the collection and a saved one to its own path, which
 * is the whole reason one form template can both create and update. Getting
 * that from `persisted` rather than from a flag passed in is what stops the
 * two drifting apart.
 */

import type { Router } from "./router.js";

/** What a path can be worked out from. Rails' `to_model`. */
export interface Addressable {
  /** Rails' `model_name`, which the ORM's models carry. */
  modelName?: { routeKey: string; singularRouteKey: string };
  /** Whether it has been saved. A new record belongs to the collection. */
  persisted?: boolean;
  isPersisted?: boolean;
  toParam?: () => string;
  id?: unknown;
  constructor?: { name: string };
}

export interface PolymorphicOptions {
  /** `edit` or `new`. Anything else is taken as a member action. */
  action?: string;
  /** Nests the path under an owner: `pathTo(comment, { within: post })`. */
  within?: Addressable;
  /** Appended as a query string. */
  query?: Record<string, unknown>;
}

/** Raised when nothing in the route table matches what the record is. */
export class NoRouteForRecord extends Error {
  constructor(name: string, tried: string[]) {
    super(
      `No route for ${name}. Tried: ${tried.join(", ")}. ` +
        `Add one with \`r.resources("${name}")\`, or pass a path.`,
    );
    this.name = "NoRouteForRecord";
  }
}

function isSaved(record: Addressable): boolean {
  if (typeof record.persisted === "boolean") return record.persisted;
  if (typeof record.isPersisted === "boolean") return record.isPersisted;

  // Falling back to the id: a record with one has been saved, and a class has
  // none, which is also the answer that sends it to the collection.
  return record.id !== undefined && record.id !== null;
}

function keysFor(record: Addressable): { plural: string; singular: string } {
  const name = record.modelName;
  if (name) return { plural: name.routeKey, singular: name.singularRouteKey };

  // A plain object with no model name still has a class, and its name is what
  // Rails would have inflected anyway.
  const klass = (record.constructor?.name ?? "").toLowerCase();
  return { plural: `${klass}s`, singular: klass };
}

function paramOf(record: Addressable): string {
  if (typeof record.toParam === "function") return record.toParam();
  return String(record.id ?? "");
}

/**
 * Works out the route name a record maps to, and the values for its segments.
 *
 * Separated from building the path so a caller can see what was chosen — and
 * because the choice is the interesting part, while formatting is not.
 */
export function routeForRecord(
  record: Addressable,
  options: PolymorphicOptions = {},
): { name: string; values: unknown[] } {
  const { plural, singular } = keysFor(record);
  const saved = isSaved(record);

  const owner = options.within;
  const prefix = owner ? `${keysFor(owner).singular}_` : "";
  const values: unknown[] = owner ? [paramOf(owner)] : [];

  // `new` is a collection action, so it never carries the record's own id even
  // when it was called with one.
  if (options.action === "new") return { name: `new_${prefix}${singular}`, values };

  if (!saved) return { name: `${prefix}${plural}`, values };

  values.push(paramOf(record));

  if (options.action === "edit") return { name: `edit_${prefix}${singular}`, values };
  if (options.action) return { name: `${options.action}_${prefix}${singular}`, values };

  return { name: `${prefix}${singular}`, values };
}

/**
 * The path for a record. Rails' `polymorphic_path`.
 *
 * Tries the name the record maps to, then the plain singular without any
 * nesting — so a nested record still resolves when only the flat route exists,
 * which is the common shape of a half-nested route table.
 */
export function polymorphicPath(
  router: Router,
  record: Addressable,
  options: PolymorphicOptions = {},
): string {
  const chosen = routeForRecord(record, options);
  const helpers = router.pathHelpers();

  const candidates = [chosen.name];

  // Without the owner, for a route table that nests some things and not
  // others.
  if (options.within) {
    const flat = routeForRecord(record, { ...options, within: undefined });
    candidates.push(flat.name);
  }

  for (const name of candidates) {
    const helper = helpers[`${camelizeName(name)}Path`];
    if (!helper) continue;

    const values =
      name === chosen.name
        ? chosen.values
        : routeForRecord(record, { ...options, within: undefined }).values;

    return options.query ? helper(...values, options.query) : helper(...values);
  }

  throw new NoRouteForRecord(keysFor(record).plural, candidates);
}

/** `edit_blog_post` becomes `editBlogPost`, matching the helper table. */
function camelizeName(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());
}
