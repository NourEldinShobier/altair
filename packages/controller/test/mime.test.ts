/**
 * Formats and content negotiation.
 *
 * Mirrors actionpack/test/controller/mime/respond_to_test.rb and
 * accept_header_test.rb, plus the `Vary` behaviour Rails gets for free from
 * Rack and this has to do for itself.
 */

import { describe, expect, it } from "bun:test";
import { Controller } from "../src/controller.js";
import { formatFor, formatFromPath, negotiateFormat, parseAccept } from "../src/mime.js";

const BROWSER = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

const get = (url: string, accept?: string) =>
  new Request(`http://test.host${url}`, accept ? { headers: { accept } } : undefined);

class PostsController extends Controller {
  async show(): Promise<void> {
    await this.respondTo({
      html: () => this.render.html("<h1>a post</h1>"),
      json: () => this.render.json({ title: "a post" }),
    });
  }

  async feed(): Promise<void> {
    await this.respondTo({
      atom: () => this.render.text("<feed/>"),
    });
  }
}

const run = async (request: Request, action: "show" | "feed" = "show") =>
  await new PostsController({ request, session: {} }).processAction(action);

describe("parsing Accept", () => {
  it("takes the types in order", () => {
    expect(parseAccept("application/json,text/html").map((entry) => entry.type)).toEqual([
      "application/json",
      "text/html",
    ]);
  });

  // Reading only the first entry is how an API ends up answering HTML to
  // something that asked for JSON.
  it("orders by quality, not position", () => {
    expect(parseAccept("text/html;q=0.2,application/json;q=0.9")[0]?.type).toBe("application/json");
  });

  it("keeps equal qualities in the order written", () => {
    expect(parseAccept(BROWSER).map((entry) => entry.type)).toEqual([
      "text/html",
      "application/xhtml+xml",
      "application/xml",
      "*/*",
    ]);
  });

  it("drops a type the client explicitly refuses", () => {
    expect(parseAccept("text/html;q=0").map((entry) => entry.type)).toEqual([]);
  });

  it("copes with no header", () => {
    expect(parseAccept(null)).toEqual([]);
    expect(parseAccept("")).toEqual([]);
  });
});

describe("naming a format", () => {
  it("maps a content type back to its format", () => {
    expect(formatFor("application/json")).toBe("json");
    expect(formatFor("text/html; charset=utf-8")).toBe("html");
  });

  // A browser sends xhtml and means html; an old client sends
  // application/javascript and means js.
  it("knows the aliases clients actually send", () => {
    expect(formatFor("application/xhtml+xml")).toBe("html");
    expect(formatFor("application/javascript")).toBe("js");
  });

  it("gives nothing for a type nobody registered", () => {
    expect(formatFor("application/vnd.made-up")).toBeUndefined();
  });

  it("reads an extension off a path", () => {
    expect(formatFromPath("/posts/1.json")).toBe("json");
    expect(formatFromPath("/posts/1")).toBeUndefined();
    expect(formatFromPath("/posts/1.made-up")).toBeUndefined();
  });
});

describe("choosing one", () => {
  const available = ["html", "json"];

  it("takes what the browser asked for first", () => {
    expect(negotiateFormat(get("/posts/1", BROWSER), { available })).toBe("html");
  });

  it("takes JSON when JSON is asked for", () => {
    expect(negotiateFormat(get("/posts/1", "application/json"), { available })).toBe("json");
  });

  // A link to /posts/1.json means JSON no matter what the browser would rather
  // have: a stated choice should not lose to a preference.
  it("lets an extension beat the header", () => {
    expect(negotiateFormat(get("/posts/1.json", BROWSER), { available })).toBe("json");
  });

  it("lets a parameter beat the header", () => {
    expect(negotiateFormat(get("/posts/1", BROWSER), { available, parameter: "json" })).toBe(
      "json",
    );
  });

  it("gives the action's own first choice when the client has no opinion", () => {
    expect(negotiateFormat(get("/posts/1"), { available })).toBe("html");
    expect(negotiateFormat(get("/posts/1", "*/*"), { available })).toBe("html");
  });

  it("honours a family wildcard", () => {
    expect(negotiateFormat(get("/posts/1", "application/*"), { available })).toBe("json");
    expect(negotiateFormat(get("/posts/1", "text/*"), { available })).toBe("html");
  });

  it("gives nothing when nothing matches", () => {
    expect(negotiateFormat(get("/posts/1", "application/pdf"), { available })).toBeUndefined();
  });

  // An extension naming a format the action cannot produce is a mistake, not
  // an invitation to fall back to the header.
  it("does not fall back when an extension names something unavailable", () => {
    expect(negotiateFormat(get("/posts/1.xml", BROWSER), { available })).toBeUndefined();
  });

  it("gives nothing when the action produces nothing", () => {
    expect(negotiateFormat(get("/posts/1"), { available: [] })).toBeUndefined();
  });
});

describe("in an action", () => {
  it("renders HTML for a browser", async () => {
    const response = await run(get("/posts/1", BROWSER));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("a post");
  });

  it("renders JSON for a client that wants it", async () => {
    const response = await run(get("/posts/1", "application/json"));

    expect(await response.json()).toEqual({ title: "a post" });
  });

  it("follows the extension", async () => {
    const response = await run(get("/posts/1.json", BROWSER));
    expect(await response.json()).toEqual({ title: "a post" });
  });

  // Sending HTML to something that asked for JSON is a failure that surfaces
  // far from here, so it is refused rather than guessed at.
  it("answers 406 when nothing is acceptable", async () => {
    const response = await run(get("/posts/1", "application/pdf"));
    expect(response.status).toBe(406);
  });

  it("records which format it chose", async () => {
    const controller = new PostsController({ request: get("/posts/1.json"), session: {} });
    await controller.processAction("show");

    expect(controller.format).toBe("json");
  });

  it("has no format when it could not choose one", async () => {
    const controller = new PostsController({
      request: get("/posts/1", "application/pdf"),
      session: {},
    });
    await controller.processAction("show");

    expect(controller.format).toBeUndefined();
  });

  it("serves a single-format action to a client that wants it", async () => {
    const response = await run(get("/feed", "application/atom+xml"), "feed");
    expect(response.status).toBe(200);
  });
});

// A response that varies by Accept and does not say so is one a shared cache
// will hand to the next client whatever that client asked for. This matters
// more here than in most frameworks, since conditional GET is supported.
describe("telling caches it varies", () => {
  it("says Vary: Accept", async () => {
    const response = await run(get("/posts/1", BROWSER));
    expect(response.headers.get("vary")).toBe("Accept");
  });

  it("says it on the JSON answer too", async () => {
    const response = await run(get("/posts/1", "application/json"));
    expect(response.headers.get("vary")).toBe("Accept");
  });

  it("says it even when nothing was acceptable", async () => {
    const response = await run(get("/posts/1", "application/pdf"));
    expect(response.headers.get("vary")).toBe("Accept");
  });

  it("keeps the cache headers a conditional GET set", async () => {
    class CachedController extends Controller {
      async show(): Promise<void> {
        this.expiresIn(60, { public: true });

        await this.respondTo({
          json: () => this.render.json({ ok: true }),
        });
      }
    }

    const response = await new CachedController({
      request: get("/posts/1", "application/json"),
      session: {},
    }).processAction("show");

    expect(response.headers.get("vary")).toBe("Accept");
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
  });
});
