/**
 * What a template can see, and where it comes from — ported from
 * `ActionView::Rendering`, `AbstractController::Rendering` and
 * `AbstractController::Helpers`.
 *
 * `lookup_context.ts` finds a template. This decides what is in scope once one
 * is found, which is a separate question with a much less obvious answer.
 *
 * The shape Rails settled on is a class built per controller, not a shared
 * object with things assigned onto it:
 *
 * - **Helpers are mixed into a class, one per controller.** A shared context
 *   with helpers added at request time is a context whose contents depend on
 *   which controller ran last — under concurrency, on which controller is
 *   running *now*, in another thread. Building a class per controller makes
 *   the set of helpers a property of the controller rather than of the moment.
 * - **The class is inherited when nothing about it differs.** Two controllers
 *   with the same routes and the same helpers get one class rather than two
 *   identical ones. Rails checks this because the class is built once per
 *   controller *subclass*, and an application with two hundred controllers
 *   would otherwise compile two hundred near-identical classes at boot.
 * - **Instance variables cross into the template, but not all of them.** This
 *   is the part that surprises people: `@post` is visible to the template
 *   because Rails copies every instance variable across, and the framework's
 *   own bookkeeping — the request, the response, the lookup context — is
 *   excluded by name. Without the exclusion a template could reach the
 *   response object and a partial could rewrite the headers of the request
 *   rendering it.
 *
 * A helper method is the deliberate hole in that wall: `helperMethod :currentUser`
 * exposes one named method to templates rather than the controller itself,
 * because a template holding the controller can call anything on it — including
 * the actions.
 */

import { camelize, underscore } from "@altair/support";

/**
 * The controller's own bookkeeping. Rails' `_protected_ivars`.
 *
 * Excluded from what crosses into a template. A template that could reach the
 * response object would let a partial rewrite the headers of the request
 * rendering it, and one that could reach the controller could call an action.
 */
export const PROTECTED_INSTANCE_VARIABLES: readonly string[] = [
  "request",
  "response",
  "params",
  "lookupContext",
  "actionName",
  "controllerName",
  "headers",
  "routes",
  "viewRenderer",
  "viewContextClass",
  "helperProxy",
  "renderedFormat",
  "config",
];

/**
 * Rails' `view_assigns` — the controller state a template sees.
 *
 * Every instance variable except the framework's own, with the sigil dropped.
 * Copied rather than shared, so a template assigning to what looks like a
 * local cannot reach back into the controller after rendering has started.
 */
export function viewAssigns(
  controller: Record<string, unknown>,
  protectedNames: readonly string[] = PROTECTED_INSTANCE_VARIABLES,
): Record<string, unknown> {
  const assigns: Record<string, unknown> = {};

  for (const [name, value] of Object.entries(controller)) {
    // Leading underscore is the other convention Rails honours: a name it did
    // not think to list is still excluded if it was marked private.
    if (protectedNames.includes(name) || name.startsWith("_")) continue;
    if (typeof value === "function") continue;

    assigns[name] = value;
  }

  return assigns;
}

/** What a view context class is built from. */
export interface ViewContextSpec {
  /** Whether path helpers (`postPath`) are available, not just URL helpers. */
  supportsPath: boolean;
  /** The route set, identity-compared when deciding whether to inherit. */
  routes: unknown;
  /** The helper module, likewise. */
  helpers: unknown;
}

/** A built view context class: the base plus what was mixed into it. */
export interface ViewContextClass {
  base: unknown;
  supportsPath: boolean;
  routes: unknown;
  helpers: unknown;
  /** The methods a template may call on the controller. */
  helperMethods: string[];
}

/**
 * Rails' `inherit_view_context_class?`.
 *
 * Identity, not equality: two route sets with the same routes are still two
 * objects, and one of them can be reloaded in development while the other
 * cannot. Comparing by value would keep a stale class after a reload — which
 * shows up as a route helper that raises for a route the file plainly
 * declares.
 */
export function inheritViewContextClass(
  child: ViewContextSpec,
  parent: ViewContextSpec | undefined,
): boolean {
  if (parent === undefined) return false;

  return (
    child.supportsPath === parent.supportsPath &&
    child.routes === parent.routes &&
    child.helpers === parent.helpers
  );
}

/**
 * Rails' `build_view_context_class`.
 *
 * An anonymous subclass per controller, so the set of helpers a template can
 * call is a property of the controller rather than of whichever request most
 * recently added some.
 */
export function buildViewContextClass(
  base: unknown,
  { supportsPath, routes, helpers }: ViewContextSpec,
  helperMethods: readonly string[] = [],
): ViewContextClass {
  return { base, supportsPath, routes, helpers, helperMethods: [...helperMethods] };
}

const contextClasses = new WeakMap<object, ViewContextClass>();

/**
 * Rails' `view_context_class` — built once per controller class and kept.
 *
 * Memoised because building it is the expensive half: an application with two
 * hundred controllers would otherwise compose two hundred classes on every
 * request rather than at boot. Inherited when the parent's would be identical,
 * which is what keeps that number down in the first place.
 */
export function viewContextClass(
  controllerClass: object,
  base: unknown,
  spec: ViewContextSpec,
  parent?: { class: object; spec: ViewContextSpec },
  helperMethods: readonly string[] = [],
): ViewContextClass {
  const held = contextClasses.get(controllerClass);

  if (held !== undefined) return held;

  const built =
    parent !== undefined && inheritViewContextClass(spec, parent.spec)
      ? (contextClasses.get(parent.class) ??
        buildViewContextClass(base, parent.spec, helperMethods))
      : buildViewContextClass(base, spec, helperMethods);

  contextClasses.set(controllerClass, built);

  return built;
}

/**
 * Rails' reload hook — `LookupContext.view_context_class.changed?`.
 *
 * Development reloads the helper modules, and a context class built from the
 * old ones keeps answering with methods whose bodies no longer exist. Cheaper
 * to drop the class than to work out which of its parts moved.
 */
export function resetViewContextClass(controllerClass: object): void {
  contextClasses.delete(controllerClass);
}

/**
 * Rails' `view_context` — one instance for one render.
 *
 * Per render rather than per controller, because a context carries the
 * assigns: reusing one across two renders would let the second see what the
 * first assigned.
 */
export function viewContext(
  contextClass: ViewContextClass,
  lookupContext: unknown,
  assigns: Record<string, unknown>,
  controller: unknown,
): ViewContextInstance {
  return { contextClass, lookupContext, assigns: { ...assigns }, controller, rendered: [] };
}

export interface ViewContextInstance {
  contextClass: ViewContextClass;
  lookupContext: unknown;
  assigns: Record<string, unknown>;
  controller: unknown;
  rendered: string[];
}

/**
 * Rails' `view_renderer` — one per controller, not per render.
 *
 * The renderer holds the compiled-template cache, so a fresh one per render
 * would recompile every partial in a collection of a thousand items a thousand
 * times.
 */
export function viewRenderer(lookupContext: unknown): { lookupContext: unknown; renders: number } {
  return { lookupContext, renders: 0 };
}

/** Rails' test-case `rendered_views` bookkeeping. */
export function viewRendered(context: ViewContextInstance, template: string): void {
  context.rendered.push(template);
}

/**
 * Rails' `assign_controller` — hands a test's view context its controller.
 *
 * Set afterwards rather than at construction because a view test builds the
 * context first and the controller second; the alternative is a two-phase
 * constructor whose first phase produces an object that cannot render.
 */
export function assignController(context: ViewContextInstance, controller: unknown): void {
  context.controller = controller;
}

// --- helpers -----------------------------------------------------------------

/**
 * Rails' `controller_path` — `Admin::PostsController` becomes `admin/posts`.
 *
 * The template prefix comes from this, so it has to strip exactly the
 * `Controller` suffix and nothing else: a controller named `ControllerHelper`
 * would otherwise lose the wrong half of its name and look for templates in a
 * directory nothing put them in.
 */
export function controllerPath(className: string): string {
  return className
    .replace(/Controller$/, "")
    .split("::")
    .map((part) => underscore(part))
    .join("/");
}

/**
 * Rails' `determine_default_helper_class`.
 *
 * `PostsController` looks for `PostsHelper`. Returns nothing when there is
 * none rather than raising: a controller with no helper file is the normal
 * case, and Rails distinguishes it from a helper file that exists and fails to
 * load — which does raise, because that one is a bug rather than an absence.
 */
export function determineDefaultHelperClass(
  className: string,
  known: ReadonlyMap<string, unknown>,
): unknown {
  const name = `${className.replace(/Controller$/, "")}Helper`;

  return known.get(name);
}

/** Rails' `_helpers` — the module a controller's templates get. */
export function helperClass(controllerClass: string, known: ReadonlyMap<string, unknown>): unknown {
  return determineDefaultHelperClass(controllerClass, known);
}

/**
 * Rails' `helper_method` — expose named controller methods to templates.
 *
 * Named methods rather than the controller itself. A template holding the
 * controller can call anything on it, including the actions, and a partial
 * that invoked an action would run filters and render inside a render.
 */
export function helperMethod(target: { helperMethods: string[] }, ...names: string[]): string[] {
  for (const name of names) {
    if (!target.helperMethods.includes(name)) target.helperMethods.push(name);
  }

  return target.helperMethods;
}

/**
 * Rails' `helper_attr` — the reader and the writer.
 *
 * Both, because a template that can read a value and not write it is a
 * distinction Rails does not draw here; `helper_attr` exists for a value the
 * view genuinely owns.
 */
export function helperAttr(target: { helperMethods: string[] }, ...names: string[]): string[] {
  return helperMethod(target, ...names.flatMap((name) => [name, `${name}=`]));
}

/**
 * Rails' `modules_for_helpers`.
 *
 * A name is resolved to `<Name>Helper`; a module is taken as it is. An
 * unresolvable name raises rather than being skipped — `helper :nonexistent`
 * silently doing nothing produces a `NoMethodError` in a template, which sends
 * the reader to the template rather than to the line that was wrong.
 */
export function modulesForHelpers(
  names: readonly (string | object)[],
  known: ReadonlyMap<string, unknown>,
): unknown[] {
  return names.map((each) => {
    if (typeof each !== "string") return each;

    const name = each.endsWith("Helper") ? each : `${camelize(each)}Helper`;
    const found = known.get(name);

    if (found === undefined) {
      throw new Error(
        `No helper ${JSON.stringify(name)}. Skipping it would turn this into a NoMethodError in ` +
          `whichever template called the helper, which sends the reader to the template rather ` +
          `than to the declaration that was wrong.`,
      );
    }

    return found;
  });
}

/**
 * Rails' `supports_path?` — whether path helpers exist alongside URL helpers.
 *
 * A mailer says no: a relative path in an email is resolved against whatever
 * client opened it, which is not the application. Off by default for anything
 * that renders outside a request, because the failure is a link that works in
 * every test and is broken in every inbox.
 */
export function supportsViewPaths(renderer: { kind?: string }): boolean {
  return renderer.kind !== "mailer";
}

/**
 * Rails' `compiled_method_container` — where compiled templates are defined.
 *
 * The view context class rather than a global, so two controllers whose
 * templates define a method with the same name do not overwrite each other's.
 * A global container is how a partial rendered from one controller ends up
 * running the body compiled for another's template of the same name.
 */
export function compiledMethodContainer(context: ViewContextClass): ViewContextClass {
  return context;
}
