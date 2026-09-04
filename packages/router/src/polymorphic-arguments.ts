/**
 * What `url_for` accepts, ported from
 * `ActionDispatch::Routing::PolymorphicRoutes::HelperMethodBuilder`.
 *
 * `polymorphic.ts` answers "where does this record live" for one record, with
 * at most one owner. That covers `redirect_to(post)` and it is not what a real
 * route table asks for: a form under a namespace submits to
 * `[:admin, post]`, a nested comment to `[post, comment]`, a new comment on a
 * post to `[post, Comment]`, and the "new" link for a namespaced resource to
 * `[:admin, Post]`.
 *
 * All four are the same rule, and it is worth stating once because every
 * mistake in this area is a route name that does not exist rather than a wrong
 * page:
 *
 * - **The last item decides the shape.** A saved record makes the name
 *   singular and contributes an id; anything unsaved — a new record, a class —
 *   makes it plural and contributes nothing. That is the whole reason one form
 *   template can both create and update.
 * - **Every earlier item is a parent**, always singular, and contributes its id
 *   unless it is a bare name.
 * - **A bare name is a namespace.** It contributes a word and no argument,
 *   which is what `[:admin, post]` needs: `admin_post_path(post)` takes one
 *   argument, not two.
 *
 * Rails distinguishes a namespace (`:admin`) from a record key by Ruby's
 * Symbol/String split and refuses a String in a list for that reason. Here
 * there is no ambiguity to resolve — a record is an object and a namespace is
 * a string — so a string is a namespace and the refusal has nothing to guard.
 */

import {
  type Addressable,
  helperKey,
  paramForRecord,
  recordPersisted,
  routeKeysFor,
} from "./polymorphic.js";

/** Where a route word comes from: a declared key, or failing that a name. */
export interface RouteKeySource {
  modelName?: { routeKey: string; singularRouteKey: string };
  name?: string;
}

/**
 * A class of records — what `[post, Comment]` ends with.
 *
 * A constructor type rather than a bare shape, because that is what tells a
 * class from an unsaved record, and the two name the same route: the mistake
 * would only appear when an id was expected.
 */
export type AddressableClass = (abstract new (...args: never[]) => unknown) & RouteKeySource;

/** One element of what `url_for` was given. */
export type PolymorphicItem = Addressable | AddressableClass | string;

/** The helper table a name is looked up in — `router.pathHelpers()`. */
export type HelperTable = Record<string, ((...args: unknown[]) => string) | undefined>;

/**
 * How a name is built: `edit_`/`new_` in front, `path`/`url` behind, and
 * whether the last item is named in the singular. Rails' `HelperMethodBuilder`.
 *
 * `new` is the one action that is singular while naming a collection —
 * `new_post_path` creates *a* post — which is why the strategy is carried
 * rather than derived from whether the record was saved.
 */
export interface HelperMethodBuilder {
  prefix: string;
  suffix: "path" | "url";
  singular: boolean;
}

export function helperMethodBuilder(
  action?: string,
  type: "path" | "url" = "url",
): HelperMethodBuilder {
  return {
    prefix: action ? `${action}_` : "",
    suffix: type,
    singular: action === "new",
  };
}

function methodForString(builder: HelperMethodBuilder, name: string): string {
  return helperKey(`${builder.prefix}${name}_${builder.suffix}`);
}

function keyForClass(builder: HelperMethodBuilder, klass: RouteKeySource): string {
  const model = klass.modelName;

  if (model) return builder.singular ? model.singularRouteKey : model.routeKey;

  const derived = (klass.name ?? "").toLowerCase();

  return builder.singular ? derived : `${derived}s`;
}

export interface PolymorphicMethod {
  method: string;
  args: unknown[];
}

/**
 * A name given directly: `url_for("posts")`. Rails' `handle_string`.
 *
 * No arguments, because a name carries no record. It exists so a caller
 * assembling a route word can go through the same builder as everything else
 * rather than formatting `"#{prefix}#{name}_#{suffix}"` itself — which is where
 * a missing `edit_` comes from.
 */
export function handleString(builder: HelperMethodBuilder, name: string): PolymorphicMethod {
  return { method: methodForString(builder, name), args: [] };
}

/** The same, called against a helper table. Rails' `handle_string_call`. */
export function handleStringCall(
  target: HelperTable,
  builder: HelperMethodBuilder,
  name: string,
): string {
  return callHelper(target, handleString(builder, name));
}

/**
 * A class: `url_for(Post)`. Rails' `handle_class`.
 *
 * The collection, because a class is every record of its kind and not one of
 * them. This is what makes `form_with model: Post.new` and a "New post" link
 * take the same shape as everything else.
 */
export function handleClass(
  builder: HelperMethodBuilder,
  klass: AddressableClass,
): PolymorphicMethod {
  return { method: methodForString(builder, keyForClass(builder, klass)), args: [] };
}

/** The same, called against a helper table. Rails' `handle_class_call`. */
export function handleClassCall(
  target: HelperTable,
  builder: HelperMethodBuilder,
  klass: AddressableClass,
): string {
  return callHelper(target, handleClass(builder, klass));
}

/**
 * A record: `url_for(post)`. Rails' `handle_model`.
 *
 * Saved goes to its own path and carries its id; unsaved goes to the
 * collection and carries nothing. Reading that from the record rather than
 * from a flag the caller passes is what stops a form's create and update paths
 * drifting apart.
 */
export function handleModel(builder: HelperMethodBuilder, record: Addressable): PolymorphicMethod {
  if (!recordPersisted(record)) {
    return { method: methodForString(builder, keyForClass(builder, asClass(record))), args: [] };
  }

  return {
    method: methodForString(builder, routeKeysFor(record).singular),
    args: [paramForRecord(record)],
  };
}

/** The same, called against a helper table. Rails' `handle_model_call`. */
export function handleModelCall(
  target: HelperTable,
  builder: HelperMethodBuilder,
  record: Addressable,
): string {
  return callHelper(target, handleModel(builder, record));
}

export class NilLocation extends Error {
  constructor() {
    super("Nil location provided. Can't build URI.");
    this.name = "NilLocation";
  }
}

/**
 * A list: `url_for([:admin, post, comment])`. Rails' `handle_list`.
 *
 * The parents are named in the singular and contribute their ids; the last
 * item decides whether the name is singular or plural. Nothing here looks at
 * the route table, so `[post, Comment]` names `post_comments_path` whether or
 * not that route exists — and a route that does not exist is a missing-helper
 * error naming the route, which is the error worth getting.
 */
export function handleList(
  builder: HelperMethodBuilder,
  list: readonly (PolymorphicItem | null | undefined)[],
): PolymorphicMethod {
  const items = list.filter((item) => item !== null && item !== undefined) as PolymorphicItem[];

  // Empty after dropping the blanks: `url_for([nil])` would otherwise build
  // `_path`, which is a helper nobody has, reported far from the nil.
  if (items.length === 0) throw new NilLocation();

  const last = items[items.length - 1] as PolymorphicItem;
  const parents = items.slice(0, -1);
  const args: unknown[] = [];
  const words: string[] = [];

  for (const parent of parents) {
    if (typeof parent === "string") {
      words.push(parent);
      continue;
    }

    if (isClass(parent)) {
      // A class in the middle names its kind and carries nothing: `[Post,
      // comment]` cannot mean a particular post, so there is no id to add.
      words.push(keyForClass({ ...builder, singular: true }, parent));
      continue;
    }

    words.push(routeKeysFor(parent).singular);
    args.push(paramForRecord(parent));
  }

  if (typeof last === "string") {
    words.push(last);
  } else if (isClass(last)) {
    words.push(keyForClass(builder, last));
  } else if (recordPersisted(last)) {
    words.push(routeKeysFor(last).singular);
    args.push(paramForRecord(last));
  } else {
    words.push(keyForClass(builder, asClass(last)));
  }

  return { method: methodForString(builder, words.join("_")), args };
}

/**
 * Whatever `url_for` was given, as the helper it names. Rails'
 * `polymorphic_method`.
 */
export function polymorphicHelperFor(
  argument: PolymorphicItem | readonly (PolymorphicItem | null | undefined)[] | null | undefined,
  options: { action?: string; type?: "path" | "url" } = {},
): PolymorphicMethod {
  const builder = helperMethodBuilder(options.action, options.type ?? "url");

  if (argument === null || argument === undefined) throw new NilLocation();
  if (Array.isArray(argument)) {
    return handleList(builder, argument as readonly (PolymorphicItem | null | undefined)[]);
  }

  const single = argument as PolymorphicItem;

  if (typeof single === "string") return handleString(builder, single);
  if (isClass(single)) return handleClass(builder, single);

  return handleModel(builder, single);
}

/** Runs it against a helper table, which is where a missing route is reported. */
export function callHelper(
  target: HelperTable,
  { method, args }: PolymorphicMethod,
  options?: Record<string, unknown>,
): string {
  const helper = target[method];

  if (!helper) {
    throw new TypeError(
      `No route helper ${JSON.stringify(method)}. Declare the resource, or pass a path.`,
    );
  }

  return options === undefined ? helper(...args) : helper(...args, options);
}

// `resource-scope.ts` already owns the per-model override registry
// (`polymorphicMappings`), and a second one would let the same model be
// redirected two ways depending on which module a caller reached for.

function asClass(record: Addressable): RouteKeySource {
  const model = record.modelName;

  return model ? { modelName: model } : { name: record.constructor?.name ?? "" };
}

/**
 * Whether this is a class rather than a record.
 *
 * A function, because a class is one. Checking for a missing id instead would
 * make an unsaved record look like a class — which happens to name the same
 * route, so the mistake would be invisible until an id was expected.
 */
function isClass(item: PolymorphicItem): item is AddressableClass {
  return typeof item === "function";
}
