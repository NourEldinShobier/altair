/**
 * What an association actually points at. Ported from
 * `ActiveRecord::Reflection` — `AssociationReflection` and
 * `ThroughReflection`.
 *
 * `reflectOnAssociation` already hands back the options an association was
 * declared with. That is not the same question as what it resolves to, and the
 * gap is where `through` lives:
 *
 *     Post.hasMany("comments", () => Comment)
 *     Author.hasMany("posts", () => Post)
 *     Author.hasMany("comments", () => Comment, { through: "posts" })
 *
 * The declaration says `through: "posts"`. What a preloader, a join, or a
 * validity check needs to know is the chain — that reaching an author's
 * comments means Author → posts → comments, which association on Post carries
 * the second hop, and which columns join each pair. None of that is in the
 * options; all of it is derivable from them, and deriving it in three places
 * is how three places come to disagree.
 *
 * So it is derived once, here, and cached. A reflection is the answer.
 */

import type { AssociationDefinition, AssociationKind, ModelLike } from "./associations.js";

/** Rails' name for the kind of association, which is what its docs and errors use. */
export type Macro = "has_many" | "has_one" | "belongs_to";

const MACROS: Readonly<Record<AssociationKind, Macro>> = {
  hasMany: "has_many",
  hasOne: "has_one",
  belongsTo: "belongs_to",
};

/** Raised when an association cannot be resolved to something real. */
export class ReflectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReflectionError";
  }
}

/** The model class a reflection is declared on, as much of it as this needs. */
export interface ReflectingModel extends ModelLike {
  reflectOnAssociation(name: string): AssociationDefinition | undefined;
  reflectOnAllAssociations(kind?: AssociationKind): AssociationDefinition[];
}

/**
 * One association, resolved.
 *
 * Built from a definition and the class it was declared on, because half the
 * answers need both: a foreign key defaults from the owner's name, and a
 * source reflection lives on a third class entirely.
 */
export class Reflection {
  readonly definition: AssociationDefinition;
  readonly owner: ReflectingModel;

  constructor(definition: AssociationDefinition, owner: ReflectingModel) {
    this.definition = definition;
    this.owner = owner;
  }

  get name(): string {
    return this.definition.name;
  }

  /** Rails' `macro`: `has_many`, `has_one` or `belongs_to`. */
  macro(): Macro {
    return MACROS[this.definition.kind];
  }

  /** Whether reading it gives many records rather than one. Rails' `collection?`. */
  isCollection(): boolean {
    return this.definition.kind === "hasMany";
  }

  /** Whether the foreign key is on this side. Rails' `belongs_to?`. */
  isBelongsTo(): boolean {
    return this.definition.kind === "belongsTo";
  }

  /** Whether it reaches its target through another association. */
  isThrough(): boolean {
    return this.definition.through !== undefined;
  }

  /**
   * The class at the far end. Rails' `association_class` / `klass`.
   *
   * For a `through` association this is the source's class, not the
   * intermediate's — an author's comments are Comments, not Posts, and a
   * caller that got Post here would build the wrong query and only find out
   * when a column was missing.
   */
  associationClass(): ModelLike {
    if (!this.isThrough()) return this.definition.target();

    return this.sourceReflection().associationClass();
  }

  /**
   * The column the association joins against on the target. Rails'
   * `association_primary_key`.
   *
   * The target's own primary key unless the declaration named another, which
   * is what a model keyed on something other than `id` needs.
   */
  associationPrimaryKey(): string {
    return this.definition.primaryKey ?? this.associationClass().primaryKey;
  }

  /**
   * A polymorphic association's stored type name. Rails' `polymorphic_name`.
   *
   * The owner's class name, because that is what goes in the `*_type` column —
   * and it is the owner's rather than the target's precisely because the
   * target is the thing that varies.
   */
  polymorphicName(): string {
    return this.owner.name;
  }

  /**
   * The association on the far class that points back, for a polymorphic one.
   * Rails' `polymorphic_inverse_of`.
   *
   * Undefined rather than thrown when there is none: plenty of polymorphic
   * associations are one-directional, and a missing inverse is only an error
   * when something asked to use it.
   */
  polymorphicInverseOf(associated: ReflectingModel): Reflection | undefined {
    const name = this.definition.as;

    if (name === undefined) return undefined;

    const found = associated.reflectOnAssociation(name);

    return found ? new Reflection(found, associated) : undefined;
  }

  /**
   * Which class a stored type name means. Rails' `polymorphic_class_for`.
   *
   * Only names the declaration listed. A `*_type` column holds a string that
   * arrived from the database, and turning an arbitrary string into a class to
   * instantiate is how a write to that column becomes code execution — so an
   * unlisted name is refused rather than resolved.
   */
  polymorphicClassFor(typeName: string): ModelLike {
    const known = this.definition.types?.[typeName];

    if (!known) {
      const listed = Object.keys(this.definition.types ?? {});

      throw new ReflectionError(
        `"${typeName}" is not a type ${this.owner.name}.${this.name} can point at. ` +
          `Declared: ${listed.join(", ") || "none"}.`,
      );
    }

    return known();
  }

  /** Whether an inverse was declared or can be guessed. Rails' `has_inverse?`. */
  hasInverse(): boolean {
    return this.definition.inverseOf !== undefined || this.definition.as !== undefined;
  }

  /**
   * Complains if the declared inverse is not there. Rails'
   * `check_validity_of_inverse!`.
   *
   * Worth checking eagerly because the symptom otherwise is not an error: an
   * inverse that does not resolve simply stops being used, so preloading keeps
   * working and quietly goes back to one query per record — the N+1 that
   * naming an inverse was meant to remove.
   */
  checkValidityOfInverse(): void {
    const name = this.definition.inverseOf;

    if (name === undefined) return;

    const target = this.associationClass() as ReflectingModel;

    if (target.reflectOnAssociation(name) === undefined) {
      throw new ReflectionError(
        `${this.owner.name}.${this.name} names "${name}" as its inverse, but ` +
          `${target.name} has no association called that.`,
      );
    }
  }

  /**
   * The association on this model that the `through` names. Rails'
   * `through_reflection`.
   */
  throughReflection(): Reflection {
    const name = this.definition.through;

    if (name === undefined) {
      throw new ReflectionError(`${this.owner.name}.${this.name} is not a through association.`);
    }

    const found = this.owner.reflectOnAssociation(name);

    if (!found) {
      throw new ReflectionError(
        `${this.owner.name}.${this.name} goes through "${name}", but ${this.owner.name} has no ` +
          `association called that.`,
      );
    }

    return new Reflection(found, this.owner);
  }

  /** The class in the middle. Rails' `through_model`. */
  throughModel(): ModelLike {
    return this.throughReflection().associationClass();
  }

  /**
   * The reflection on the intermediate class that carries the second hop.
   * Rails' `source_reflection`.
   */
  sourceReflection(): Reflection {
    const middle = this.throughModel() as ReflectingModel;
    const name = this.sourceReflectionName();
    const found = middle.reflectOnAssociation(name);

    if (!found) {
      throw new ReflectionError(
        `${this.owner.name}.${this.name} reaches through ${middle.name}, but ${middle.name} has ` +
          `no association called "${name}". Name one with \`source\`. ` +
          `It has: ${
            middle
              .reflectOnAllAssociations()
              .map((each) => each.name)
              .join(", ") || "none"
          }.`,
      );
    }

    return new Reflection(found, middle);
  }

  /** Which name on the intermediate to follow. Rails' `source_reflection_name`. */
  sourceReflectionName(): string {
    return this.definition.source ?? this.name;
  }

  /**
   * The names it would accept, singular and plural. Rails'
   * `source_reflection_names`.
   *
   * Both, because the declaration is plural (`comments`) and the association on
   * the intermediate may be either — and the error for guessing wrong is worth
   * being able to list what was tried.
   */
  sourceReflectionNames(): string[] {
    const name = this.sourceReflectionName();
    const singular = name.endsWith("s") ? name.slice(0, -1) : name;

    return name === singular ? [name] : [name, singular];
  }

  /**
   * The step between owner and target, for a chain of more than two. Rails'
   * `middle_reflection`.
   *
   * Undefined for an ordinary two-hop `through`, where there is no middle
   * beyond the through itself.
   */
  middleReflection(): Reflection | undefined {
    if (!this.isThrough()) return undefined;

    const through = this.throughReflection();

    return through.isThrough() ? through.throughReflection() : undefined;
  }

  /** The narrowing the association was declared with, if any. Rails' `scope`. */
  scopeForAssociation(): AssociationDefinition["scope"] {
    return this.definition.scope;
  }

  /** Whether it was declared with one. */
  hasScope(): boolean {
    return this.definition.scope !== undefined;
  }
}

/**
 * Builds one. Rails' `Reflection.create`.
 *
 * A function rather than a constructor call at every site, so that adding a
 * kind that needs a different class later changes one place.
 */
export function createReflection(
  definition: AssociationDefinition,
  owner: ReflectingModel,
): Reflection {
  return new Reflection(definition, owner);
}

const cache = new WeakMap<ReflectingModel, Map<string, Reflection>>();

/**
 * Records one against a model, so it is built once. Rails' `add_reflection`.
 *
 * Cached because resolving a `through` walks two classes and the answer cannot
 * change without the declaration changing — and this is on the path of every
 * query that touches the association.
 */
export function addReflection(owner: ReflectingModel, name: string, reflection: Reflection): void {
  let byName = cache.get(owner);

  if (!byName) {
    byName = new Map();
    cache.set(owner, byName);
  }

  byName.set(name, reflection);
}

/** The reflection for one association, built and cached on first ask. */
export function reflectionFor(owner: ReflectingModel, name: string): Reflection | undefined {
  const held = cache.get(owner)?.get(name);

  if (held) return held;

  const definition = owner.reflectOnAssociation(name);

  if (!definition) return undefined;

  const built = createReflection(definition, owner);
  addReflection(owner, name, built);

  return built;
}

/** Every association on a model, as reflections. Rails' `normalized_reflections`. */
export function normalizedReflections(owner: ReflectingModel): Map<string, Reflection> {
  const all = new Map<string, Reflection>();

  for (const definition of owner.reflectOnAllAssociations()) {
    all.set(definition.name, reflectionFor(owner, definition.name) as Reflection);
  }

  return all;
}

/**
 * The associations that could plausibly have been meant by a name. Rails'
 * `likely_reflections`.
 *
 * For the error message when a name does not resolve. A misspelling is the
 * usual cause, and "did you mean comments?" ends the search that "no such
 * association" starts.
 */
export function likelyReflections(owner: ReflectingModel, name: string): string[] {
  const wanted = name.toLowerCase();

  return owner
    .reflectOnAllAssociations()
    .map((each) => each.name)
    .filter((each) => {
      const candidate = each.toLowerCase();

      return (
        candidate.startsWith(wanted.slice(0, 3)) ||
        wanted.startsWith(candidate.slice(0, 3)) ||
        candidate === `${wanted}s` ||
        `${candidate}s` === wanted
      );
    });
}

/** Forgets what was built, for a model whose associations were redeclared. */
export function clearReflectionsCache(owner: ReflectingModel): void {
  cache.delete(owner);
}
