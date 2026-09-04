/**
 * What a template can see, ported from
 * `actionview/test/template/render_test.rb`,
 * `actionpack/test/controller/helper_test.rb` and the view-context cases in
 * `actionview/test/actionpack/controller/view_paths_test.rb`.
 *
 * The cases that matter are the exclusions: what does *not* cross into a
 * template, and what a helper declaration does not expose.
 */

import { describe, expect, it } from "bun:test";
import {
  PROTECTED_INSTANCE_VARIABLES,
  assignController,
  buildViewContextClass,
  compiledMethodContainer,
  controllerPath,
  determineDefaultHelperClass,
  helperAttr,
  helperClass,
  helperMethod,
  inheritViewContextClass,
  modulesForHelpers,
  resetViewContextClass,
  supportsViewPaths,
  viewAssigns,
  viewContext,
  viewContextClass,
  viewRenderer,
  viewRendered,
} from "../src/view-context.js";

describe("what crosses into a template", () => {
  it("takes the controller's own state", () => {
    expect(viewAssigns({ post: { id: 1 }, count: 3 })).toEqual({ post: { id: 1 }, count: 3 });
  });

  /**
   * A template that could reach the response object would let a partial
   * rewrite the headers of the request rendering it.
   */
  it("leaves the framework's bookkeeping behind", () => {
    const assigns = viewAssigns({ post: 1, request: {}, response: {}, lookupContext: {} });

    expect(assigns).toEqual({ post: 1 });
  });

  it("excludes a name marked private", () => {
    expect(viewAssigns({ post: 1, _internal: 2 })).toEqual({ post: 1 });
  });

  it("excludes methods", () => {
    expect(viewAssigns({ post: 1, save: () => undefined })).toEqual({ post: 1 });
  });

  it("takes a different exclusion list", () => {
    expect(viewAssigns({ post: 1, request: {} }, ["post"])).toEqual({ request: {} });
  });

  it("names the response among the excluded", () => {
    expect(PROTECTED_INSTANCE_VARIABLES).toContain("response");
    expect(PROTECTED_INSTANCE_VARIABLES).toContain("request");
  });

  /** A context reusing the controller's object would let a render write back into it. */
  it("copies rather than shares", () => {
    const assigns = { post: 1 };
    const context = viewContext(buildViewContextClass(null, spec()), null, assigns, null);

    context.assigns["post"] = 2;

    expect(assigns["post"]).toBe(1);
  });
});

function spec(
  overrides: Partial<{ supportsPath: boolean; routes: unknown; helpers: unknown }> = {},
) {
  return { supportsPath: true, routes: null, helpers: null, ...overrides };
}

describe("the class a controller's templates get", () => {
  it("carries what it was built from", () => {
    const routes = {};
    const built = buildViewContextClass("Base", spec({ routes }));

    expect(built.routes).toBe(routes);
    expect(built.supportsPath).toBe(true);
  });

  /**
   * Shared, one controller declaring a helper method would declare it on every
   * other class built from the same list.
   */
  it("copies the helper method list", () => {
    const declared = ["currentUser"];
    const built = buildViewContextClass("Base", spec(), declared);

    helperMethod(built, "theme");

    expect(declared).toEqual(["currentUser"]);
    expect(built.helperMethods).toEqual(["currentUser", "theme"]);
  });

  it("is built once and kept", () => {
    const controller = class {};
    const first = viewContextClass(controller, "Base", spec());

    expect(viewContextClass(controller, "Base", spec())).toBe(first);

    resetViewContextClass(controller);

    expect(viewContextClass(controller, "Base", spec())).not.toBe(first);
  });

  /**
   * An application with two hundred controllers would otherwise compose two
   * hundred near-identical classes.
   */
  it("is shared with a parent whose would be identical", () => {
    const routes = {};
    const helpers = {};
    const parent = class {};
    const child = class {};

    const parentClass = viewContextClass(parent, "Base", spec({ routes, helpers }));
    const childClass = viewContextClass(child, "Base", spec({ routes, helpers }), {
      class: parent,
      spec: spec({ routes, helpers }),
    });

    expect(childClass).toBe(parentClass);
  });

  it("is its own when the helpers differ", () => {
    const routes = {};
    const parent = class {};
    const child = class {};

    const parentClass = viewContextClass(parent, "Base", spec({ routes, helpers: {} }));
    const childClass = viewContextClass(child, "Base", spec({ routes, helpers: {} }), {
      class: parent,
      spec: spec({ routes, helpers: {} }),
    });

    expect(childClass).not.toBe(parentClass);
  });

  /**
   * Identity rather than equality: two route sets with the same routes are
   * still two objects, and comparing by value would keep a class built from a
   * set that has since been reloaded.
   */
  it("compares routes by identity", () => {
    expect(inheritViewContextClass(spec({ routes: {} }), spec({ routes: {} }))).toBe(false);

    const routes = {};

    expect(inheritViewContextClass(spec({ routes }), spec({ routes }))).toBe(true);
  });

  it("does not inherit from nothing", () => {
    expect(inheritViewContextClass(spec(), undefined)).toBe(false);
  });

  it("does not inherit when path support differs", () => {
    expect(
      inheritViewContextClass(spec({ supportsPath: true }), spec({ supportsPath: false })),
    ).toBe(false);
  });
});

describe("a render", () => {
  /** A context reused across two renders would let the second see the first's assigns. */
  it("gets its own context", () => {
    const contextClass = buildViewContextClass("Base", spec());
    const first = viewContext(contextClass, null, { a: 1 }, null);
    const second = viewContext(contextClass, null, {}, null);

    expect(second.assigns).toEqual({});
    expect(first.assigns).toEqual({ a: 1 });
  });

  /**
   * The renderer holds the compiled-template cache, so a fresh one per render
   * would recompile every partial in a collection of a thousand items a
   * thousand times.
   */
  it("shares one renderer", () => {
    const lookup = {};

    expect(viewRenderer(lookup).lookupContext).toBe(lookup);
    expect(viewRenderer(lookup).renders).toBe(0);
  });

  it("records what rendered", () => {
    const context = viewContext(buildViewContextClass("Base", spec()), null, {}, null);

    viewRendered(context, "posts/index");
    viewRendered(context, "posts/_post");

    expect(context.rendered).toEqual(["posts/index", "posts/_post"]);
  });

  /** A view test builds the context first and the controller second. */
  it("takes its controller afterwards", () => {
    const context = viewContext(buildViewContextClass("Base", spec()), null, {}, null);
    const controller = {};

    assignController(context, controller);

    expect(context.controller).toBe(controller);
  });

  /**
   * A global container is how a partial rendered from one controller ends up
   * running the body compiled for another's template of the same name.
   */
  it("compiles templates into the context class, not a global", () => {
    const first = buildViewContextClass("Base", spec());
    const second = buildViewContextClass("Base", spec());

    expect(compiledMethodContainer(first)).toBe(first);
    expect(compiledMethodContainer(first)).not.toBe(compiledMethodContainer(second));
  });
});

describe("where a controller's templates live", () => {
  it("underscores and nests", () => {
    expect(controllerPath("PostsController")).toBe("posts");
    expect(controllerPath("Admin::PostsController")).toBe("admin/posts");
    expect(controllerPath("BlogPostsController")).toBe("blog_posts");
  });

  /**
   * Exactly the suffix and nothing else: stripping "Controller" anywhere would
   * send a controller whose name merely contains it to a directory nothing put
   * templates in.
   */
  it("strips only the suffix", () => {
    expect(controllerPath("ControllerHelperController")).toBe("controller_helper");
  });

  it("leaves a name without the suffix alone", () => {
    expect(controllerPath("Posts")).toBe("posts");
  });
});

describe("helpers", () => {
  const known = new Map<string, unknown>([
    ["PostsHelper", { name: "posts" }],
    ["AdminHelper", { name: "admin" }],
  ]);

  it("finds the matching helper", () => {
    expect(determineDefaultHelperClass("PostsController", known)).toEqual({ name: "posts" });
    expect(helperClass("PostsController", known)).toEqual({ name: "posts" });
  });

  /** A controller with no helper file is the normal case, not an error. */
  it("finds nothing rather than raising when there is none", () => {
    expect(determineDefaultHelperClass("CommentsController", known)).toBeUndefined();
  });

  it("resolves a name to a module", () => {
    expect(modulesForHelpers(["posts"], known)).toEqual([{ name: "posts" }]);
    expect(modulesForHelpers(["PostsHelper"], known)).toEqual([{ name: "posts" }]);
  });

  it("takes a module as it is", () => {
    const module = {};

    expect(modulesForHelpers([module], known)).toEqual([module]);
  });

  /**
   * Skipping it would turn this into a NoMethodError in whichever template
   * called the helper, which sends the reader to the template rather than to
   * the declaration that was wrong.
   */
  it("refuses a name nothing answers", () => {
    expect(() => modulesForHelpers(["missing"], known)).toThrow("MissingHelper");
  });

  /**
   * Named methods rather than the controller itself: a template holding the
   * controller can call anything on it, including the actions.
   */
  it("exposes named methods", () => {
    const target = { helperMethods: [] as string[] };

    expect(helperMethod(target, "currentUser")).toEqual(["currentUser"]);
  });

  it("does not list one twice", () => {
    const target = { helperMethods: ["currentUser"] };

    helperMethod(target, "currentUser");

    expect(target.helperMethods).toEqual(["currentUser"]);
  });

  it("exposes the reader and the writer for an attribute", () => {
    const target = { helperMethods: [] as string[] };

    expect(helperAttr(target, "theme")).toEqual(["theme", "theme="]);
  });
});

describe("path helpers", () => {
  /**
   * A relative path in an email is resolved against whatever client opened it,
   * which is not the application — a link that works in every test and is
   * broken in every inbox.
   */
  it("are off for a mailer", () => {
    expect(supportsViewPaths({ kind: "mailer" })).toBe(false);
    expect(supportsViewPaths({ kind: "controller" })).toBe(true);
    expect(supportsViewPaths({})).toBe(true);
  });
});
