/**
 * Which of a controller's methods a request may reach, ported from
 * `AbstractController::Base#action_methods`.
 *
 * A dispatcher that calls whatever the URL names is a dispatcher that can be
 * asked for `redirectTo`, `verifyAuthenticityToken`, `constructor`, or
 * anything else the framework put on the class. Rails' rule is the one that
 * makes this safe without a list anybody has to maintain: an action is a
 * public method the controller *itself* defined, and everything inherited is
 * machinery.
 *
 * That rule is worth stating because the tempting alternatives are both
 * wrong. Checking the method exists lets a request call `toString`. Keeping a
 * hand-written allowlist works until somebody adds an action and forgets, and
 * the symptom is a 404 on a route that plainly exists.
 */

/** Anything with a prototype chain — every class. */
type ClassLike = { prototype: object; name?: string };

/**
 * Names defined directly on a class, excluding the constructor.
 *
 * Own properties only: walking the chain would sweep up the base controller's
 * methods, which is exactly what this exists to keep out.
 */
function ownMethodNames(klass: ClassLike): string[] {
  return Object.getOwnPropertyNames(klass.prototype).filter((name) => {
    if (name === "constructor") return false;

    const descriptor = Object.getOwnPropertyDescriptor(klass.prototype, name);

    // A getter is not an action. Calling one to dispatch would run it for its
    // side effects, and `get session()` is the kind of thing that then builds
    // a session for a request that never asked for one.
    return descriptor?.get === undefined && typeof descriptor?.value === "function";
  });
}

/**
 * Every action a controller exposes. Rails' `action_methods`.
 *
 * Walks up to — but not including — the base class it is given, so a
 * controller inheriting from an application-wide base still exposes what that
 * base defined. That is what makes a shared `index` on `AdminController`
 * reachable from every controller under it.
 */
export function actionMethods(klass: ClassLike, base: ClassLike): string[] {
  const found = new Set<string>();

  for (
    let current: ClassLike | null = klass;
    current && current !== base;
    current = Object.getPrototypeOf(current) as ClassLike | null
  ) {
    for (const name of ownMethodNames(current)) found.add(name);
  }

  return [...found].sort();
}

/** The same, as a set, for a dispatcher checking one name. */
export function availableActions(klass: ClassLike, base: ClassLike): Set<string> {
  return new Set(actionMethods(klass, base));
}

/** Whether a request may reach this name. Rails' `action_method?`. */
export function isActionMethod(klass: ClassLike, base: ClassLike, name: string): boolean {
  return availableActions(klass, base).has(name);
}

/**
 * The function an action name resolves to, or undefined. Rails'
 * `method_for_action`.
 *
 * Undefined rather than a throw, because "no such action" is a 404 and the
 * caller is better placed than this to say so — a router that has already
 * matched a route may want to fall through to a template instead.
 */
export function methodForAction(
  klass: ClassLike,
  base: ClassLike,
  name: string,
): ((...args: never[]) => unknown) | undefined {
  if (!isActionMethod(klass, base, name)) return undefined;

  const method = (klass.prototype as Record<string, unknown>)[name];

  return typeof method === "function" ? (method as (...args: never[]) => unknown) : undefined;
}

/** Raised when a request names something that is not an action. */
export class UnknownAction extends Error {
  constructor(
    readonly controller: string,
    readonly action: string,
    available: readonly string[],
  ) {
    super(
      `${controller} has no action named "${action}". ` +
        `It exposes: ${available.join(", ") || "nothing"}.`,
    );
    this.name = "UnknownAction";
  }
}

/**
 * Calls an action through the allowlist. Rails' `send_action`.
 *
 * The one entry point a dispatcher should use. Calling the method directly
 * works and skips the check, which is the whole failure this prevents — so the
 * check lives here rather than in a comment asking people to remember it.
 */
export async function sendAction(
  controller: object,
  base: ClassLike,
  name: string,
  ...args: never[]
): Promise<unknown> {
  const klass = controller.constructor as ClassLike;

  if (!isActionMethod(klass, base, name)) {
    throw new UnknownAction(klass.name ?? "Controller", name, actionMethods(klass, base));
  }

  const method = (controller as Record<string, unknown>)[name] as (...rest: never[]) => unknown;

  return await method.apply(controller, args);
}
