/**
 * What declaring an association sets up, ported from
 * `ActiveRecord::Associations::Builder`.
 *
 * `associations.ts` implements the associations; this is the declaration step
 * that runs once, at class definition, and decides what a macro brings with it.
 * Three things happen there that are easy to leave out and expensive to leave
 * out:
 *
 * - **Options are checked against a list.** `hasMany("comments", { classNmae:
 *   "Comment" })` is a typo, and an unchecked option is silently ignored: the
 *   association works, against the wrong class, and the mistake surfaces as a
 *   missing column. The list is per macro *and* depends on the options already
 *   given — `source` only means something with `through`, `foreignType` only
 *   with `as` — because an option accepted where it does nothing is the same
 *   silence one step further along.
 * - **`dependent:` is checked per macro.** `belongsTo` cannot `nullify`: that
 *   acts on the many side and the parent has no children to act on. Rails' own
 *   lists differ for all three macros, and accepting one that does nothing
 *   reads as configured and is not.
 * - **A singular association gets constructors.** `buildAuthor` and
 *   `createAuthor` exist because the association knows the foreign key and the
 *   caller does not; without them every caller sets it by hand, and the one
 *   that forgets writes a row with a null key.
 *
 * The methods are described rather than defined here, so a declaration can be
 * checked without a database or a model — and so the list of what a macro adds
 * is one readable thing rather than scattered through the class that adds it.
 */

// The per-macro list and the check over it live with the rest of the
// dependent-destruction rules, so a macro cannot be told two different things
// about what it may do to its children.
import { checkDependentOptions } from "./inheritance.js";

export type AssociationMacro = "belongsTo" | "hasMany" | "hasOne";

/** Options every macro accepts. Rails' `Builder::Association::VALID_OPTIONS`. */
const COMMON_OPTIONS = [
  "primaryKey",
  "foreignKey",
  "dependent",
  "validate",
  "inverseOf",
  "strictLoading",
  "queryConstraints",
  "deprecated",
  "anonymousClass",
] as const;

const SINGULAR_OPTIONS = ["required", "touch"] as const;
const COLLECTION_CALLBACKS = ["beforeAdd", "afterAdd", "beforeRemove", "afterRemove"] as const;

/**
 * Rails' `valid_options` — what this macro accepts, given what it was given.
 *
 * Conditional on the other options rather than a flat list per macro: `source`
 * without `through` names a hop that does not exist, and `foreignType` without
 * `as` names a column nothing writes. Accepting either would let a declaration
 * look configured while doing nothing.
 */
export function validOptions(
  macro: AssociationMacro,
  options: Record<string, unknown> = {},
): Set<string> {
  const valid = new Set<string>(COMMON_OPTIONS);

  if (macro === "belongsTo") {
    for (const name of [
      ...SINGULAR_OPTIONS,
      "polymorphic",
      "counterCache",
      "optional",
      "default",
    ]) {
      valid.add(name);
    }

    // `className` and `foreignType` are mutually exclusive: a polymorphic
    // association's class comes from a column, so naming one as well is a
    // declaration that contradicts itself.
    if (options["polymorphic"]) valid.add("foreignType");
    else valid.add("className");
  }

  if (macro === "hasOne") {
    for (const name of [...SINGULAR_OPTIONS, "className", "as", "through"]) valid.add(name);
  }

  if (macro === "hasMany") {
    for (const name of [
      "className",
      "counterCache",
      "joinTable",
      "indexErrors",
      "defaultOrder",
      "as",
      "through",
      "extend",
      ...COLLECTION_CALLBACKS,
    ]) {
      valid.add(name);
    }
  }

  if (macro !== "belongsTo") {
    if (options["as"]) valid.add("foreignType");
    if (options["through"])
      for (const name of ["source", "sourceType", "disableJoins"]) valid.add(name);
  }

  if (options["dependent"] === "destroy_async") valid.add("ensuringOwnerWas");

  return valid;
}

export class UnknownAssociationOption extends Error {
  constructor(macro: AssociationMacro, given: readonly string[], valid: Iterable<string>) {
    super(
      `Unknown option${given.length === 1 ? "" : "s"} ${given.join(", ")} on a ${macro}. ` +
        `An option that is not checked is silently ignored, so the association works and does ` +
        `the wrong thing. Valid here: ${[...valid].sort().join(", ")}.`,
    );
    this.name = "UnknownAssociationOption";
  }
}

/** Rails' `validate_options` — refuses anything not on the list. */
export function validateAssociationOptions(
  macro: AssociationMacro,
  options: Record<string, unknown>,
): void {
  const valid = validOptions(macro, options);
  const unknown = Object.keys(options).filter((name) => !valid.has(name));

  if (unknown.length > 0) throw new UnknownAssociationOption(macro, unknown, valid);
}

// --- what each macro defines -----------------------------------------------

/** The names one declaration adds to a model, by kind. */
export interface AssociationSetup {
  readers: string[];
  writers: string[];
  constructors: string[];
  validations: string[];
  changeTracking: string[];
  callbacks: string[];
  extensions: string[];
}

/**
 * Rails' `define_extensions` — a collection association's block.
 *
 * Collections only. `post.comments.recent` is a method on the *association*,
 * which a singular association has nowhere to put: `post.author.recent` would
 * be a method on User, and defining it there would put it on every user
 * reached any other way.
 */
export function defineExtensions(
  macro: AssociationMacro,
  name: string,
  hasBlock = false,
): string[] {
  if (macro !== "hasMany" || !hasBlock) return [];

  return [`${name.charAt(0).toUpperCase()}${name.slice(1)}AssociationExtension`];
}

/**
 * Rails' `define_constructors` — `buildAuthor`, `createAuthor`.
 *
 * Singular and non-polymorphic. The association knows the foreign key and the
 * caller does not, so without these every caller sets it by hand and the one
 * that forgets writes a row with a null key. Polymorphic is excluded because
 * there is no class to build: the type is whatever gets assigned.
 */
export function defineConstructors(
  macro: AssociationMacro,
  name: string,
  polymorphic = false,
): string[] {
  if (macro === "hasMany" || polymorphic) return [];

  const capitalised = `${name.charAt(0).toUpperCase()}${name.slice(1)}`;

  return [`build${capitalised}`, `create${capitalised}`];
}

/**
 * Rails' `define_validations`.
 *
 * A `belongsTo` is required unless it says otherwise — the default since Rails
 * 5, because the overwhelmingly common case is a child that must have a
 * parent, and the old default let a missing parent through to a foreign key
 * violation at the database, or to nothing at all where there was no
 * constraint. `hasOne` is the other way round: required only when asked.
 */
export function defineValidations(
  macro: AssociationMacro,
  name: string,
  options: { optional?: boolean; required?: boolean } = {},
  requiredByDefault = true,
): string[] {
  // `required` is the older spelling and the inverse; a declaration that used
  // both would otherwise be resolved by whichever was read second.
  if (options.required !== undefined && options.optional !== undefined) {
    throw new TypeError(`Pass either \`optional\` or \`required\` to ${macro} ${name}, not both.`);
  }

  const optional = options.required === undefined ? options.optional : !options.required;

  if (macro === "belongsTo") return (optional ?? !requiredByDefault) ? [] : [`presence:${name}`];
  if (macro === "hasOne") return options.required === true ? [`presence:${name}`] : [];

  return [];
}

/**
 * Rails' `define_change_tracking_methods` — `authorChanged?`.
 *
 * `belongsTo` only, because the change being tracked is a change to the
 * *foreign key on this record*. A `hasMany` has nothing on this record to
 * change, so a `commentsChanged` would have to load the collection to answer,
 * which is a query behind a method that reads like a field.
 */
export function defineChangeTrackingMethods(macro: AssociationMacro, name: string): string[] {
  if (macro !== "belongsTo") return [];

  const capitalised = `${name.charAt(0).toUpperCase()}${name.slice(1)}`;

  return [`is${capitalised}Changed`, `is${capitalised}PreviouslyChanged`];
}

/**
 * Rails' `define_callback` — one hook per collection callback that was given.
 *
 * Named after the association rather than shared, so two collections on one
 * model can each have their own `beforeAdd` — shared, the second declaration
 * would silently replace the first.
 */
export function defineCallback(
  macro: AssociationMacro,
  name: string,
  options: Record<string, unknown> = {},
): string[] {
  if (macro !== "hasMany") return [];

  return COLLECTION_CALLBACKS.filter((callback) => options[callback] !== undefined).map(
    (callback) => `${callback}For${name.charAt(0).toUpperCase()}${name.slice(1)}`,
  );
}

/**
 * Everything one declaration adds. Rails' `Builder::Association.build`.
 *
 * The options are checked first: a declaration with a typo in it should fail
 * at class definition, where the line is on screen, rather than at the first
 * query that uses it.
 */
export function buildAssociation(
  macro: AssociationMacro,
  name: string,
  options: Record<string, unknown> = {},
): AssociationSetup {
  validateAssociationOptions(macro, options);

  if (options["dependent"] !== undefined) {
    checkDependentOptions(String(options["dependent"]), macro);
  }

  const capitalised = `${name.charAt(0).toUpperCase()}${name.slice(1)}`;

  return {
    readers: [name],
    writers: [`set${capitalised}`],
    constructors: defineConstructors(macro, name, Boolean(options["polymorphic"])),
    validations: defineValidations(
      macro,
      name,
      options as { optional?: boolean; required?: boolean },
    ),
    changeTracking: defineChangeTrackingMethods(macro, name),
    callbacks: defineCallback(macro, name, options),
    extensions: defineExtensions(macro, name, Boolean(options["extend"])),
  };
}

/**
 * Rails' `build_record` — a record built through an association.
 *
 * It starts with the association's own conditions, then the caller's
 * attributes. That is what makes `post.comments.where({ spam: false }).build()`
 * produce a comment that is already not spam, and what puts the owner's
 * foreign key on it — a caller that had to set both would eventually build one
 * that matches nothing the relation it came from would return.
 *
 * The caller's attributes win, so a scope is a default rather than a
 * constraint: `where({ spam: false }).build({ spam: true })` is a deliberate
 * exception and not a silent contradiction.
 */
export function buildRecord(
  scopeAttributes: Record<string, unknown>,
  attributes: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...scopeAttributes, ...attributes };
}
