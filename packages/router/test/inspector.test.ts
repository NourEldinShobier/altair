/**
 * The route table as something to read, ported from
 * `actionpack/test/dispatch/routing/inspector_test.rb`.
 *
 * The three questions a person asks of it: which route answers this path, what
 * is the helper called, and where is the code.
 */

import { describe, expect, it } from "bun:test";
import {
  type InspectedRoute,
  UrlHelperNames,
  actionSourceFileAndLine,
  actionSourceLocation,
  editorUrl,
  endpoint,
  expandedFormatter,
  filterRoutes,
  inspectRoutes,
  noRoutesMessage,
  rackApp,
  reqs,
  routeRow,
  sheetFormatter,
  urlHelpers,
} from "../src/inspector.js";
import { Route } from "../src/route.js";

const entry = (
  method: "GET" | "POST",
  pattern: string,
  controller: string,
  action: string,
  options: { name?: string; constraints?: Record<string, RegExp> } = {},
  extra: Omit<InspectedRoute, "route"> = {},
): InspectedRoute => ({
  route: new Route(method, pattern, controller, action, options),
  ...extra,
});

const posts = entry("GET", "/posts", "posts", "index", { name: "posts" });
const post = entry("GET", "/posts/:id", "posts", "show", { name: "post" });
const comments = entry("GET", "/comments", "comments", "index", { name: "comments" });

describe("what handles a route", () => {
  it("is the controller and action", () => {
    expect(endpoint(posts)).toBe("posts#index");
  });

  /**
   * The three cases read differently and only one is somewhere to go: an engine
   * has its own table, an inline handler has no name, a named app is a class.
   */
  it("is the mounted app when there is one", () => {
    const mounted = entry(
      "GET",
      "/admin",
      "",
      "",
      {},
      { rackApp: { name: "AdminEngine", engine: true } },
    );

    expect(endpoint(mounted)).toBe("AdminEngine");
    expect(rackApp(mounted)?.engine).toBe(true);
  });

  it("says so when the handler has no name", () => {
    const inline = entry("GET", "/up", "", "", {}, { rackApp: {} });

    expect(endpoint(inline)).toBe("Inline handler");
  });

  it("has no rack app for an ordinary route", () => {
    expect(rackApp(posts)).toBeUndefined();
  });
});

describe("the requirements column", () => {
  it("is the endpoint when there is nothing else", () => {
    expect(reqs(posts)).toBe("posts#index");
  });

  /**
   * On the same line as the endpoint, because two routes with one path differ
   * only here and split across columns the difference is easy to read past.
   */
  it("carries the constraints", () => {
    const constrained = entry("GET", "/posts/:id", "posts", "show", {
      constraints: { id: /\d+/ },
    });

    expect(reqs(constrained)).toBe("posts#show {id: \\d+}");
  });
});

describe("where the action is written", () => {
  const locate = (controller: string, action: string) =>
    controller === "posts" && action === "index"
      ? { file: "app/controllers/posts_controller.ts", line: 12 }
      : undefined;

  it("is the file and line", () => {
    expect(actionSourceFileAndLine(posts, locate)).toEqual({
      file: "app/controllers/posts_controller.ts",
      line: 12,
    });
    expect(actionSourceLocation(posts, locate)).toBe("app/controllers/posts_controller.ts:12");
  });

  /** A path pointing at a file that does not contain the code is followed. */
  it("is nothing when the controller cannot be resolved", () => {
    expect(actionSourceFileAndLine(post, locate)).toBeUndefined();
    expect(actionSourceLocation(post, locate)).toBeUndefined();
  });

  it("is nothing for a mounted app", () => {
    const mounted = entry("GET", "/admin", "posts", "index", {}, { rackApp: { name: "Admin" } });

    expect(actionSourceFileAndLine(mounted, locate)).toBeUndefined();
  });

  /** `/:controller/:action` names no controller — it names what the request says. */
  it("is nothing for a dynamic controller or action", () => {
    const anywhere = () => ({ file: "x", line: 1 });

    expect(
      actionSourceFileAndLine(
        entry("GET", "/:controller/:action", ":controller", ":action"),
        anywhere,
      ),
    ).toBeUndefined();
    // Either half is enough: a fixed controller with a dynamic action still
    // names no method to point at.
    expect(
      actionSourceFileAndLine(entry("GET", "/posts/:action", "posts", ":action"), anywhere),
    ).toBeUndefined();
  });
});

describe("a link that opens the file", () => {
  /**
   * Substituted rather than appended: an appended `:12` an editor does not
   * understand opens the file at the top, which looks like it worked.
   */
  it("puts the file and line where the template says", () => {
    expect(editorUrl("vscode://file/%s:%l", { file: "app/a.ts", line: 12 })).toBe(
      "vscode://file/app%2Fa.ts:12",
    );
  });

  it("defaults to the first line", () => {
    expect(editorUrl("edit://%s#%l", { file: "a.ts" })).toBe("edit://a.ts#1");
  });

  /** A template naming the file twice — a label and a target — needs both. */
  it("replaces every placeholder", () => {
    expect(editorUrl("open://%s?title=%s", { file: "a.ts" })).toBe("open://a.ts?title=a.ts");
  });

  it("is nothing without a template", () => {
    expect(editorUrl("", { file: "a.ts" })).toBeUndefined();
  });
});

describe("the helper names a table defines", () => {
  /**
   * Both spellings, because a view calls `postPath` and a mailer calls
   * `postUrl`. Defining one and not the other is how a mail with a relative
   * link gets sent.
   */
  it("is a path and a url for each", () => {
    expect(urlHelpers([posts, post])).toEqual(["postsPath", "postsUrl", "postPath", "postUrl"]);
  });

  it("skips a route with no name", () => {
    expect(urlHelpers([entry("GET", "/up", "health", "show")])).toEqual([]);
  });

  it("names a helper once however many routes share it", () => {
    const names = new UrlHelperNames();
    names.addUrlHelper("post");
    names.addUrlHelper("post");

    expect(names.helperNames()).toEqual(["postPath", "postUrl"]);
    expect(names.has("post")).toBe(true);
  });

  it("camelises a multi-word name", () => {
    const names = new UrlHelperNames();
    names.addUrlHelper("edit_blog_post");

    expect(names.helperNames()).toEqual(["editBlogPostPath", "editBlogPostUrl"]);
  });

  it("can be emptied", () => {
    const names = new UrlHelperNames();
    names.addUrlHelper("post");
    names.clear();

    expect(names.helperNames()).toEqual([]);
  });
});

describe("filtering", () => {
  /** A prefix match answers a question nobody asked. */
  it("matches anywhere in the name, path or endpoint", () => {
    expect(filterRoutes([posts, comments], { grep: "comment" })).toEqual([comments]);
    expect(filterRoutes([posts, comments], { grep: "osts" })).toEqual([posts]);
  });

  it("takes a controller", () => {
    expect(filterRoutes([posts, comments], { controller: "comments" })).toEqual([comments]);
  });

  /** A dozen lines the application never wrote, printed above the ones it did. */
  it("hides the framework's own routes", () => {
    const internal = entry("GET", "/rails/info", "rails/info", "index", {}, { internal: true });

    expect(filterRoutes([posts, internal])).toEqual([posts]);
    expect(filterRoutes([posts, internal], { showInternal: true })).toHaveLength(2);
  });

  it("keeps everything when nothing was asked for", () => {
    expect(filterRoutes([posts, comments])).toHaveLength(2);
  });
});

describe("printing the table", () => {
  it("reduces a route to what is printed", () => {
    const constrained = entry("GET", "/posts/:id", "posts", "show", {
      name: "post",
      constraints: { id: /\d+/ },
    });

    expect(routeRow(constrained)).toEqual({
      name: "post",
      verb: "GET",
      path: "/posts/:id",
      // The constraints, not just the endpoint: they are part of whether this
      // route answers at all.
      reqs: "posts#show {id: \\d+}",
    });
  });

  /**
   * Declaration order, because matching is first-match-wins: the order on
   * screen is the answer, and sorting would print a route above the one that
   * shadows it.
   */
  it("keeps declaration order", () => {
    const lines = inspectRoutes([post, posts]).split("\n");

    expect(lines[1]).toContain("/posts/:id");
    expect(lines[2]).toContain("/posts");
  });

  /**
   * Padded to the widest value: a fixed width either wraps the long paths —
   * the interesting ones — or wastes half the terminal.
   */
  it("aligns the columns to their content", () => {
    const long = entry("POST", "/blogs/:blog_id/posts/:id/comments", "comments", "create", {
      name: "blog_post_comments",
    });
    const lines = inspectRoutes([posts, long]).split("\n");

    expect(lines[0]).toBe(
      "            Prefix Verb URI Pattern                        Controller#Action",
    );
    expect(lines[1]).toBe("             posts GET  /posts                             posts#index");
    expect(lines[2]).toBe(
      "blog_post_comments POST /blogs/:blog_id/posts/:id/comments comments#create",
    );
  });

  /**
   * Never narrower than the header: a column sized only to its values puts
   * "URI Pattern" over the paths of the route below it, offset by a character.
   */
  it("is at least as wide as the heading", () => {
    const lines = inspectRoutes([entry("GET", "/up", "health", "show", { name: "up" })]).split(
      "\n",
    );

    expect(lines[0]).toBe("Prefix Verb URI Pattern Controller#Action");
    expect(lines[1]).toBe("    up GET  /up         health#show");
  });

  it("titles a section", () => {
    expect(sheetFormatter.sectionTitle("Routes for AdminEngine")).toEqual([
      "Routes for AdminEngine:",
    ]);
  });

  it("ends a section with a blank line", () => {
    expect(sheetFormatter.footer([])).toEqual([""]);
  });

  /**
   * One block per route for a narrow terminal: a table narrower than its
   * content wraps mid-column, and the alignment that made it readable is what
   * makes the wrapped version unreadable.
   */
  it("expands one route per block when asked", () => {
    const printed = inspectRoutes([post], expandedFormatter);

    expect(printed).toContain("--[ Route 1 ]");
    expect(printed).toContain("URI               | /posts/:id");
    expect(printed).not.toContain("Prefix Verb");
  });

  it("has no header in the expanded form", () => {
    expect(expandedFormatter.header([])).toEqual([]);
  });
});

describe("when nothing matched", () => {
  /**
   * "No routes at all" and "your filter matched nothing" send the reader to
   * different places, and one message for both sends half of them wrong.
   */
  it("says which of the three it was", () => {
    expect(noRoutesMessage({ controller: "posts" })).toContain("for this controller");
    expect(noRoutesMessage({ grep: "x" })).toContain("grep pattern");
    expect(noRoutesMessage()).toContain("any routes defined");
  });

  it("is what the listing prints", () => {
    expect(inspectRoutes([posts], sheetFormatter, { grep: "nothing" })).toContain("grep pattern");
    expect(inspectRoutes([])).toContain("any routes defined");
  });
});
