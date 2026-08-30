/**
 * Turning a value into a response body by the name the action used, ported
 * from `actionpack/test/controller/render_test.rb` (the renderer cases) and
 * `actionpack/test/dispatch/mime_type_test.rb`.
 *
 * The content type is the part worth testing hardest. A CSV served as
 * `text/html` opens in the browser instead of downloading, and a JSON body
 * with no charset is decoded by guesswork — both found by a user rather than
 * a test.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  acceptHeader,
  addRenderer,
  allRenderers,
  anyResponse,
  canonicalMimeType,
  defaultRender,
  encoderFor,
  handleNoContent,
  lookupByExtension,
  negotiateMime,
  registerAlias,
  registerBodyParser,
  registerEncoder,
  registerExtension,
  removeRenderer,
  renderToBody,
  resetMimeRegistrations,
  resetRenderers,
  responseParser,
  unregister,
  useRenderers,
} from "../src/renderers.js";

afterEach(() => {
  resetRenderers();
  resetMimeRegistrations();
});

function asking(accept: string | null): Request {
  return new Request("https://app.test/posts", {
    headers: accept === null ? {} : { accept },
  });
}

describe("the built-in renderers", () => {
  it("renders json", () => {
    expect(renderToBody({ json: { a: 1 } })).toEqual({
      body: '{"a":1}',
      contentType: "application/json; charset=utf-8",
    });
  });

  /**
   * The guess is wrong exactly when the body holds a name that is not ASCII —
   * which is to say, on the records people complain about.
   */
  it("names the charset", () => {
    expect(renderToBody({ json: { name: "Ana Muñoz" } })?.contentType).toContain("charset=utf-8");
  });

  it("passes a string through rather than encoding it twice", () => {
    expect(renderToBody({ json: '{"already":"json"}' })?.body).toBe('{"already":"json"}');
  });

  /** Served as JSON the browser will not execute it, which is the whole point. */
  it("renders jsonp as a script", () => {
    const rendered = renderToBody({ json: { a: 1 }, callback: "handle" });

    expect(rendered?.body).toBe('/**/handle({"a":1})');
    expect(rendered?.contentType).toContain("text/javascript");
  });

  /**
   * The leading comment defeats Rosetta Flash, where a response that is
   * entirely valid Flash bytecode is loaded as a cross-domain policy.
   */
  it("puts the comment in front of the callback", () => {
    expect(renderToBody({ json: {}, callback: "f" })?.body).toStartWith("/**/");
  });

  it("ignores an empty callback", () => {
    expect(renderToBody({ json: { a: 1 }, callback: "" })?.contentType).toContain(
      "application/json",
    );
  });

  it("renders plain text", () => {
    expect(renderToBody({ plain: "hello" })).toEqual({
      body: "hello",
      contentType: "text/plain; charset=utf-8",
    });
  });

  it("renders html", () => {
    expect(renderToBody({ html: "<p>x</p>" })?.contentType).toContain("text/html");
  });

  it("renders xml", () => {
    expect(renderToBody({ xml: "<a/>" })?.contentType).toContain("application/xml");
  });

  /** An SVG declares its own encoding; a header saying something else renders boxes. */
  it("gives svg no charset", () => {
    expect(renderToBody({ svg: "<svg/>" })?.contentType).toBe("image/svg+xml");
  });

  it("renders nothing when no key matches", () => {
    expect(renderToBody({ status: 200 })).toBeUndefined();
  });
});

describe("registering one", () => {
  /** The point: a format the framework never heard of works the same way. */
  it("takes a renderer the framework never heard of", () => {
    addRenderer("csv", (value) => ({
      body: (value as string[][]).map((row) => row.join(",")).join("\n"),
      contentType: "text/csv; charset=utf-8",
    }));

    expect(
      renderToBody({
        csv: [
          ["a", "b"],
          ["1", "2"],
        ],
      }),
    ).toEqual({ body: "a,b\n1,2", contentType: "text/csv; charset=utf-8" });
  });

  it("lists what can be rendered", () => {
    expect(allRenderers()).toContain("json");
  });

  it("removes one", () => {
    expect(removeRenderer("json")).toBe(true);
    expect(renderToBody({ json: { a: 1 } })).toBeUndefined();
  });

  it("says when there was nothing to remove", () => {
    expect(removeRenderer("never-registered")).toBe(false);
  });

  /**
   * Overriding the JSON renderer to add an envelope is the ordinary reason to
   * call this, and refusing would mean removing first.
   */
  it("replaces one by the same name", () => {
    addRenderer("json", () => ({ body: "enveloped", contentType: "application/json" }));

    expect(renderToBody({ json: { a: 1 } })?.body).toBe("enveloped");
  });

  it("puts the built-in ones back on reset", () => {
    removeRenderer("json");
    resetRenderers();

    expect(renderToBody({ json: { a: 1 } })?.body).toBe('{"a":1}');
  });

  /**
   * Not decoration: an endpoint that only answers JSON should not gain an XML
   * response because somebody registered one for a different part of the
   * application.
   */
  it("narrows the set a controller will use", () => {
    const only = useRenderers(["json"]);

    expect(renderToBody({ json: { a: 1 } }, only)?.body).toBe('{"a":1}');
    expect(renderToBody({ xml: "<a/>" }, only)).toBeUndefined();
  });

  it("ignores a name nothing registered", () => {
    expect(useRenderers(["json", "nonsense"]).size).toBe(1);
  });

  /** A caller that passed one has a reason; the renderer's default is a default. */
  it("lets an explicit content type win", () => {
    expect(
      renderToBody({ json: { a: 1 }, contentType: "application/vnd.api+json" })?.contentType,
    ).toBe("application/vnd.api+json");
  });

  it("still uses the renderer's body when the type is overridden", () => {
    expect(renderToBody({ json: { a: 1 }, contentType: "application/vnd.api+json" })?.body).toBe(
      '{"a":1}',
    );
  });
});

describe("empty responses", () => {
  /**
   * A `Content-Length: 0` on a 304 makes some caches serve a zero-length body
   * in place of what they had — emptying the page rather than refreshing it.
   */
  it("says a 204 and a 304 have no body", () => {
    expect(handleNoContent(204)).toBe(true);
    expect(handleNoContent(304)).toBe(true);
  });

  it("says the informational statuses have none either", () => {
    expect(handleNoContent(100)).toBe(true);
    expect(handleNoContent(102)).toBe(true);
  });

  it("says an ordinary status does have one", () => {
    expect(handleNoContent(200)).toBe(false);
    expect(handleNoContent(404)).toBe(false);
    expect(handleNoContent(500)).toBe(false);
  });

  /**
   * A client cannot tell an empty 200 from a 200 whose body it failed to
   * parse, and will usually try to parse it.
   */
  it("renders a 204 when an action says nothing", () => {
    expect(defaultRender()).toEqual({ status: 204 });
  });
});

describe("aliases and extensions", () => {
  /**
   * The same file has more than one official name, and a respond_to that knows
   * only one answers 406 to half the callers.
   */
  it("resolves an alias to the canonical type", () => {
    expect(canonicalMimeType("text/javascript")).toBe("application/javascript");
  });

  it("leaves a type that is already canonical", () => {
    expect(canonicalMimeType("application/json")).toBe("application/json");
  });

  it("ignores the parameters when resolving", () => {
    expect(canonicalMimeType("text/xml; charset=utf-8")).toBe("application/xml");
  });

  it("ignores case", () => {
    expect(canonicalMimeType("TEXT/JAVASCRIPT")).toBe("application/javascript");
  });

  it("takes a new alias", () => {
    registerAlias("application/x-yaml", "text/yaml");

    expect(canonicalMimeType("application/x-yaml")).toBe("text/yaml");
  });

  it("looks a type up by extension", () => {
    expect(lookupByExtension("csv")).toBe("text/csv");
  });

  it("takes a leading dot", () => {
    expect(lookupByExtension(".csv")).toBe("text/csv");
  });

  it("takes a new extension", () => {
    registerExtension("ics", "text/calendar");

    expect(lookupByExtension("ics")).toBe("text/calendar");
  });

  it("unregisters one", () => {
    unregister("csv");

    expect(lookupByExtension("csv")).toBeUndefined();
  });

  it("gives nothing for an extension nobody registered", () => {
    expect(lookupByExtension("zzz")).toBeUndefined();
  });

  it("puts the registrations back on reset", () => {
    unregister("csv");
    resetMimeRegistrations();

    expect(lookupByExtension("csv")).toBe("text/csv");
  });
});

describe("parsers and encoders", () => {
  it("parses a json body", () => {
    expect(responseParser("application/json")?.('{"a":1}')).toEqual({ a: 1 });
  });

  it("finds the parser through an alias", () => {
    registerBodyParser("application/javascript", (body) => body.toUpperCase());

    expect(responseParser("text/javascript")?.("x")).toBe("X");
  });

  it("ignores the parameters when finding one", () => {
    expect(responseParser("application/json; charset=utf-8")?.("{}")).toEqual({});
  });

  it("gives nothing for a type nobody parses", () => {
    expect(responseParser("application/octet-stream")).toBeUndefined();
  });

  it("takes an encoder", () => {
    registerEncoder("csv", (value) => (value as string[]).join(","));

    expect(encoderFor("csv")?.(["a", "b"])).toBe("a,b");
  });

  it("gives nothing for a format nobody encodes", () => {
    expect(encoderFor("nonsense")).toBeUndefined();
  });
});

describe("acceptHeader", () => {
  it("takes the header apart", () => {
    expect(acceptHeader(asking("application/json, text/html"))).toEqual([
      "application/json",
      "text/html",
    ]);
  });

  it("orders by quality", () => {
    expect(acceptHeader(asking("text/html;q=0.5, application/json;q=0.9"))).toEqual([
      "application/json",
      "text/html",
    ]);
  });

  /** Once the qualities tie, the order the client wrote them is all that is left. */
  it("keeps the client's own order when the qualities tie", () => {
    expect(acceptHeader(asking("text/html, application/json"))).toEqual([
      "text/html",
      "application/json",
    ]);
  });

  it("resolves aliases while it reads", () => {
    expect(acceptHeader(asking("text/javascript"))).toEqual(["application/javascript"]);
  });

  it("gives nothing for a missing header", () => {
    expect(acceptHeader(asking(null))).toEqual([]);
  });

  it("gives nothing for an empty one", () => {
    expect(acceptHeader(asking("  "))).toEqual([]);
  });
});

describe("negotiateMime", () => {
  it("picks the type the client asked for", () => {
    expect(negotiateMime(asking("application/json"), ["html", "json"])).toBe("json");
  });

  it("picks the client's preferred one", () => {
    expect(negotiateMime(asking("application/json;q=0.9, text/html;q=0.1"), ["html", "json"])).toBe(
      "json",
    );
  });

  it("matches a wildcard within a type", () => {
    expect(negotiateMime(asking("text/*"), ["json", "html"])).toBe("html");
  });

  it("gives the first offer to a client that will take anything", () => {
    expect(negotiateMime(asking("*/*"), ["html", "json"])).toBe("html");
  });

  it("gives the first offer when nothing was asked for", () => {
    expect(negotiateMime(asking(null), ["html", "json"])).toBe("html");
  });

  /**
   * Falling back to HTML for a client that asked for JSON sends a page to
   * something that will try to parse it, and the error names the parser rather
   * than the negotiation.
   */
  it("gives nothing rather than a wrong format", () => {
    expect(negotiateMime(asking("application/pdf"), ["html", "json"])).toBeUndefined();
  });

  it("negotiates through an alias", () => {
    expect(negotiateMime(asking("text/xml"), ["xml"])).toBe("xml");
  });
});

describe("anyResponse", () => {
  it("is true for a client that will take anything", () => {
    expect(anyResponse(asking("*/*"))).toBe(true);
  });

  it("is true when nothing was asked for", () => {
    expect(anyResponse(asking(null))).toBe(true);
  });

  it("is false for a client that named a type", () => {
    expect(anyResponse(asking("application/json"))).toBe(false);
  });

  it("is true when a wildcard is listed among named types", () => {
    expect(anyResponse(asking("application/json, */*"))).toBe(true);
  });
});
