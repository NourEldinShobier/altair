/**
 * Finding the right template for a request, ported from
 * `actionview/test/template/lookup_context_test.rb` and
 * `actionview/test/template/resolver_shared_tests.rb`.
 *
 * Two things carry the weight: the order details are preferred in, and the
 * cache key. Both fail invisibly when wrong — a lookup that ignores what the
 * client asked for still returns *a* template, and a cache key missing a detail
 * only misbehaves on the second request.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  DETAIL_NAMES,
  InvalidFormat,
  LookupContext,
  MissingTemplate,
  type RegisteredTemplate,
  TemplateResolver,
  allResolvers,
  anyFormats,
  appendViewPaths,
  clearResolverCaches,
  detailsCacheKey,
  detailsKey,
  detailsKeys,
  viewPaths,
  normalizedFormats,
  prependViewPaths,
  registerDetail,
  registeredDetails,
  setViewPaths,
  shortIdentifier,
  sortByPreference,
  splitTemplatePath,
  templatePath,
  validateFormats,
  withViewPaths,
} from "../src/lookup_context.js";
import { raw } from "../src/render.js";

const template = (name: string, details: Partial<RegisteredTemplate> = {}): RegisteredTemplate => ({
  name,
  component: () => raw(`<${name}>`),
  ...details,
});

const resolverWith = (...templates: RegisteredTemplate[]) => {
  const resolver = new TemplateResolver();

  for (const each of templates) resolver.add(each);

  return resolver;
};

afterEach(() => {
  setViewPaths([]);
});

describe("template paths", () => {
  it("joins a prefix to a name", () => {
    expect(templatePath({ name: "post", prefix: "posts" })).toBe("posts/post");
  });

  it("leaves a bare name alone", () => {
    expect(templatePath({ name: "index" })).toBe("index");
  });

  it("splits one back apart", () => {
    expect(splitTemplatePath("posts/post")).toEqual({ prefix: "posts", name: "post" });
    expect(splitTemplatePath("index")).toEqual({ name: "index" });
  });

  it("takes the last slash, so a nested prefix survives", () => {
    expect(splitTemplatePath("admin/posts/post")).toEqual({
      prefix: "admin/posts",
      name: "post",
    });
  });

  it("names a template for an error message", () => {
    expect(shortIdentifier(template("post", { prefix: "posts" }))).toBe("posts/post");
    expect(shortIdentifier(template("post", { identifier: "app/views/posts/_post" }))).toBe(
      "app/views/posts/_post",
    );
  });
});

describe("view paths", () => {
  it("starts with none", () => {
    expect(viewPaths()).toEqual([]);
  });

  it("appends one", () => {
    const resolver = resolverWith(template("post"));
    appendViewPaths(resolver);

    expect(allResolvers()).toEqual([resolver]);
  });

  /** Searched first, which is how adding a file overrides an engine's view. */
  it("puts a prepended one first", () => {
    const first = resolverWith(template("post"));
    const second = resolverWith(template("post"));
    appendViewPaths(second);
    prependViewPaths(first);

    expect(viewPaths()).toEqual([first, second]);
  });

  it("swaps them for a block", async () => {
    const original = resolverWith(template("post"));
    setViewPaths([original]);
    const other = resolverWith(template("post"));

    const seen = await withViewPaths([other], () => viewPaths());

    expect(seen).toEqual([other]);
    expect(viewPaths()).toEqual([original]);
  });

  /**
   * A body that throws would otherwise leave the process rendering from
   * whatever paths that one test installed.
   */
  it("puts them back when the block throws", async () => {
    const original = resolverWith(template("post"));
    setViewPaths([original]);

    await expect(
      withViewPaths([], () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(viewPaths()).toEqual([original]);
  });

  it("lists what a resolver holds", () => {
    const resolver = resolverWith(template("post", { prefix: "posts" }), template("index"));

    expect(resolver.allTemplatePaths()).toEqual(["posts/post", "index"]);
  });
});

describe("preferring one template over another", () => {
  const plain = template("post");
  const html = template("post", { format: "html" });
  const json = template("post", { format: "json" });
  const phone = template("post", { format: "html", variant: "phone" });

  it("takes the format the request asked for", () => {
    expect(sortByPreference([json, html], { formats: ["html"] })[0]).toBe(html);
  });

  /**
   * A `json` component must never be returned for an HTML request just because
   * nothing better existed.
   */
  it("drops a format the request did not ask for", () => {
    expect(sortByPreference([json], { formats: ["html"] })).toEqual([]);
  });

  /** Declaring nothing fits anything, but only after one that declares right. */
  it("prefers a declared format over an agnostic one", () => {
    expect(sortByPreference([plain, html], { formats: ["html"] })[0]).toBe(html);
  });

  it("still uses the agnostic one when nothing declares the format", () => {
    expect(sortByPreference([plain], { formats: ["json"] })[0]).toBe(plain);
  });

  /**
   * `[text, html]` from an Accept header means the client prefers text.
   * Sorting by "most specific match" would ignore that.
   */
  it("follows the order the request gave", () => {
    const text = template("post", { format: "text" });

    expect(sortByPreference([html, text], { formats: ["text", "html"] })[0]).toBe(text);
  });

  it("prefers the running variant", () => {
    expect(sortByPreference([html, phone], { formats: ["html"], variants: ["phone"] })[0]).toBe(
      phone,
    );
  });

  /**
   * Format outranks variant. Both candidates have to be acceptable for this to
   * test anything: `phone` here is HTML and `json` is JSON, the request accepts
   * both, and only the phone one matches the variant — so ranking variant first
   * would return it.
   */
  it("weighs format above variant", () => {
    expect(
      sortByPreference([phone, json], { formats: ["json", "html"], variants: ["phone"] })[0],
    ).toBe(json);
  });

  it("falls back to the plain one when the variant has no template", () => {
    expect(sortByPreference([html], { formats: ["html"], variants: ["phone"] })[0]).toBe(html);
  });

  it("drops a variant nobody asked for", () => {
    expect(sortByPreference([phone], { formats: ["html"] })).toEqual([]);
  });

  it("prefers the requested locale", () => {
    const french = template("post", { locale: "fr" });

    expect(sortByPreference([plain, french], { locales: ["fr"] })[0]).toBe(french);
  });
});

describe("the cache key", () => {
  const requested = { formats: ["html"], variants: ["phone"], locales: ["fr"] };

  it("is the same for the same request", () => {
    expect(detailsCacheKey("post", "posts", requested)).toBe(
      detailsCacheKey("post", "posts", requested),
    );
  });

  /**
   * The one that matters. Without the variant in the key, a phone user is
   * served the desktop component a previous request warmed the cache with.
   */
  it("changes with the variant", () => {
    expect(detailsCacheKey("post", "posts", requested)).not.toBe(
      detailsCacheKey("post", "posts", { ...requested, variants: ["tablet"] }),
    );
  });

  it("changes with the format", () => {
    expect(detailsCacheKey("post", "posts", requested)).not.toBe(
      detailsCacheKey("post", "posts", { ...requested, formats: ["json"] }),
    );
  });

  it("changes with the locale", () => {
    expect(detailsCacheKey("post", "posts", requested)).not.toBe(
      detailsCacheKey("post", "posts", { ...requested, locales: ["en"] }),
    );
  });

  it("changes with the prefix", () => {
    expect(detailsCacheKey("post", "posts", requested)).not.toBe(
      detailsCacheKey("post", "admin/posts", requested),
    );
  });

  it("changes with the name", () => {
    expect(detailsCacheKey("post", "posts", requested)).not.toBe(
      detailsCacheKey("index", "posts", requested),
    );
  });

  it("hands back the details as an object", () => {
    expect(detailsKey(requested)).toEqual(requested);
  });

  it("names each detail", () => {
    expect(detailsKeys(requested)).toEqual(["formats=html", "variants=phone", "locales=fr"]);
  });
});

describe("formats", () => {
  /** An empty list means no preference, not "nothing is acceptable". */
  it("fills in a default when the request said nothing", () => {
    expect(normalizedFormats(undefined)).toEqual(["html"]);
    expect(normalizedFormats([])).toEqual(["html"]);
  });

  it("keeps what the request did say", () => {
    expect(normalizedFormats(["json"])).toEqual(["json"]);
  });

  it("says whether any were asked for", () => {
    expect(anyFormats(["html"])).toBe(true);
    expect(anyFormats([])).toBe(false);
  });

  /** A client asking for JSON should be told, not handed HTML to parse. */
  it("refuses a format nothing renders", () => {
    expect(() => validateFormats(["yaml"], ["html", "json"])).toThrow(InvalidFormat);
  });

  it("says what there is", () => {
    expect(() => validateFormats(["yaml"], ["html", "json"])).toThrow("html, json");
  });

  it("passes ones that exist", () => {
    expect(validateFormats(["json"], ["html", "json"])).toEqual(["json"]);
  });

  it("names the details it knows", () => {
    expect(registeredDetails()).toContain("format");
    expect(DETAIL_NAMES).toEqual(["locale", "format", "variant"]);
  });

  it("takes a new detail", () => {
    registerDetail("device", () => []);

    expect(registeredDetails()).toContain("device");
  });
});

describe("looking up", () => {
  it("finds a template by name", () => {
    setViewPaths([resolverWith(template("post", { prefix: "posts" }))]);

    expect(new LookupContext().findTemplate("posts/post").name).toBe("post");
  });

  it("says when one exists", () => {
    setViewPaths([resolverWith(template("post", { prefix: "posts" }))]);
    const context = new LookupContext();

    expect(context.templateExists("posts/post")).toBe(true);
    expect(context.templateExists("posts/missing")).toBe(false);
  });

  it("says whether any of several exist", () => {
    setViewPaths([resolverWith(template("post", { prefix: "posts" }))]);
    const context = new LookupContext();

    expect(context.anyTemplates(["posts/missing", "posts/post"])).toBe(true);
    expect(context.anyTemplates(["posts/missing"])).toBe(false);
  });

  it("searches the prefixes it was given", () => {
    setViewPaths([resolverWith(template("sidebar", { prefix: "shared" }))]);

    expect(new LookupContext({ prefixes: ["shared"] }).findTemplate("sidebar").name).toBe(
      "sidebar",
    );
  });

  it("takes the first resolver that has one", () => {
    const winner = template("post", { prefix: "posts", identifier: "override" });
    setViewPaths([
      resolverWith(winner),
      resolverWith(template("post", { prefix: "posts", identifier: "engine" })),
    ]);

    expect(new LookupContext().findTemplate("posts/post").identifier).toBe("override");
  });

  it("picks by format", () => {
    setViewPaths([
      resolverWith(
        template("post", { prefix: "posts", format: "html", identifier: "html" }),
        template("post", { prefix: "posts", format: "json", identifier: "json" }),
      ),
    ]);

    expect(new LookupContext({ formats: ["json"] }).findTemplate("posts/post").identifier).toBe(
      "json",
    );
  });

  it("refuses when nothing matches", () => {
    setViewPaths([resolverWith(template("post", { prefix: "posts", format: "json" }))]);

    expect(() => new LookupContext({ formats: ["html"] }).findTemplate("posts/post")).toThrow(
      MissingTemplate,
    );
  });

  it("says what was registered under that name", () => {
    setViewPaths([
      resolverWith(
        template("post", { prefix: "posts", format: "json", identifier: "the-json-one" }),
      ),
    ]);

    expect(() => new LookupContext({ formats: ["html"] }).findTemplate("posts/post")).toThrow(
      "the-json-one",
    );
  });

  it("copies itself with a detail replaced", () => {
    const context = new LookupContext({ formats: ["html"], variants: ["phone"] });

    expect(context.with({ formats: ["json"] }).formats).toEqual(["json"]);
    expect(context.with({ formats: ["json"] }).variants).toEqual(["phone"]);
    expect(context.formats).toEqual(["html"]);
  });

  it("hands back its details as a key", () => {
    expect(new LookupContext({ formats: ["json"] }).detailsKey().formats).toEqual(["json"]);
  });
});

describe("caching a lookup", () => {
  it("does not walk the resolvers twice", () => {
    const resolver = resolverWith(template("post", { prefix: "posts" }));
    let walked = 0;
    const original = resolver.findAll.bind(resolver);
    resolver.findAll = (...args) => {
      walked += 1;

      return original(...args);
    };
    setViewPaths([resolver]);
    const context = new LookupContext();

    context.findTemplate("posts/post");
    context.findTemplate("posts/post");

    expect(walked).toBe(1);
  });

  /**
   * A miss is cached too. Without it, a `render` of an optional sidebar
   * partial that does not exist walks every path on every request.
   */
  it("caches a miss as well", () => {
    const resolver = resolverWith(template("post", { prefix: "posts" }));
    let walked = 0;
    const original = resolver.findAll.bind(resolver);
    resolver.findAll = (...args) => {
      walked += 1;

      return original(...args);
    };
    setViewPaths([resolver]);
    const context = new LookupContext();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        context.findTemplate("posts/missing");
      } catch {
        // asserted below
      }
    }

    expect(walked).toBe(1);
  });

  /**
   * Registering a template has to invalidate what was cached before it — and
   * the miss has to go through `findTemplate`, since that is what caches.
   * Without the invalidation, a template registered after the first render of
   * a page that looked for it is never found for the life of the process.
   */
  it("forgets a cached miss when a template is added", () => {
    const resolver = resolverWith();
    setViewPaths([resolver]);
    const context = new LookupContext();

    expect(() => context.findTemplate("posts/post")).toThrow(MissingTemplate);
    resolver.add(template("post", { prefix: "posts" }));

    expect(context.findTemplate("posts/post").name).toBe("post");
  });

  it("clears every resolver's cache", () => {
    const resolver = resolverWith(template("post", { prefix: "posts" }));
    setViewPaths([resolver]);
    new LookupContext().findTemplate("posts/post");

    clearResolverCaches();

    expect(() => new LookupContext().findTemplate("posts/post")).not.toThrow();
  });
});
