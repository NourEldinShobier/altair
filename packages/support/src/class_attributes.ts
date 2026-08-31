/**
 * Configuration that a subclass can override without disturbing its parent,
 * ported from `ActiveSupport`'s `class_attribute`, `mattr_accessor`,
 * `thread_mattr_accessor` and `attr_internal`.
 *
 * This is the mechanism under most of Rails' configuration:
 * `Model.strictLoadingByDefault`, `Controller.protectFromForgery`,
 * `Job.queueName`. A base class declares a default, any subclass may change its
 * own, and neither direction leaks.
 *
 * In JavaScript that last part is the whole difficulty. Prototype inheritance
 * gives a subclass a *reference* to the parent's value, not a copy — so
 * `Child.options.timeout = 5` reaches through and edits `Parent.options`, and
 * every other subclass silently changes with it. It is the classic shared-
 * mutable-default bug, and it is invisible until two subclasses disagree about
 * a value neither of them set.
 *
 * So a write always writes to the class it was called on, and a read walks up
 * only until it finds an own value. Nothing is ever mutated in place.
 */

import { moduleParentName } from "./objects.js";

/**
 * `objects.ts` already declares `classAttribute`, with exactly this
 * inheritance rule: a read walks up until something has a value of its own, a
 * write lands on the class it was called on. Nothing here re-implements it —
 * what follows builds on it, because two stores for one concept means a value
 * set through one is invisible to the other.
 */

/**
 * A copy a subclass can safely change. Rails' `inheritable_copy`.
 *
 * Shallow for arrays and plain objects, and only those: copying deeply would
 * duplicate whatever a value happens to reference — a connection, a logger, a
 * compiled regexp — and the copy would then diverge from the thing it was
 * supposed to be.
 */
export function inheritableCopy<T>(value: T): T {
  if (Array.isArray(value)) return [...value] as T;

  if (isPlainObject(value)) return { ...value } as T;

  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;

  const proto = Object.getPrototypeOf(value) as unknown;

  return proto === Object.prototype || proto === null;
}

/**
 * Reads a class attribute for modification. Rails' `self.list = list + [x]`,
 * as one step.
 *
 * Copies the inherited value and assigns it back, so the copy is owned by this
 * class and appending to it does not append to the parent's. Callers that
 * mutate whatever a plain read returned are the entire reason this exists: in
 * JavaScript that read hands back the parent's own array.
 */
export function mutableClassAttribute<T>(target: Record<string, unknown>, name: string): T {
  const copy = inheritableCopy(target[name]) as T;

  // Through the accessor, so the write lands on `target` rather than wherever
  // the value was inherited from.
  target[name] = copy;

  return copy;
}

// --- module-level attributes -----------------------------------------------

const moduleValues = new Map<string, unknown>();

/** Rails' `mattr_writer`. */
export function mattrWriter(name: string, value: unknown): void {
  moduleValues.set(name, value);
}

/** Rails' `mattr_reader`. */
export function mattrReader(name: string): unknown {
  return moduleValues.get(name);
}

/** Rails' `mattr_accessor` — one shared value, for genuinely global settings. */
export function mattrAccessor<T>(
  name: string,
  defaultValue?: T,
): { get(): T; set(value: T): void } {
  if (defaultValue !== undefined && !moduleValues.has(name)) moduleValues.set(name, defaultValue);

  return {
    get: () => moduleValues.get(name) as T,
    set: (value: T) => moduleValues.set(name, value),
  };
}

export function clearModuleAttributes(): void {
  moduleValues.clear();
}

// --- per-task attributes ---------------------------------------------------

/**
 * A value scoped to one unit of work. Rails' `thread_mattr_accessor`.
 *
 * The distinction from `mattrAccessor` is the entire point, and getting it
 * wrong is a data leak rather than a bug: a "current user" held in a module
 * variable is shared by every request the process is serving, so one user's
 * page can render with another's identity. A per-task store cannot do that.
 */
export interface TaskStore {
  get(name: string): unknown;
  set(name: string, value: unknown): void;
}

let currentStore: TaskStore | undefined;

export function useTaskStore(store: TaskStore | undefined): void {
  currentStore = store;
}

export function threadMattrWriter(name: string, value: unknown): void {
  if (!currentStore) throw new NoTaskStore(name);

  currentStore.set(name, value);
}

export function threadMattrReader(name: string): unknown {
  return currentStore?.get(name);
}

export function threadMattrAccessor<T>(name: string): {
  get(): T | undefined;
  set(value: T): void;
} {
  return {
    get: () => threadMattrReader(name) as T | undefined,
    set: (value: T) => threadMattrWriter(name, value),
  };
}

export class NoTaskStore extends Error {
  constructor(name: string) {
    super(
      `Cannot set ${JSON.stringify(name)}: nothing has opened a per-task store. Falling back to ` +
        `a process-wide value here is how one request's data reaches another request's page, so ` +
        `this refuses instead.`,
    );
    this.name = "NoTaskStore";
  }
}

// --- internal attributes ---------------------------------------------------

let internalFormat = "_%s";

/** Rails' `attr_internal_naming_format`. */
export function attrInternalNamingFormat(format?: string): string {
  if (format !== undefined) {
    if (!format.includes("%s")) {
      throw new Error(
        `An attr_internal naming format has to contain %s, or every internal attribute would ` +
          `share one name and overwrite the others.`,
      );
    }

    internalFormat = format;
  }

  return internalFormat;
}

export function resetAttrInternalNamingFormat(): void {
  internalFormat = "_%s";
}

/**
 * The property an internal attribute actually uses. Rails' `attr_internal_ivar_name`.
 *
 * Prefixed so a framework's own bookkeeping cannot collide with an
 * application's attribute of the same name — the collision would be silent,
 * and whichever wrote last would win.
 */
export function attrInternalName(name: string): string {
  return internalFormat.replace("%s", name);
}

export function attrInternalReader(target: Record<string, unknown>, name: string): unknown {
  return target[attrInternalName(name)];
}

export function attrInternalWriter(
  target: Record<string, unknown>,
  name: string,
  value: unknown,
): void {
  target[attrInternalName(name)] = value;
}

export function attrInternalAccessor(
  target: Record<string, unknown>,
  name: string,
): { get(): unknown; set(value: unknown): void } {
  return {
    get: () => attrInternalReader(target, name),
    set: (value: unknown) => attrInternalWriter(target, name, value),
  };
}

/** Rails' `config_accessor` — a class attribute reached through `config`. */
export function configAccessor<T>(
  target: Record<string, unknown>,
  name: string,
  defaultValue?: T,
): { get(): T; set(value: T): void } {
  if (defaultValue !== undefined && target[name] === undefined) target[name] = defaultValue;

  return {
    get: () => target[name] as T,
    set: (value: T) => {
      target[name] = value;
    },
  };
}

// --- classes ---------------------------------------------------------------

const registry = new Map<string, unknown>();

/** Rails' `constantize` over an explicit registry rather than the whole runtime. */
export function registerConstant(name: string, value: unknown): void {
  registry.set(name, value);
}

export function clearConstants(): void {
  registry.clear();
}

export class NameError extends Error {
  constructor(name: string, known: readonly string[]) {
    super(
      `No constant called ${JSON.stringify(name)}. Registered: ${known.join(", ") || "none"}. ` +
        `Resolving a name against everything the process has loaded is how a string from a ` +
        `request becomes a class.`,
    );
    this.name = "NameError";
  }
}

/** Rails' `constantize`. */
export function constantize(name: string): unknown {
  if (!registry.has(name)) throw new NameError(name, [...registry.keys()].sort());

  return registry.get(name);
}

/**
 * Rails' `safe_constantize` — the same, answering `undefined` instead.
 *
 * For the case where a missing constant is an expected outcome rather than a
 * bug, such as looking for an optional adapter. Everything else should use
 * `constantize`, because an error naming the constant beats `undefined`
 * arriving somewhere else.
 */
export function safeConstantize(name: string): unknown {
  return registry.get(name);
}

/** Rails' `module_parent`. `moduleParentName` already lives in `objects.ts`. */
export function moduleParent(name: string): unknown {
  const parent = moduleParentName(name);

  return parent === undefined ? undefined : safeConstantize(parent);
}

/** Rails' `anonymous?`. */
export function anonymous(klass: unknown): boolean {
  return !(klass as { name?: string })?.name;
}

/**
 * Rails' `subclasses` — direct descendants only.
 *
 * Direct, because `descendants` is the transitive version and the two answer
 * different questions: "which classes extend this one" and "everything below
 * it". Conflating them makes a registry of handlers pick up an abstract
 * intermediate class as though it were one.
 */
export function subclasses(base: unknown, candidates: readonly unknown[]): unknown[] {
  return candidates.filter((each) => Object.getPrototypeOf(each) === base);
}

/** Rails' `descendants`. */
export function descendants(base: unknown, candidates: readonly unknown[]): unknown[] {
  return candidates.filter((each) => each !== base && isDescendant(each, base));
}

function isDescendant(candidate: unknown, base: unknown): boolean {
  for (
    let current = candidate;
    current !== null && current !== undefined;
    current = Object.getPrototypeOf(current) as unknown
  ) {
    if (current === base) return true;
  }

  return false;
}

// --- redefining --------------------------------------------------------------

/**
 * Rails' `silence_redefinition_of_method` / `redefine_method`.
 *
 * Replacing a method that was there is normal in a framework that generates
 * accessors; replacing one it did *not* expect to exist usually means an
 * application defined something the framework is about to overwrite. Reporting
 * which happened is the whole value — silently overwriting is how a hand
 * written method disappears.
 */
export function redefineMethod(
  target: Record<string, unknown>,
  name: string,
  implementation: unknown,
): { replaced: boolean } {
  const replaced = Object.hasOwn(target, name);
  target[name] = implementation;

  return { replaced };
}

/** Rails' `remove_possible_method`. */
export function removePossibleMethod(target: Record<string, unknown>, name: string): boolean {
  if (!Object.hasOwn(target, name)) return false;

  delete target[name];

  return true;
}

/** Rails' `method_defined_within?`. */
export function methodDefinedWithin(target: object, name: string, boundary: object): boolean {
  for (
    let current: object | null = target;
    current !== null && current !== boundary;
    current = Object.getPrototypeOf(current) as object | null
  ) {
    if (Object.hasOwn(current, name)) return true;
  }

  return false;
}

/** Rails' `method_visibility`. */
export function methodVisibility(
  target: Record<string, unknown>,
  name: string,
): "public" | "private" | "none" {
  if (name.startsWith("#") || name.startsWith("_")) return "private";

  return name in target ? "public" : "none";
}
