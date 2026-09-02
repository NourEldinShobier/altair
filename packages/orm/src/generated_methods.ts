/**
 * Where a model's generated methods live, ported from
 * `ActiveRecord::Core.generated_association_methods`,
 * `ActiveModel::AttributeMethods` and `ActiveRecord::Delegation`.
 *
 * A model generates a great many methods — one reader and one writer per
 * column, per association, per enum member, plus a scope method for every
 * scope. `model.ts` defines those straight onto `Model.prototype`, which is the
 * same place a developer's own methods land, and that is a collision waiting
 * for a column named after a method somebody wrote:
 *
 *     class Post extends Model {
 *       get title() { return this.rawTitle.trim() }   // written by hand
 *     }
 *     // …then a `title` column generates a reader onto the same prototype.
 *
 * Whichever ran last wins, so the answer depends on whether the column was
 * introspected before or after the class body ran — and the loser leaves no
 * trace. Rails puts every generated method in a module *included* in the model,
 * which fixes both halves at once:
 *
 * - The class's own definitions win, always, because an own property shadows an
 *   inherited one. A hand-written accessor stops being a race.
 * - The generated one is still reachable underneath, so the hand-written
 *   accessor can call it — `super.title` — instead of reimplementing what the
 *   generated reader does.
 *
 * The module also gives an honest answer to "did the application define this",
 * which is what decides whether a column named `save` is a mistake to refuse or
 * an override to respect. Asked of the prototype alone, every generated method
 * looks application-defined and nothing is ever refused.
 *
 * A relation gets the same treatment for the opposite reason: `Post.published`
 * has to work on `Post.all` as well as on `Post`, so Rails builds a *subclass*
 * of Relation per model and compiles the model's methods into it — rather than
 * onto Relation itself, where `Post`'s scopes would appear on `Comment.all`.
 */

/** A class with a prototype — a model, or a relation base. */
export interface Constructable {
  prototype: object;
  name: string;
}

const modules = new WeakMap<object, Map<string, object>>();

/**
 * The module a namespace's generated methods go into, inserted into the model's
 * prototype chain the first time it is asked for.
 *
 * Inserted *below* the class's own prototype rather than above it: an own
 * property shadows an inherited one, so the class's definitions win without
 * anything having to check for them, and generation order stops mattering.
 */
export function generatedMethods(model: Constructable, namespace: string): object {
  let held = modules.get(model);

  if (held === undefined) {
    held = new Map<string, object>();
    modules.set(model, held);
  }

  const existing = held.get(namespace);

  if (existing !== undefined) return existing;

  const inserted = Object.create(Object.getPrototypeOf(model.prototype) as object) as object;
  Object.setPrototypeOf(model.prototype, inserted);
  held.set(namespace, inserted);

  return inserted;
}

/** Rails' `generated_association_methods` — the module association readers go in. */
export function generatedAssociationMethods(model: Constructable): object {
  return generatedMethods(model, "associations");
}

/** The module attribute readers and writers go in. */
export function generatedAttributeMethods(model: Constructable): object {
  return generatedMethods(model, "attributes");
}

/**
 * Rails' `GeneratedRelationMethods#generate_method` — define it once.
 *
 * Returns early when the module already has it, rather than redefining. Two
 * associations that would generate the same name is a mistake worth keeping
 * whichever was declared first, because redefining silently would make the
 * model's behaviour depend on declaration order in a file.
 */
export function generateMethod(
  target: object,
  name: string,
  implementation: (this: unknown, ...args: never[]) => unknown,
): boolean {
  if (Object.hasOwn(target, name)) return false;

  Object.defineProperty(target, name, {
    value: implementation,
    writable: true,
    configurable: true,
    // Not enumerable: a generated method that showed up in `Object.keys` or a
    // spread would be serialised into JSON responses and copied by every
    // `{ ...record }`.
    enumerable: false,
  });

  return true;
}

/**
 * Rails' `instance_method_already_implemented?`.
 *
 * True only for a method the *class itself* defines — not one generated into
 * its modules, and not one inherited from the framework's base class. That is
 * the distinction the whole dangerous-attribute check rests on: a column named
 * `save` must be refused, and a `save` the developer wrote must be respected,
 * and both are "a method exists with that name".
 */
export function instanceMethodAlreadyImplemented(model: Constructable, name: string): boolean {
  return Object.hasOwn(model.prototype, name);
}

/**
 * Every method the class itself defines, for the dangerous-attribute check.
 *
 * Own properties of the prototype only, so a generated method is not mistaken
 * for one somebody wrote — which would make every dangerous column look
 * deliberate.
 */
export function applicationMethodsOf(model: Constructable): Set<string> {
  return new Set(
    Object.getOwnPropertyNames(model.prototype).filter((name) => name !== "constructor"),
  );
}

// --- the relation subclass a model gets ------------------------------------

/**
 * The relation-shaped classes a model gets a subclass of. Rails'
 * `Delegation.delegated_classes`.
 *
 * A registry rather than a literal list because the set is open: a collection
 * proxy and an association relation are relations too, and each needs its own
 * per-model subclass or a scope defined on the model would be missing from
 * `post.comments` while present on `Comment.all`.
 */
const delegated: Constructable[] = [];

export function registerDelegatedClass(klass: Constructable): void {
  if (!delegated.includes(klass)) delegated.push(klass);
}

export function delegatedClasses(): readonly Constructable[] {
  return delegated;
}

export function resetDelegatedClasses(): void {
  delegated.length = 0;
}

/**
 * Rails' `uncacheable_methods` — what must not be compiled into a delegation.
 *
 * The methods a delegated class has that the base relation does not. Compiling
 * a delegation for one of those would send it to the *model* — so
 * `post.comments.build` would build against `Comment` and lose the owner, which
 * is a record saved with a null foreign key rather than an error.
 */
export function uncacheableMethods(base: Constructable): Set<string> {
  const baseNames = new Set(Object.getOwnPropertyNames(base.prototype));
  const names = new Set<string>();

  // `constructor` needs no exclusion of its own: every prototype has one, so
  // the base always does too.
  for (const klass of delegated) {
    for (const name of Object.getOwnPropertyNames(klass.prototype)) {
      if (!baseNames.has(name)) names.add(name);
    }
  }

  return names;
}

const delegateCaches = new WeakMap<object, Map<Constructable, Constructable>>();

/**
 * Rails' `initialize_relation_delegate_cache` — one subclass per relation kind.
 *
 * Built per model rather than shared, which is the whole point: methods
 * compiled into `Post`'s relation class are not on `Comment`'s, so
 * `Comment.all.published` is a missing method rather than a query against the
 * wrong table.
 */
export function initializeRelationDelegateCache(
  model: Constructable,
  bases: readonly Constructable[] = delegatedClasses(),
): Map<Constructable, Constructable> {
  const cache = new Map<Constructable, Constructable>();

  for (const base of bases) {
    const subclass = class extends (base as unknown as new (...args: never[]) => object) {};

    Object.defineProperty(subclass, "name", {
      value: `${model.name}_${base.name}`,
      configurable: true,
    });

    cache.set(base, subclass as unknown as Constructable);
  }

  delegateCaches.set(model, cache);

  return cache;
}

/** Rails' `relation_delegate_class` — the subclass for one relation kind. */
export function relationDelegateClass(
  model: Constructable,
  base: Constructable,
): Constructable | undefined {
  return delegateCaches.get(model)?.get(base);
}

/**
 * Rails' `generate_relation_method` — compile a model method onto its
 * relations.
 *
 * Onto every one of the model's relation subclasses, because a scope has to
 * work the same on `Post.all`, on `post.comments` and on a chained relation;
 * defined on only one of them, it is missing exactly where the chain got long
 * enough to be worth having.
 */
export function generateRelationMethod(
  model: Constructable,
  name: string,
  implementation: (this: unknown, ...args: never[]) => unknown,
): number {
  const cache = delegateCaches.get(model) ?? initializeRelationDelegateCache(model);
  let defined = 0;

  // Straight onto the subclass, not into a module underneath it. A model's
  // generated methods need a module because the class body is written by hand
  // and has to win; a relation subclass is generated whole and has no hand
  // written methods for a module to sit under.
  for (const subclass of cache.values()) {
    if (generateMethod(subclass.prototype, name, implementation)) defined += 1;
  }

  return defined;
}
