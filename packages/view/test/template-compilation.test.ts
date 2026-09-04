/**
 * How a template file becomes something renderable, ported from
 * `actionview/test/template/resolver_patterns_test.rb`,
 * `actionview/test/template/digestor_test.rb` and the handler cases in
 * `actionview/test/template/template_test.rb`.
 *
 * The failures worth testing are the ones a cache hides: a stale digest serves
 * last week's partial inside this week's page, and nothing reproduces locally
 * because the local cache is empty.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  ESCAPE_IGNORE_LIST,
  type Handler,
  buildPathRegex,
  builtTemplates,
  compile,
  digestCacheStore,
  digestTemplate,
  eachWithInfo,
  eagerLoadTemplates,
  erbImplementation,
  erbTrimMode,
  escapeIgnoreList,
  forceEncoding,
  handlesEncoding,
  mimeTypesImplementation,
  parseTemplatePath,
  pathRegex,
  registerParser,
  registeredHandlers,
  renderStart,
  resetCompiled,
  resetDigestCache,
  resetHandlers,
  setRecording,
  shouldRecord,
  sourceExtract,
  supportsStreaming,
  toDepMap,
  translateLocation,
} from "../src/template-compilation.js";

const erb: Handler = { name: "erb", compile: (source) => `compiled(${source})` };

afterEach(() => {
  resetHandlers();
  resetCompiled();
  resetDigestCache();
  setRecording(false);
});

describe("reading a template filename", () => {
  it("reads a bare name", () => {
    expect(parseTemplatePath("show")).toEqual({ prefix: "", name: "show", partial: false });
  });

  it("reads a prefix", () => {
    expect(parseTemplatePath("posts/show").prefix).toBe("posts");
  });

  it("notices a partial", () => {
    expect(parseTemplatePath("posts/_post").partial).toBe(true);
    expect(parseTemplatePath("posts/_post").name).toBe("post");
  });

  it("reads format and handler", () => {
    expect(parseTemplatePath("posts/show.html.erb")).toMatchObject({
      name: "show",
      format: "html",
      handler: "erb",
    });
  });

  it("reads a locale and a variant", () => {
    expect(parseTemplatePath("posts/show.en.html+phone.erb")).toMatchObject({
      locale: "en",
      format: "html",
      variant: "phone",
      handler: "erb",
    });
  });

  it("reads a regional locale", () => {
    expect(parseTemplatePath("show.pt-BR.html.erb").locale).toBe("pt-BR");
  });

  /**
   * The format has to come from the right dot: guessed from the wrong one,
   * `post.json.jbuilder` renders as HTML.
   */
  it("does not mistake a handler for a format", () => {
    expect(parseTemplatePath("posts/show.json.jbuilder")).toMatchObject({
      format: "json",
      handler: "jbuilder",
    });
  });

  it("reads a handler with no format", () => {
    expect(parseTemplatePath("posts/show.erb")).toMatchObject({ name: "show", handler: "erb" });
  });
});

describe("the pattern filenames are read with", () => {
  it("is built from the handlers", () => {
    expect(buildPathRegex(["erb"]).source).toContain("erb");
  });

  /**
   * Unescaped, a handler named `e+b` is read as the pattern "one or more e
   * then b" — so it matches `show.eeb` and not `show.e+b`, and the handler's
   * own templates become invisible while somebody else's are claimed.
   */
  it("escapes a handler containing regex characters", () => {
    const pattern = buildPathRegex(["e+b"]);

    expect(pattern.exec("show.e+b")?.groups?.["handler"]).toBe("e+b");
    expect(pattern.exec("show.eeb")?.groups?.["handler"]).toBeUndefined();
  });

  /**
   * A handler nothing recognises in a filename has invisible templates, and
   * the application sees "template not found" — which sends the reader to the
   * view directory rather than to the handler.
   */
  it("is rebuilt when a handler registers", () => {
    expect(parseTemplatePath("show.slim").handler).toBeUndefined();

    registerParser({ name: "slim", compile: (source) => source });

    expect(parseTemplatePath("show.slim").handler).toBe("slim");
    expect(registeredHandlers()).toEqual(["slim"]);
    expect(pathRegex().source).toContain("slim");
  });
});

describe("what a handler declares", () => {
  /**
   * Escaped again, a markup handler renders `&lt;p&gt;` to the reader; not
   * escaped, a text handler renders whatever a user typed as markup. The two
   * failures are opposite and only one is visible.
   */
  it("says whether it has already escaped", () => {
    registerParser({ name: "raw", compile: (source) => source, handlesEncoding: true });
    registerParser({ name: "txt", compile: (source) => source });

    expect(handlesEncoding("raw")).toBe(true);
    expect(handlesEncoding("txt")).toBe(false);
    expect(handlesEncoding("unregistered")).toBe(false);
  });

  /**
   * Without trimming, every `<% if %>` leaves a blank line, and a template of
   * nested conditionals produces a page whose source is mostly whitespace.
   */
  it("trims by default", () => {
    expect(erbTrimMode()).toBe("-");
    expect(erbTrimMode("<>")).toBe("<>");
  });

  it("names the implementations", () => {
    expect(erbImplementation()).toBe("erubi");
    expect(mimeTypesImplementation()).toBe("mini_mime");
    expect(erbImplementation("erb")).toBe("erb");
  });

  /**
   * `&quot;` inside a JSON document is not a quote, and the document fails to
   * parse in the browser with an error naming a character position.
   */
  it("does not escape JavaScript or JSON", () => {
    expect(escapeIgnoreList()).toEqual([...ESCAPE_IGNORE_LIST]);
    expect(escapeIgnoreList()).toContain("application/json");
    expect(escapeIgnoreList()).not.toContain("text/html");
  });
});

describe("reading a template's source", () => {
  /**
   * Guessing from the bytes turns one stray Latin-1 character into a whole
   * template that renders as mojibake, and the guess succeeds — so nothing
   * reports it.
   */
  it("assumes UTF-8", () => {
    expect(forceEncoding("<p>hi</p>")).toEqual({ encoding: "UTF-8", source: "<p>hi</p>" });
  });

  it("obeys a magic comment and strips it", () => {
    expect(forceEncoding("# encoding: iso-8859-1\n<p>hi</p>")).toEqual({
      encoding: "ISO-8859-1",
      source: "<p>hi</p>",
    });
  });
});

describe("compiling", () => {
  it("compiles through the handler", () => {
    expect(compile("posts/show", "<p>", erb).body).toBe("compiled(<p>)");
  });

  /**
   * By digest rather than mtime: two machines in a deploy have different
   * mtimes for identical files, so an mtime key makes their fragment caches
   * disagree while each stays internally consistent.
   */
  it("compiles once for the same source", () => {
    let calls = 0;
    const counting: Handler = {
      name: "erb",
      compile: (source) => {
        calls += 1;

        return source;
      },
    };

    compile("posts/show", "<p>", counting);
    compile("posts/show", "<p>", counting);

    expect(calls).toBe(1);
  });

  it("compiles again when the source changes", () => {
    compile("posts/show", "<p>", erb);
    compile("posts/show", "<div>", erb);

    expect(builtTemplates()).toHaveLength(2);
  });

  it("keys different templates separately", () => {
    compile("a", "<p>", erb);
    compile("b", "<p>", erb);

    expect(builtTemplates()).toHaveLength(2);
  });

  it("carries the dependencies it was told about", () => {
    expect(compile("posts/show", "<p>", erb, ["posts/_post"]).dependencies).toEqual([
      "posts/_post",
    ]);
  });
});

describe("compiling everything at boot", () => {
  /**
   * Lazy compilation leaves the first request for each page paying for it, and
   * makes compilation happen under concurrency for the life of the process
   * rather than once before anything is serving.
   */
  it("compiles every template", () => {
    const result = eagerLoadTemplates([
      { identifier: "a", source: "<p>", handler: erb },
      { identifier: "b", source: "<p>", handler: erb },
    ]);

    expect(result).toEqual({ compiled: 2, failures: [] });
  });

  /** A deploy that would break four templates should say so once. */
  it("reports every failure rather than raising on the first", () => {
    const failing: Handler = {
      name: "erb",
      compile: (source) => {
        if (source === "bad") throw new Error("syntax error");

        return source;
      },
    };

    const result = eagerLoadTemplates([
      { identifier: "a", source: "bad", handler: failing },
      { identifier: "b", source: "ok", handler: failing },
      { identifier: "c", source: "bad", handler: failing },
    ]);

    expect(result.compiled).toBe(1);
    expect(result.failures.map((failure) => failure.identifier)).toEqual(["a", "c"]);
  });
});

describe("digests", () => {
  const digests: Record<string, string> = { "posts/show": "aaa", "posts/_post": "bbb" };
  const deps: Record<string, string[]> = { "posts/show": ["posts/_post"], "posts/_post": [] };

  const digestOf = (identifier: string) => digests[identifier] ?? "";
  const depsOf = (identifier: string) => deps[identifier] ?? [];

  /**
   * Without folding in the partials, a fragment cache serves last week's
   * partial inside this week's page — a rendering bug nobody reproduces
   * locally, because the local cache is empty.
   */
  it("changes when a partial changes", () => {
    const before = digestTemplate("posts/show", "aaa", depsOf, digestOf);
    resetDigestCache();
    digests["posts/_post"] = "ccc";
    const after = digestTemplate("posts/show", "aaa", depsOf, digestOf);

    expect(after).not.toBe(before);
    digests["posts/_post"] = "bbb";
  });

  it("is stable for unchanged templates", () => {
    const first = digestTemplate("posts/show", "aaa", depsOf, digestOf);
    resetDigestCache();

    expect(digestTemplate("posts/show", "aaa", depsOf, digestOf)).toBe(first);
  });

  it("is cached", () => {
    digestTemplate("posts/show", "aaa", depsOf, digestOf);

    expect(digestCacheStore().has("posts/show")).toBe(true);
  });

  /**
   * Two partials rendering each other is unusual and not impossible, and
   * hanging at boot is a worse way to report it than a slightly weaker digest.
   */
  it("survives a cycle", () => {
    const cyclic = (identifier: string) => (identifier === "a" ? ["b"] : ["a"]);

    expect(() => digestTemplate("a", "aaa", cyclic, () => "bbb")).not.toThrow();
  });

  /**
   * A template that renders nothing and one that was never scanned need
   * different responses: the first is a leaf, the second is a hole that makes
   * every digest downstream of it wrong.
   */
  it("lists every template even with no dependencies", () => {
    const map = toDepMap([
      { identifier: "a", dependencies: ["b"] },
      { identifier: "b", dependencies: [] },
    ]);

    expect(map.get("b")).toEqual([]);
    expect(map.has("c")).toBe(false);
  });
});

describe("reporting an error in a template", () => {
  /**
   * Reporting the compiled line sends the reader to a file they cannot open,
   * which is the most common complaint about template errors in any framework
   * that compiles them.
   */
  it("maps a compiled line back to the template", () => {
    expect(translateLocation(12, 4)).toBe(8);
  });

  it("never reports a line before the first", () => {
    expect(translateLocation(2, 10)).toBe(1);
  });

  /** A block of unannotated lines makes the reader count. */
  it("marks the line that failed", () => {
    const extract = sourceExtract("one\ntwo\nthree\nfour\nfive", 3, { context: 1 });

    expect(extract).toBe("     2: two\n>    3: three\n     4: four");
  });

  /**
   * A negative start would slice from the *end* of the file, showing the last
   * lines as though they were the first — an extract pointing at the wrong
   * place is worse than none.
   */
  it("does not run off the start or the end", () => {
    expect(sourceExtract("one\ntwo\nthree", 1, { context: 2 })).toBe(
      ">    1: one\n     2: two\n     3: three",
    );
  });
});

describe("what a renderer supports", () => {
  /**
   * Streaming a handler that builds its result in memory sends nothing until
   * the end and then everything — slower than not streaming, and the headers
   * already went out.
   */
  it("streams only the handlers that can", () => {
    expect(supportsStreaming("erb")).toBe(true);
    expect(supportsStreaming("jbuilder")).toBe(false);
  });

  it("records nothing unless asked", () => {
    expect(shouldRecord()).toBe(false);

    const stack: string[] = [];
    renderStart("posts/show", stack);

    expect(stack).toEqual([]);
  });

  /**
   * A start without an end leaves the recorded stack growing for the life of
   * the process, and the tenth render appears nested ten deep inside the
   * first.
   */
  it("pairs a start with an end", () => {
    setRecording(true);
    const stack: string[] = [];

    const finish = renderStart("posts/show", stack);

    expect(stack).toEqual(["posts/show"]);

    finish();

    expect(stack).toEqual([]);
  });

  /**
   * Paired afterwards by index, the two lists get out of step — a caller
   * choosing between templates then compares one file's details against
   * another's identifier.
   */
  it("pairs each identifier with what its filename said", () => {
    expect(eachWithInfo(["posts/show.html.erb"])).toEqual([
      {
        identifier: "posts/show.html.erb",
        info: { prefix: "posts", name: "show", partial: false, format: "html", handler: "erb" },
      },
    ]);
  });
});
