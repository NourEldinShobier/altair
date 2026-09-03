/**
 * The view's block-scoped settings, held to the work that opened them.
 *
 * The same shape as the ORM's, found the same way: a module-level variable set
 * on the way into a block and restored in a `finally`. Each of these comments
 * worried about the body *throwing* and left it there, which is the failure a
 * single thread can have. The one it cannot have is the block covering
 * whatever else is running while it runs.
 */

import { describe, expect, it } from "bun:test";
import {
  clearCache,
  dependencyDigest,
  digestCache,
  registerTemplateSource,
  withEmptyTemplateCache,
} from "../src/digestor.js";
import {
  viewPaths,
  LookupContext,
  setViewPaths,
  TemplateResolver,
  withViewPaths,
} from "../src/lookup_context.js";
import type { RegisteredTemplate } from "../src/lookup_context.js";
import { inRenderingContext, renderCalls, renderedViews, renderTemplate } from "../src/renderer.js";
import { raw } from "../src/render.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

const app = new TemplateResolver("app");
const plugin = new TemplateResolver("plugin");
const outer = new TemplateResolver("outer");
const inner = new TemplateResolver("inner");

/** The names of the paths in force, which is what a lookup would search. */
function names(): string[] {
  return viewPaths().map((each) => each.name);
}

describe("rendering from other view paths", () => {
  /**
   * A swap made one request's paths every concurrent request's paths for as
   * long as the block ran, so a render inside a plugin's paths could hand a
   * request beside it the plugin's template instead of the application's.
   */
  it("does not reach work running beside it", async () => {
    setViewPaths([app]);

    let seen: string[] | undefined;

    await Promise.all([
      withViewPaths([plugin], async () => {
        await tick();
        await tick();
      }),
      (async () => {
        await tick();
        seen = names();
      })(),
    ]);

    expect(seen).toEqual(["app"]);
    setViewPaths([]);
  });

  it("still reaches work running inside it", async () => {
    setViewPaths([app]);

    let seen: string[] | undefined;

    await withViewPaths([plugin], async () => {
      await tick();
      seen = names();
    });

    expect(seen).toEqual(["plugin"]);
    setViewPaths([]);
  });

  it("puts them back when the block ends", async () => {
    setViewPaths([app]);

    await withViewPaths([plugin], async () => tick());

    expect(names()).toEqual(["app"]);
    setViewPaths([]);
  });

  it("puts them back even when the block throws", async () => {
    setViewPaths([app]);

    await expect(
      withViewPaths([plugin], () => {
        throw new Error("from the body");
      }),
    ).rejects.toThrow("from the body");

    expect(names()).toEqual(["app"]);
    setViewPaths([]);
  });

  it("nests", async () => {
    setViewPaths([app]);

    await withViewPaths([outer], async () => {
      await withViewPaths([inner], async () => {
        expect(names()).toEqual(["inner"]);
      });

      expect(names()).toEqual(["outer"]);
    });

    setViewPaths([]);
  });
});

describe("running with nothing remembered", () => {
  it("remembers nothing inside the block", () => {
    clearCache();
    registerTemplateSource("page", "page");
    dependencyDigest("page");

    withEmptyTemplateCache(() => {
      expect(digestCache().size).toBe(0);
    });

    expect(digestCache().has("page")).toBe(true);
  });

  /**
   * Clearing and refilling the shared map made every concurrent render miss
   * the cache for the length of the block, and threw away whatever those
   * renders computed in the meantime.
   */
  it("does not empty the cache for work running beside it", async () => {
    clearCache();
    registerTemplateSource("page", "page");
    dependencyDigest("page");

    let seen: number | undefined;

    await Promise.all([
      (async () => {
        withEmptyTemplateCache(() => {
          expect(digestCache().size).toBe(0);
        });
        await tick();
      })(),
      (async () => {
        seen = digestCache().size;
        await tick();
      })(),
    ]);

    expect(seen).toBe(1);
  });

  /**
   * The promise is that nothing is remembered, which is a claim about reads
   * as much as writes. Reading through to the shared cache would hand the
   * block a digest computed before the source changed — which is the one
   * thing `with_empty_template_cache` exists to prevent.
   */
  it("does not read a digest the shared cache remembers", () => {
    clearCache();
    registerTemplateSource("page", "first");
    const first = dependencyDigest("page");

    registerTemplateSource("page", "second");

    withEmptyTemplateCache(() => {
      expect(dependencyDigest("page")).not.toBe(first);
    });
  });

  it("keeps what the block computed out of the shared cache", () => {
    clearCache();
    registerTemplateSource("page", "page");

    withEmptyTemplateCache(() => {
      dependencyDigest("page");
    });

    expect(digestCache().has("page")).toBe(false);
  });

  it("leaves the cache alone when the block throws", () => {
    clearCache();
    registerTemplateSource("page", "page");
    dependencyDigest("page");

    expect(() =>
      withEmptyTemplateCache(() => {
        throw new Error("from the body");
      }),
    ).toThrow("from the body");

    expect(digestCache().has("page")).toBe(true);
  });
});

describe("collecting what a block rendered", () => {
  const named = (name: string, prefix: string): RegisteredTemplate => ({
    name,
    prefix,
    component: () => raw(`<${name}>`),
  });

  function renderable(...paths: readonly string[]): void {
    const resolver = new TemplateResolver();

    for (const path of paths) {
      const cut = path.lastIndexOf("/");

      resolver.add(named(path.slice(cut + 1), path.slice(0, Math.max(cut, 0))));
    }

    setViewPaths([resolver]);
  }

  const render = async (path: string) => renderTemplate(new LookupContext(), path);

  it("collects its own renders", async () => {
    renderable("posts/index", "posts/_post");

    const { rendered } = await inRenderingContext(async () => {
      await render("posts/index");
      await tick();
      await render("posts/_post");
    });

    expect(rendered.map((each) => each.path)).toEqual(["posts/index", "posts/_post"]);
  });

  /**
   * A shared list collected every concurrent render and handed them back as
   * what this block rendered — one request's report naming another's
   * templates.
   */
  it("does not collect what rendered beside it", async () => {
    renderable("mine", "theirs");

    const [mine] = await Promise.all([
      inRenderingContext(async () => {
        await render("mine");
        await tick();
        await tick();
      }),
      (async () => {
        await tick();
        await render("theirs");
      })(),
    ]);

    expect(mine.rendered.map((each) => each.path)).toEqual(["mine"]);
  });

  it("keeps two blocks apart", async () => {
    renderable("first", "second");

    const [first, second] = await Promise.all([
      inRenderingContext(async () => {
        await render("first");
        await tick();
      }),
      inRenderingContext(async () => {
        await render("second");
        await tick();
      }),
    ]);

    expect(first.rendered.map((each) => each.path)).toEqual(["first"]);
    expect(second.rendered.map((each) => each.path)).toEqual(["second"]);
  });

  /** The honest answer: the list belongs to a block, so there is none here. */
  it("reports nothing outside a block", () => {
    expect(renderedViews()).toEqual([]);
    expect(renderCalls()).toEqual([]);
  });

  it("reports the same renders through both readers", async () => {
    renderable("posts/index");

    await inRenderingContext(async () => {
      await render("posts/index");

      expect(renderedViews()).toEqual(["posts/index"]);
      expect(renderCalls()).toHaveLength(1);
    });
  });

  it("stops recording when the block throws", async () => {
    renderable("posts/index");

    await expect(
      inRenderingContext(async () => {
        await render("posts/index");
        throw new Error("from the body");
      }),
    ).rejects.toThrow("from the body");

    expect(renderedViews()).toEqual([]);
  });
});
