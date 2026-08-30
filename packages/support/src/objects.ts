/**
 * The object and class helpers ActiveSupport puts on `Object` and `Module`.
 *
 * Only the ones that mean something in JavaScript. Ruby's `mattr_accessor`
 * family has no counterpart worth writing — a module-level value is a
 * variable here — and `subclasses` cannot be answered at all without a
 * registry, since nothing in the language tracks who extended what.
 */

/**
 * Declares a class-level setting that subclasses inherit but do not share.
 *
 * Rails' `class_attribute`, and the reason it exists is the half of the
 * behaviour that is easy to leave out. Reading walks the prototype chain, so a
 * subclass sees whatever its parent was given. Writing puts the value on the
 * class doing the writing, so a subclass that changes it does not reach back
 * and change it for its parent and every sibling.
 *
 *     classAttribute(Post, "perPage", 25)
 *     class Draft extends Post {}
 *     Draft.perPage = 10    // Post.perPage is still 25
 *
 * Getting this wrong is quiet. Without the copy on write, one subclass setting
 * a value reconfigures every other model in the process, and nothing fails
 * until something far away behaves oddly.
 */
export function classAttribute<T>(target: object, name: string, initial: T): void {
  const values = new WeakMap<object, T>();

  values.set(target, initial);

  Object.defineProperty(target, name, {
    configurable: true,
    get(this: object): T | undefined {
      if (values.has(this)) return values.get(this);

      // Walks up until something has a value of its own, which is what makes
      // an unset subclass see its parent's.
      let current = Object.getPrototypeOf(this) as object | null;

      while (current) {
        if (values.has(current)) return values.get(current);
        current = Object.getPrototypeOf(current) as object | null;
      }

      return undefined;
    },
    set(this: object, value: T) {
      values.set(this, value);
    },
  });
}

/**
 * Copies a class-level array or object before changing it, so a subclass keeps
 * its own.
 *
 * The manual half of `classAttribute`, for the many places that store a list
 * on the class and push to it. `this.validations.push(...)` on a subclass
 * mutates the array the parent owns, because the subclass never had one — it
 * was reading the parent's through the prototype chain the whole time.
 */
export function ownCopy<T extends object, K extends keyof T>(target: T, name: K): void {
  if (!Object.hasOwn(target, name as PropertyKey)) {
    const value = target[name];
    target[name] = (Array.isArray(value) ? [...value] : { ...value }) as T[K];
  }
}

/**
 * Forwards methods to something the object holds. Rails' `delegate`.
 *
 *     delegate(Order, ["street", "city"], "address")
 *
 * The Law of Demeter chore, written once instead of once per method. It is
 * defined on the target itself, so it shows up in `in` and does not depend on
 * a proxy sitting in the way of every other property.
 *
 * `allowNil` answers undefined instead of throwing when the holder is absent,
 * which is what you want for an optional association and emphatically not the
 * default: a silent undefined from a typo reads exactly like a missing value.
 */
export function delegate(
  target: object,
  methods: readonly string[],
  to: string,
  { allowNil = false, prefix }: { allowNil?: boolean; prefix?: string } = {},
): void {
  for (const method of methods) {
    const name = prefix ? `${prefix}_${method}` : method;

    // A getter rather than a method, because JavaScript separates the two and
    // Ruby does not: `order.street` and `order.describe()` are both plain
    // method calls there. Reading gives the value; when the value is a
    // function it comes back bound to the holder, so calling it works too.
    Object.defineProperty(target, name, {
      configurable: true,
      get(this: Record<string, unknown>): unknown {
        const holder = this[to] as Record<string, unknown> | null | undefined;

        if (holder === null || holder === undefined) {
          if (allowNil) return undefined;
          throw new TypeError(`${to} is ${String(holder)}: cannot delegate ${method} to it`);
        }

        const value = holder[method];

        return typeof value === "function" ? value.bind(holder) : value;
      },
    });
  }
}

/**
 * Forwards anything unrecognised to something the object holds. Rails'
 * `delegate_missing_to`.
 *
 * Returns a proxy, because JavaScript has no `method_missing` — which is also
 * the reason to prefer `delegate` where the list is known. A proxy answers for
 * names nobody has thought about, including the ones a future version of the
 * holder grows, and that is a wide door to leave open.
 */
export function delegateMissingTo<T extends object>(object: T, to: keyof T & string): T {
  return new Proxy(object, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);

      const holder = Reflect.get(target, to, receiver) as Record<PropertyKey, unknown> | null;
      if (holder === null || holder === undefined) return undefined;

      const value = holder[property];

      return typeof value === "function" ? value.bind(holder) : value;
    },

    has(target, property) {
      if (Reflect.has(target, property)) return true;

      const holder = Reflect.get(target, to) as object | null;

      return holder !== null && holder !== undefined && property in holder;
    },
  });
}

/**
 * The namespace enclosing a qualified name. Rails' `module_parent_name`.
 *
 * Works on the `Admin::Users::Post` spelling the inflector already uses in
 * `demodulize` and `deconstantize`, since that is how this codebase writes a
 * namespaced model name.
 */
export function moduleParentName(name: string): string | undefined {
  const index = name.lastIndexOf("::");

  return index === -1 ? undefined : name.slice(0, index);
}

/**
 * Every enclosing namespace, innermost first. Rails' `module_parents`.
 *
 *     moduleParents("Admin::Users::Post")  // ["Admin::Users", "Admin"]
 */
export function moduleParents(name: string): string[] {
  const parents: string[] = [];

  for (let current = moduleParentName(name); current; current = moduleParentName(current)) {
    parents.push(current);
  }

  return parents;
}

/** An object's own enumerable properties. Rails' `instance_values`. */
export function instanceValues(object: object): Record<string, unknown> {
  return { ...object };
}

/** Their names. Rails' `instance_variable_names`. */
export function instanceVariableNames(object: object): string[] {
  return Object.keys(object);
}

/**
 * Whether copying this value would produce anything. Rails' `duplicable?`.
 *
 * Numbers, strings, booleans, null, undefined and symbols are immutable, so a
 * copy is the value itself. Asking first is how a deep-copy routine avoids
 * pointless work, and how a caller knows whether holding a reference is safe.
 */
export function duplicable(value: unknown): boolean {
  return typeof value === "object" ? value !== null : typeof value === "function";
}
