/**
 * Rendering a template found by lookup, ported from
 * `actionview/test/template/render_test.rb`,
 * `actionview/test/template/streaming_render_test.rb` and the strict-locals
 * cases in `actionview/test/template/template_test.rb`.
 *
 * Two things carry the weight: deriving a partial from a record, which is what
 * makes a mixed collection render at all and also the place a record could
 * choose its own template; and strict locals, which turn a silently missing
 * field into an error at the call site.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  LookupContext,
  MissingTemplate,
  type RegisteredTemplate,
  TemplateResolver,
  setViewPaths,
} from "../src/lookup-context.js";
import { raw } from "../src/render.js";
import {
  MissingLocal,
  UnexpectedLocal,
  bindLocals,
  clearStrictLocals,
  clearTemplateHandlers,
  convertToModel,
  declaredLocals,
  derivePartialPath,
  handlerExtensions,
  handlerForExtension,
  inRenderingContext,
  localsFor,
  modelNameFromRecordOrClass,
  registerDefault,
  registerTemplateHandler,
  renderBody,
  renderCalls,
  renderCollectionDerivePartial,
  renderCollectionWithPartial,
  renderLayout,
  renderObjectDerivePartial,
  renderObjectWithPartial,
  renderTemplate,
  renderToObject,
  renderedViews,
  strictLocals,
  subTemplateOf,
  unregisterTemplateHandler,
} from "../src/renderer.js";

class Post {
  constructor(readonly title: string) {}
}

class Photo {
  constructor(readonly caption: string) {}
}

const template = (
  prefix: string,
  name: string,
  render: (locals: Record<string, unknown>) => string,
): RegisteredTemplate => ({
  prefix,
  name,
  component: (locals) => raw(render(locals as Record<string, unknown>)),
});

const withTemplates = (...templates: RegisteredTemplate[]) => {
  const resolver = new TemplateResolver();

  for (const each of templates) resolver.add(each);

  setViewPaths([resolver]);

  return new LookupContext();
};

afterEach(() => {
  setViewPaths([]);
  clearStrictLocals();
  clearTemplateHandlers();
});

describe("working out which partial renders a record", () => {
  it("asks the record", () => {
    expect(derivePartialPath({ toPartialPath: () => "posts/post" })).toBe("posts/post");
  });

  it("falls back to the class name", () => {
    expect(derivePartialPath(new Post("x"))).toBe("posts/post");
  });

  it("splits a compound class name", () => {
    class BlogPost {}

    expect(derivePartialPath(new BlogPost())).toBe("blog_posts/blog_post");
  });

  /** Guessing from the data would let a row choose which component renders it. */
  it("refuses a plain object", () => {
    expect(() => derivePartialPath({ type: "AdminPanel" })).toThrow(TypeError);
  });

  it("says what to do instead", () => {
    expect(() => derivePartialPath({})).toThrow("toPartialPath");
  });

  it("refuses nothing at all", () => {
    expect(() => derivePartialPath(null)).toThrow(TypeError);
  });

  it("unwraps something presenting a model", () => {
    const model = new Post("x");

    expect(convertToModel({ toModel: () => model })).toBe(model);
  });

  it("leaves a plain value alone", () => {
    expect(convertToModel(7)).toBe(7);
  });

  it("names the model behind a value", () => {
    expect(modelNameFromRecordOrClass(new Post("x"))).toBe("Post");
    expect(modelNameFromRecordOrClass({ toModel: () => new Photo("x") })).toBe("Photo");
  });
});

describe("locals a partial declares", () => {
  it("passes anything through when nothing is declared", () => {
    expect(bindLocals("posts/post", { post: 1, extra: 2 })).toEqual({ post: 1, extra: 2 });
  });

  /**
   * Without this the value is `undefined`, the markup renders, and the field is
   * just missing from the page.
   */
  it("refuses a missing required local", () => {
    strictLocals("posts/post", { required: ["post"] });

    expect(() => bindLocals("posts/post", {})).toThrow(MissingLocal);
  });

  it("names what was missing", () => {
    strictLocals("posts/post", { required: ["post", "author"] });

    expect(() => bindLocals("posts/post", { post: 1 })).toThrow("author");
  });

  /** Almost always a rename applied to the caller and not the partial. */
  it("refuses one it does not declare", () => {
    strictLocals("posts/post", { required: ["post"] });

    expect(() => bindLocals("posts/post", { post: 1, athor: 2 })).toThrow(UnexpectedLocal);
  });

  it("allows a declared optional one", () => {
    strictLocals("posts/post", { required: ["post"], optional: ["highlight"] });

    expect(bindLocals("posts/post", { post: 1, highlight: true })).toEqual({
      post: 1,
      highlight: true,
    });
  });

  it("does not require an optional one", () => {
    strictLocals("posts/post", { required: ["post"], optional: ["highlight"] });

    expect(bindLocals("posts/post", { post: 1 })).toEqual({ post: 1 });
  });

  it("reports what a partial declares", () => {
    strictLocals("posts/post", { required: ["post"] });

    expect(declaredLocals("posts/post")?.required).toEqual(["post"]);
    expect(declaredLocals("posts/other")).toBeUndefined();
  });
});

describe("the locals a collection item gets", () => {
  it("names the item after the partial", () => {
    expect(localsFor("posts/post", "x", 0, 3)["post"]).toBe("x");
  });

  it("takes a different name", () => {
    expect(localsFor("posts/post", "x", 0, 3, "entry")["entry"]).toBe("x");
  });

  /** A partial that needed the index otherwise has to be rendered by hand. */
  it("carries the counter", () => {
    expect(localsFor("posts/post", "x", 2, 3)["postCounter"]).toBe(2);
  });

  it("says where in the collection it is", () => {
    expect(localsFor("posts/post", "x", 0, 3)["postIteration"]).toEqual({
      index: 0,
      size: 3,
      first: true,
      last: false,
    });
    expect(localsFor("posts/post", "x", 2, 3)["postIteration"]).toMatchObject({ last: true });
  });
});

describe("template handlers", () => {
  it("finds one by extension", () => {
    const handler = () => raw("");
    registerTemplateHandler("erb", handler);

    expect(handlerForExtension("erb")).toBe(handler);
    expect(handlerForExtension(".ERB")).toBe(handler);
  });

  it("finds none for an unregistered one", () => {
    expect(handlerForExtension("erb")).toBeUndefined();
  });

  it("uses the default when no extension is given", () => {
    const handler = () => raw("");
    registerTemplateHandler("erb", handler);
    registerDefault("erb");

    expect(handlerForExtension(undefined)).toBe(handler);
  });

  it("lists what is registered", () => {
    registerTemplateHandler("erb", () => raw(""));
    registerTemplateHandler("builder", () => raw(""));

    expect(handlerExtensions()).toEqual(["builder", "erb"]);
  });

  it("has no default once its handler is removed", () => {
    registerTemplateHandler("erb", () => raw(""));
    registerDefault("erb");

    unregisterTemplateHandler("erb");

    expect(handlerForExtension(undefined)).toBeUndefined();
  });

  /**
   * The lookup already misses; what the clear buys is the way back.
   * Re-registering that extension must not silently make it the default again,
   * which would let an unrelated registration change how every extensionless
   * template renders.
   */
  it("does not restore the default when the extension comes back", () => {
    registerTemplateHandler("erb", () => raw(""));
    registerDefault("erb");
    unregisterTemplateHandler("erb");

    registerTemplateHandler("erb", () => raw("different"));

    expect(handlerForExtension(undefined)).toBeUndefined();
  });

  it("leaves another default alone", () => {
    registerTemplateHandler("erb", () => raw(""));
    const other = () => raw("");
    registerTemplateHandler("builder", other);
    registerDefault("builder");

    unregisterTemplateHandler("erb");

    expect(handlerForExtension(undefined)).toBe(other);
  });
});

describe("rendering", () => {
  it("renders a template", async () => {
    const context = withTemplates(
      template("posts", "show", (locals) => `<h1>${String(locals["title"])}</h1>`),
    );

    expect((await renderTemplate(context, "posts/show", { title: "Hi" })).value).toBe(
      "<h1>Hi</h1>",
    );
  });

  it("refuses one that does not exist", async () => {
    const context = withTemplates();

    await expect(renderTemplate(context, "posts/show")).rejects.toThrow(MissingTemplate);
  });

  it("checks strict locals on the way in", async () => {
    const context = withTemplates(template("posts", "show", () => "x"));
    strictLocals("posts/show", { required: ["title"] });

    await expect(renderTemplate(context, "posts/show", {})).rejects.toThrow(MissingLocal);
  });

  it("renders an object under the partial's name", async () => {
    const context = withTemplates(
      template("posts", "post", (locals) => `<li>${(locals["post"] as Post).title}</li>`),
    );

    expect((await renderObjectWithPartial(context, "posts/post", new Post("Hi"))).value).toBe(
      "<li>Hi</li>",
    );
  });

  it("takes a different name for it", async () => {
    const context = withTemplates(
      template("posts", "post", (locals) => `<li>${(locals["entry"] as Post).title}</li>`),
    );

    expect(
      (await renderObjectWithPartial(context, "posts/post", new Post("Hi"), {}, "entry")).value,
    ).toBe("<li>Hi</li>");
  });

  it("derives the partial from the object", async () => {
    const context = withTemplates(
      template("posts", "post", (locals) => `<li>${(locals["post"] as Post).title}</li>`),
    );

    expect((await renderObjectDerivePartial(context, new Post("Hi"))).value).toBe("<li>Hi</li>");
  });

  it("renders a collection", async () => {
    const context = withTemplates(
      template("posts", "post", (locals) => `<li>${(locals["post"] as Post).title}</li>`),
    );

    expect(
      (await renderCollectionWithPartial(context, "posts/post", [new Post("a"), new Post("b")]))
        .value,
    ).toBe("<li>a</li><li>b</li>");
  });

  it("gives each item its counter", async () => {
    const context = withTemplates(
      template("posts", "post", (locals) => `<li>${String(locals["postCounter"])}</li>`),
    );

    expect(
      (await renderCollectionWithPartial(context, "posts/post", [new Post("a"), new Post("b")]))
        .value,
    ).toBe("<li>0</li><li>1</li>");
  });

  it("passes the caller's locals to every item", async () => {
    const context = withTemplates(
      template("posts", "post", (locals) => `<li>${String(locals["prefix"])}</li>`),
    );

    expect(
      (await renderCollectionWithPartial(context, "posts/post", [new Post("a")], { prefix: "P" }))
        .value,
    ).toBe("<li>P</li>");
  });

  /**
   * An empty list is the normal state of a new account, so it must not raise
   * because the partial happens not to exist.
   */
  it("renders an empty collection as nothing", async () => {
    const context = withTemplates();

    expect((await renderCollectionWithPartial(context, "posts/post", [])).value).toBe("");
    expect((await renderCollectionDerivePartial(context, [])).value).toBe("");
  });

  /** What makes a mixed collection render without the caller branching. */
  it("renders each item with its own partial", async () => {
    const context = withTemplates(
      template("posts", "post", (locals) => `<li>${(locals["post"] as Post).title}</li>`),
      template("photos", "photo", (locals) => `<img>${(locals["photo"] as Photo).caption}</img>`),
    );

    expect(
      (await renderCollectionDerivePartial(context, [new Post("a"), new Photo("b")])).value,
    ).toBe("<li>a</li><img>b</img>");
  });

  it("renders without a layout", async () => {
    const context = withTemplates(template("posts", "show", () => "<p>body</p>"));

    expect((await renderBody(context, "posts/show")).value).toBe("<p>body</p>");
  });

  it("hands back a plain string when asked", async () => {
    const context = withTemplates(template("posts", "show", () => "<p>body</p>"));

    expect(await renderToObject(context, "posts/show")).toBe("<p>body</p>");
  });

  /**
   * The body is rendered first and handed in. Rendered lazily it would run
   * after the layout's head was emitted, and a title the body wanted to set
   * would arrive too late.
   */
  it("wraps a rendered body in a layout", async () => {
    const context = withTemplates(
      template("layouts", "application", (locals) => `<main>${String(locals["content"])}</main>`),
    );

    const html = await renderLayout(context, "layouts/application", raw("<p>body</p>"));

    expect(html.value).toBe("<main><p>body</p></main>");
  });

  /**
   * A body that is not already markup has to go through rendering, not
   * `String()`. Handed straight to the layout, a plain string is interpolated
   * unescaped — so a body carrying user text injects markup into the page.
   */
  it("renders a body that is not already markup", async () => {
    const context = withTemplates(
      template("layouts", "application", (locals) => `<main>${String(locals["content"])}</main>`),
    );

    const html = await renderLayout(context, "layouts/application", "a & b <script>");

    expect(html.value).toBe("<main>a &amp; b &lt;script&gt;</main>");
  });

  it("names the chain a template came from", () => {
    const post = template("posts", "post", () => "");

    expect(subTemplateOf(post)).toBe("posts/post");
    expect(subTemplateOf(post, "posts/index")).toBe("posts/index > posts/post");
  });
});

describe("recording what was rendered", () => {
  it("records nothing outside a context", async () => {
    const context = withTemplates(template("posts", "show", () => "x"));
    await renderTemplate(context, "posts/show");

    expect(renderedViews()).toEqual([]);
  });

  it("records what a block rendered", async () => {
    const context = withTemplates(
      template("posts", "show", () => "x"),
      template("posts", "post", () => "y"),
    );

    const { rendered } = await inRenderingContext(async () => {
      await renderTemplate(context, "posts/show");
      await renderTemplate(context, "posts/post");
    });

    expect(rendered.map((each) => each.path)).toEqual(["posts/show", "posts/post"]);
  });

  it("records the locals too", async () => {
    const context = withTemplates(template("posts", "show", () => "x"));

    const { rendered } = await inRenderingContext(async () => {
      await renderTemplate(context, "posts/show", { title: "Hi" });
    });

    expect(rendered[0]?.locals).toEqual({ title: "Hi" });
    expect(renderCalls()).toEqual([]);
  });

  /**
   * Restored in a `finally`, or a throwing body leaves recording on and every
   * later render accumulates for the rest of the process.
   */
  it("stops recording when the block throws", async () => {
    const context = withTemplates(template("posts", "show", () => "x"));

    await expect(
      inRenderingContext(async () => {
        await renderTemplate(context, "posts/show");

        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await renderTemplate(context, "posts/show");

    expect(renderedViews()).toEqual([]);
  });
});
