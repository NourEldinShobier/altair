/**
 * Mixins that carry their own class-level half, ported from
 * `ActiveSupport::Concern` and the redefinition helpers in
 * `Module#silence_redefinition_of_method`.
 *
 * A mixin almost always wants to add two things: instance methods, and class
 * methods that configure them. `has_secure_password` adds `authenticate` to
 * instances and `has_secure_password` itself to the class. Without help, that
 * is two modules and a hook that remembers to extend one when the other is
 * included — which every codebase writes slightly differently, and which
 * breaks in a specific way nobody expects.
 *
 * The specific way is **the dependency problem**. A concern that needs another
 * concern cannot simply include it: at the moment the inner one is included
 * into the outer *module*, there is no class yet, so its class-methods half
 * has nothing to extend. Rails solves this by having a concern remember its
 * dependencies and replay them onto whatever class eventually includes it.
 * Written by hand, the symptom is a `NoMethodError` for a class method that is
 * plainly declared — in a file that is plainly loaded.
 *
 * The redefinition helpers exist for a smaller reason with the same shape:
 * defining a method that already exists is usually a bug and occasionally
 * deliberate, and the two need to be told apart *at the definition*, not by
 * reading a warning log nobody reads.
 */

export interface Concern {
  name: string;
  /** What instances get. */
  instanceMethods: Record<string, unknown>;
  /** What the class gets. */
  classMethods: Record<string, unknown>;
  /** Concerns this one needs included first. */
  dependencies: Concern[];
  /** Run against the class at include time. */
  included?: (target: ConcernTarget) => void;
  /** Run against the class at prepend time. */
  prepended?: (target: ConcernTarget) => void;
}

export interface ConcernTarget {
  name: string;
  prototype: Record<string, unknown>;
  statics: Record<string, unknown>;
  /** Which concerns have already been applied here. */
  applied: Set<string>;
}

export function newConcernTarget(name: string): ConcernTarget {
  return { name, prototype: {}, statics: {}, applied: new Set() };
}

export function defineConcern(name: string, parts: Partial<Omit<Concern, "name">> = {}): Concern {
  return {
    name,
    instanceMethods: parts.instanceMethods ?? {},
    classMethods: parts.classMethods ?? {},
    dependencies: parts.dependencies ?? [],
    ...(parts.included === undefined ? {} : { included: parts.included }),
    ...(parts.prepended === undefined ? {} : { prepended: parts.prepended }),
  };
}

/**
 * Rails' `class_methods do ... end`.
 *
 * A block rather than a second module, so the class-level half lives next to
 * the instance-level half it configures. Two modules in two places is how one
 * of them gets a method the other does not know about.
 */
export function classMethods(concern: Concern, methods: Record<string, unknown>): Concern {
  Object.assign(concern.classMethods, methods);

  return concern;
}

/** The instance-level half. */
export function instanceMethods(concern: Concern, methods: Record<string, unknown>): Concern {
  Object.assign(concern.instanceMethods, methods);

  return concern;
}

/**
 * Rails' `append_features` — what happens when a concern is included.
 *
 * The dependencies are applied first, and to the *class* rather than to this
 * concern. That is the whole trick: at the moment an inner concern is written
 * into an outer one there is no class yet, so its class-methods half would
 * have nothing to extend — and the symptom would be a `NoMethodError` for a
 * class method that is plainly declared in a file that is plainly loaded.
 *
 * Applying twice is a no-op rather than an error, because a diamond — two
 * concerns both depending on a third — is the normal case, and the second
 * application would otherwise overwrite whatever the class did in between.
 */
export function appendFeatures(concern: Concern, target: ConcernTarget): boolean {
  if (target.applied.has(concern.name)) return false;

  // Marked before the dependencies run, so a cycle stops rather than
  // recursing. Two concerns depending on each other is a declaration mistake,
  // and a stack overflow at boot is a worse way to report one than a missing
  // method is.
  target.applied.add(concern.name);

  for (const dependency of concern.dependencies) appendFeatures(dependency, target);

  Object.assign(target.prototype, concern.instanceMethods);
  Object.assign(target.statics, concern.classMethods);

  concern.included?.(target);

  return true;
}

/**
 * Rails' `prepend_features` — the same, but the concern's methods win.
 *
 * The difference matters for a concern that wraps something: prepended, its
 * `save` can call the class's own; included, the class's own simply replaces
 * it and the concern's is never reached. That failure is silent — the method
 * exists, it is just not the one running.
 */
export function prependFeatures(concern: Concern, target: ConcernTarget): boolean {
  if (target.applied.has(concern.name)) return false;

  target.applied.add(concern.name);

  for (const dependency of concern.dependencies) prependFeatures(dependency, target);

  // The class's own methods are re-applied over nothing here; what changes is
  // that a name the class already had is *kept* rather than overwritten.
  for (const [name, body] of Object.entries(concern.instanceMethods)) {
    if (!Object.hasOwn(target.prototype, name)) target.prototype[name] = body;
  }

  for (const [name, body] of Object.entries(concern.classMethods)) {
    if (!Object.hasOwn(target.statics, name)) target.statics[name] = body;
  }

  concern.prepended?.(target);

  return true;
}

/**
 * Rails' `concerning` — a named group of methods declared inline.
 *
 * For a class that has grown two responsibilities and is not yet worth
 * splitting: the group is a real module with a name, so it appears in a
 * backtrace and can be moved out later without changing what it does.
 */
export function concerning(
  target: ConcernTarget,
  name: string,
  build: (concern: Concern) => void,
): Concern {
  const concern = defineConcern(`${target.name}::${name}`);
  build(concern);
  appendFeatures(concern, target);

  return concern;
}

// --- defining methods carefully -------------------------------------------------------

/**
 * Rails' `method_added` hook — a record of what was defined where.
 *
 * Kept because the useful question is not "does this method exist" but "who
 * defined it last", and by the time anything looks, the answer is not
 * recoverable from the object.
 */
const definers = new Map<string, string[]>();

export function methodAdded(owner: string, name: string): void {
  const key = `${owner}#${name}`;
  const held = definers.get(key);

  if (held === undefined) definers.set(key, [owner]);
  else held.push(owner);
}

export function definedBy(owner: string, name: string): string[] {
  return [...(definers.get(`${owner}#${name}`) ?? [])];
}

export function resetDefinitions(): void {
  definers.clear();
}

/**
 * Rails' `redefine_method` — define, and say if something was replaced.
 *
 * Reports rather than warning to a log. Redefining is occasionally deliberate
 * and usually a bug, and the two have to be told apart at the definition — a
 * warning in a log nobody reads is indistinguishable from no warning.
 */
export function redefine(
  target: Record<string, unknown>,
  name: string,
  body: unknown,
): { replaced: boolean } {
  const replaced = Object.hasOwn(target, name);
  target[name] = body;

  return { replaced };
}

/**
 * Rails' `redefine_singleton_method`.
 *
 * Separate from `redefine` because a class method and an instance method of
 * the same name are different methods, and a helper that took "the object"
 * would silently define the wrong one for whichever the caller meant.
 */
export function redefineSingletonMethod(
  target: { statics: Record<string, unknown> },
  name: string,
  body: unknown,
): { replaced: boolean } {
  return redefine(target.statics, name, body);
}

/**
 * Rails' `remove_possible_singleton_method` — remove it if it is there.
 *
 * Does not raise for a method that was never defined, because the caller is
 * usually undoing a definition that may or may not have happened — a test
 * tearing down a stub, a reloader dropping generated methods.
 */
export function removePossibleSingletonMethod(
  target: { statics: Record<string, unknown> },
  name: string,
): boolean {
  if (!Object.hasOwn(target.statics, name)) return false;

  delete target.statics[name];

  return true;
}

/**
 * Rails' `silence_redefinition_of_method` — redefine on purpose, quietly.
 *
 * The declaration that a replacement is intended. Without a way to say so, the
 * only options are a warning on every legitimate redefinition — which trains
 * everybody to ignore them — or none at all.
 */
export function silenceRedefinitionOfMethod(
  target: Record<string, unknown>,
  name: string,
  body: unknown,
): void {
  delete target[name];
  target[name] = body;
}

/**
 * Rails' `class_eval` — run a block against a class.
 *
 * Returns what the block produced, so a caller can keep a handle on whatever
 * was defined. Rails' version returns the block's value for the same reason,
 * and losing it forces every caller to reach back into the class by name.
 */
export function classEval<T>(target: ConcernTarget, body: (target: ConcernTarget) => T): T {
  return body(target);
}

// --- asking about an object ------------------------------------------------------------

/**
 * Rails' `is_a?` across a named ancestry.
 *
 * By name rather than by identity, because a reloaded class in development is
 * a different object with the same name — and an identity check turns every
 * reload into a type error for objects created before it.
 *
 * Rails' `try` is not here: `misc.ts`'s `tryCall` already is it, down to
 * calling only a method that is genuinely absent and letting one that exists
 * and raises still raise.
 */
export function isA(object: { ancestry?: readonly string[] }, name: string): boolean {
  return (object.ancestry ?? []).includes(name);
}

/**
 * Rails' `Module#instance` — the single instance a module-level object keeps.
 *
 * Built on first use rather than at load, because a module built at load time
 * runs before configuration and captures whatever the defaults were.
 */
const instances = new Map<string, unknown>();

export function instance<T>(name: string, build: () => T): T {
  if (!instances.has(name)) instances.set(name, build());

  return instances.get(name) as T;
}

export function resetInstances(): void {
  instances.clear();
}
