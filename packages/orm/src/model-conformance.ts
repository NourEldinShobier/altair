/**
 * Whether an object is usable as a model, ported from `ActiveModel::Lint::Tests`,
 * plus the serialization and validation-callback pieces those tests exercise.
 *
 * `ActiveModel::Lint` is an unusual thing for a framework to ship: a test suite
 * you run against *your* class to find out whether the framework's other parts
 * will accept it. It exists because Rails' view and routing layers duck-type
 * aggressively — `form_for`, `url_for`, `render` and `dom_id` all call methods
 * on whatever they are given — and a class missing one of them fails deep
 * inside a helper, with a message about `nil` rather than about the class.
 *
 * The checks are cheap and the failures they replace are not:
 *
 * - `toKey` returning `[]` instead of `undefined` for a new record makes
 *   `form_for` build an edit form that submits to nothing.
 * - `toParam` returning something with a slash in it produces a URL that routes
 *   somewhere else entirely, and the router reports a missing route for a path
 *   the application built itself.
 * - `toPartialPath` returning an absolute path makes `render @post` look
 *   outside the view root, which fails as a missing template.
 *
 * Each check returns a problem rather than raising, so one run reports
 * everything wrong with a class rather than the first thing.
 *
 * The validation *callbacks* these tests exercise are not here: `model.ts`
 * already defines them through `callbackDecorators("validation")`, which is
 * `define_model_callbacks` under another name. What is here is the two pieces
 * a validator itself needs.
 */

export interface Problem {
  check: string;
  detail: string;
}

export interface LintableModel {
  toKey?: () => unknown[] | undefined;
  toParam?: () => string | undefined;
  toPartialPath?: () => string;
  persisted?: () => boolean;
  errors?: { get(attribute: string): unknown[] };
  modelName?: { name: string; singular: string; plural: string; param: string; route: string };
}

/**
 * Rails' `test_to_key`.
 *
 * `undefined` for a new record and an array for a persisted one. An empty
 * array is the trap: it is truthy in Ruby and in JavaScript, so `form_for`
 * treats the record as persisted and builds an update form whose action has no
 * id in it.
 */
export function testToKey(model: LintableModel): Problem[] {
  if (typeof model.toKey !== "function") {
    return [{ check: "toKey", detail: "the model has no toKey" }];
  }

  const key = model.toKey();
  const persisted = model.persisted?.() ?? false;

  if (!persisted && key !== undefined) {
    return [
      {
        check: "toKey",
        detail:
          "toKey returned a value for a record that is not persisted. An empty array is truthy, " +
          "so a form builder treats the record as persisted and builds an update form whose " +
          "action has no id in it.",
      },
    ];
  }

  if (persisted && (key === undefined || key.length === 0)) {
    return [{ check: "toKey", detail: "toKey returned nothing for a record that is persisted" }];
  }

  return [];
}

/**
 * Rails' `test_to_param`.
 *
 * A string with no slash, or nothing at all. A slash produces a URL that
 * routes somewhere else, and the router then reports a missing route for a
 * path the application built itself — which sends the reader to the routes
 * file rather than to the model.
 */
export function testToParam(model: LintableModel): Problem[] {
  if (typeof model.toParam !== "function") {
    return [{ check: "toParam", detail: "the model has no toParam" }];
  }

  const param = model.toParam();

  if (param === undefined) {
    return (model.persisted?.() ?? false)
      ? [{ check: "toParam", detail: "toParam returned nothing for a persisted record" }]
      : [];
  }

  if (param.includes("/")) {
    return [
      {
        check: "toParam",
        detail:
          `toParam returned ${JSON.stringify(param)}, which contains a slash. That produces a ` +
          `URL routing somewhere else, and the router reports a missing route for a path the ` +
          `application built itself.`,
      },
    ];
  }

  return [];
}

/**
 * Rails' `test_to_partial_path`.
 *
 * A relative path. An absolute one makes `render @post` look outside the view
 * root and fail as a missing template, which reads as a template somebody
 * forgot to write rather than a path somebody built wrongly.
 */
export function testToPartialPath(model: LintableModel): Problem[] {
  if (typeof model.toPartialPath !== "function") {
    return [{ check: "toPartialPath", detail: "the model has no toPartialPath" }];
  }

  const path = model.toPartialPath();

  if (typeof path !== "string") {
    return [{ check: "toPartialPath", detail: "toPartialPath did not return a string" }];
  }

  if (path.startsWith("/")) {
    return [
      {
        check: "toPartialPath",
        detail:
          `toPartialPath returned the absolute path ${JSON.stringify(path)}. Rendering looks ` +
          `inside the view root, so an absolute path fails as a missing template — which reads ` +
          `as one somebody forgot to write.`,
      },
    ];
  }

  return [];
}

/**
 * Rails' `test_persisted?`.
 *
 * Must answer `true` or `false`, not something truthy. Every branch in the
 * form and routing layers turns on it, and a truthy non-boolean passes those
 * branches while failing an `=== true` somewhere further in.
 */
export function testPersisted(model: LintableModel): Problem[] {
  if (typeof model.persisted !== "function") {
    return [{ check: "persisted", detail: "the model has no persisted" }];
  }

  const answer = model.persisted();

  return typeof answer === "boolean"
    ? []
    : [
        {
          check: "persisted",
          detail:
            `persisted returned ${JSON.stringify(answer)} rather than a boolean. Something ` +
            `truthy passes the branches that ask loosely and fails the ones that ask strictly, ` +
            `so the record is persisted in half the framework and new in the other half.`,
        },
      ];
}

/**
 * Rails' `test_model_naming`.
 *
 * The five names the framework derives from a class, all present. Each is used
 * by a different layer — routing, forms, i18n, partial lookup — so a missing
 * one fails in whichever of them the application reaches first, which is not
 * where the problem is.
 */
export function testModelNaming(model: LintableModel): Problem[] {
  const naming = model.modelName;

  if (naming === undefined) {
    return [{ check: "modelName", detail: "the model has no modelName" }];
  }

  const missing = (["name", "singular", "plural", "param", "route"] as const).filter(
    (key) => typeof naming[key] !== "string" || naming[key] === "",
  );

  return missing.length === 0
    ? []
    : [
        {
          check: "modelName",
          detail:
            `modelName is missing ${missing.join(", ")}. Each is used by a different layer — ` +
            `routing, forms, i18n, partial lookup — so a missing one fails wherever the ` +
            `application reaches first, which is not where the problem is.`,
        },
      ];
}

/**
 * Rails' `test_errors_aref`.
 *
 * `errors[:attribute]` must answer an array for an attribute with no errors,
 * not nothing. Every view that renders errors iterates it, and `undefined`
 * there raises inside a template — reported against the template rather than
 * against the model that produced it.
 */
export function testErrorsAref(model: LintableModel): Problem[] {
  if (model.errors === undefined || typeof model.errors.get !== "function") {
    return [{ check: "errors", detail: "the model has no errors collection" }];
  }

  const found = model.errors.get("this_attribute_does_not_exist");

  return Array.isArray(found)
    ? []
    : [
        {
          check: "errors",
          detail:
            "errors[:attribute] returned something that is not an array for an attribute with " +
            "no errors. Every view that renders errors iterates it, so this raises inside a " +
            "template and is reported against the template rather than the model.",
        },
      ];
}

/**
 * Runs every check. Rails' `ActiveModel::Lint::Tests` as one call.
 *
 * Collects rather than stopping, so one run says everything wrong with a class
 * — the alternative is a fix-and-rerun loop as long as the list of problems.
 */
export function lintModel(model: LintableModel): Problem[] {
  return [
    ...testModelNaming(model),
    ...testPersisted(model),
    ...testToKey(model),
    ...testToParam(model),
    ...testToPartialPath(model),
    ...testErrorsAref(model),
  ];
}

// --- serialization ------------------------------------------------------------------

/**
 * Rails' `from_json` — attributes read out of a JSON document.
 *
 * A root key is unwrapped when the document has exactly one and it matches the
 * model. Unwrapping unconditionally would turn `{"title": "a"}` into whatever
 * `"a"` is, and a document with two keys is not wrapped at all.
 */
export function fromJson(
  document: string,
  { root }: { root?: string } = {},
): Record<string, unknown> {
  const parsed = JSON.parse(document) as Record<string, unknown>;

  if (root === undefined) return parsed;

  const keys = Object.keys(parsed);

  if (keys.length === 1 && keys[0] === root) {
    return parsed[root] as Record<string, unknown>;
  }

  return parsed;
}

/**
 * Rails' `as_json` / `to_hash` — the attributes, filtered.
 *
 * `only` wins over `except` when both are given, rather than intersecting.
 * Intersecting silently produces fewer attributes than either asked for, and
 * the caller sees a document missing a field with nothing to explain it.
 */
export function toHash(
  attributes: Record<string, unknown>,
  { only, except }: { only?: readonly string[]; except?: readonly string[] } = {},
): Record<string, unknown> {
  if (only !== undefined) {
    return Object.fromEntries(Object.entries(attributes).filter(([name]) => only.includes(name)));
  }

  if (except !== undefined) {
    return Object.fromEntries(
      Object.entries(attributes).filter(([name]) => !except.includes(name)),
    );
  }

  return { ...attributes };
}

/** Rails' `include_root_in_json?`. */
export function hasJson(value: unknown): boolean {
  return typeof value === "object" && value !== null && "toJSON" in value;
}

/**
 * Rails' check for a `to_json` that delegates rather than serializing.
 *
 * Worth telling apart: a delegating `toJSON` returns a structure that will be
 * serialized again, and calling `JSON.stringify` on its *result* double-encodes
 * — the document arrives as a string containing JSON rather than as JSON.
 */
export function hasDelegatedJson(value: { toJSON?: () => unknown }): boolean {
  if (typeof value.toJSON !== "function") return false;

  return typeof value.toJSON() !== "string";
}

// --- reading an attribute -------------------------------------------------------------

const reads = new WeakMap<object, Set<string>>();

/**
 * Rails' `attribute_was_read` bookkeeping.
 *
 * What it is for: deciding whether a lazily-loaded attribute is worth loading
 * again, and warning about a `select` that omitted a column something then
 * read. Both need to know that a read *happened*, which the value alone cannot
 * say — a null attribute and one nobody touched look identical.
 */
export function accessed(record: object, attribute: string): void {
  const seen = reads.get(record);

  if (seen === undefined) reads.set(record, new Set([attribute]));
  else seen.add(attribute);
}

/** Rails' `has_been_read?`. */
export function hasBeenRead(record: object, attribute: string): boolean {
  return reads.get(record)?.has(attribute) ?? false;
}

export function forgetReads(record: object): void {
  reads.delete(record);
}

/**
 * Rails' `initialize_copy` — what a duplicate does not inherit.
 *
 * A copy gets the attributes and none of the identity: no id, not persisted,
 * no errors, no record of what was read. Carrying the id across is the bug
 * this exists to prevent — `post.dup.save` would update the original rather
 * than creating a second record.
 */
export function initializeCopy<T extends Record<string, unknown>>(
  record: T,
  { primaryKey = "id" }: { primaryKey?: string } = {},
): T {
  const { [primaryKey]: _dropped, ...rest } = record;

  return { ...rest, persisted: false } as unknown as T;
}

/**
 * Rails' `lookup_ancestors` — the classes an i18n or a partial lookup walks.
 *
 * Most specific first, so a subclass's translation wins over its parent's. The
 * other order would make every subclass silently inherit the base class's
 * message, which reads as a translation that was never added.
 */
export function lookupAncestors(chain: readonly string[]): string[] {
  return [...chain];
}

/**
 * Rails' `uniq` for an attribute list, preserving order.
 *
 * Order matters because these lists become column lists and error orders, and
 * a set would make the output depend on insertion order in a way that is hard
 * to see and easy to break.
 */
export function uniq<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

// --- validator helpers -----------------------------------------------------------------

/**
 * Rails' `error_options` — what an error message is interpolated with.
 *
 * The caller's options win over the defaults, so a validator can override
 * `message` without losing `count` and `value`, which the message usually
 * needs.
 */
export function errorOptions(
  attribute: string,
  value: unknown,
  options: Record<string, unknown> = {},
): Record<string, unknown> {
  return { attribute, value, ...options };
}

/**
 * Rails' `each_value` — a validator applied to one value or to each of many.
 *
 * A list is validated element by element, so `validates :tags, length: ...`
 * checks each tag rather than the list. Applying the validator to the array
 * would compare its length against a rule written about a tag.
 */
export function eachValue<T>(value: T | readonly T[], check: (value: T) => void): number {
  const values = Array.isArray(value) ? (value as readonly T[]) : [value as T];

  for (const each of values) check(each);

  return values.length;
}
