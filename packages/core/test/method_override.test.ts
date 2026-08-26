/**
 * A form saying it meant PATCH, PUT or DELETE.
 *
 * Mirrors rack/test/spec_method_override.rb and the parts of
 * actionpack/test/dispatch/request_test.rb that cover `_method`.
 *
 * Lives here rather than beside the middleware because it drives a booted
 * application, and `@altair/controller` has no business depending on the thing
 * that depends on it.
 *
 * A browser sends only GET and POST from a form, so everything else travels as
 * a hidden `_method` field. `ButtonTo` has been writing one since it was
 * added and **nothing read it** — a delete button posted to a path with no
 * POST route and came back 404. The end-to-end test at the bottom is the one
 * that would have caught it.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Controller } from "@altair/controller";
import { createApplication, type Application } from "../src/index.js";

class PostsController extends Controller {
  create(): void {
    this.render.json({ action: "create" });
  }

  update(): void {
    this.render.json({ action: "update" });
  }

  destroy(): void {
    this.render.json({ action: "destroy" });
  }

  index(): void {
    this.render.json({ action: "index" });
  }
}

let app: Application;
let handler: (request: Request) => Promise<Response>;

beforeAll(async () => {
  app = createApplication({
    env: "test",
    secretKeyBase: "z".repeat(64),
    database: { url: "sqlite://:memory:" },
    log: { level: "fatal", format: "json", queries: false },
    routes: (r) => r.resources("posts"),
    controllers: { posts: PostsController },
  });

  await app.boot();
  handler = app.handler();
});

afterAll(async () => {
  await app.stop();
});

/** A form submission, as a browser sends one. */
const post = async (fields: Record<string, string>, path = "/posts/1") =>
  await handler(
    new Request(`http://test.host${path}`, {
      method: "POST",
      body: new URLSearchParams(fields).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    }),
  );

const actionOf = async (response: Response) =>
  response.ok ? ((await response.json()) as { action: string }).action : `${response.status}`;

describe("a posted form", () => {
  it("becomes a DELETE when it says so", async () => {
    expect(await actionOf(await post({ _method: "delete" }))).toBe("destroy");
  });

  it("becomes a PATCH when it says so", async () => {
    expect(await actionOf(await post({ _method: "patch" }))).toBe("update");
  });

  it("becomes a PUT when it says so", async () => {
    expect(await actionOf(await post({ _method: "put" }))).toBe("update");
  });

  it("is unchanged when it says nothing", async () => {
    expect(await actionOf(await post({ title: "x" }, "/posts"))).toBe("create");
  });

  it("does not mind the spelling", async () => {
    expect(await actionOf(await post({ _method: "DELETE" }))).toBe("destroy");
  });

  // The body has to survive: the dispatcher parses it again for params.
  it("keeps the rest of the form", async () => {
    const response = await post({ _method: "patch", title: "kept" });

    expect(await actionOf(response)).toBe("update");
  });
});

describe("a header saying the same thing", () => {
  it("is honoured, for a client that cannot send a form", async () => {
    const response = await handler(
      new Request("http://test.host/posts/1", {
        method: "POST",
        headers: { "x-http-method-override": "DELETE" },
      }),
    );

    expect(await actionOf(response)).toBe("destroy");
  });
});

/**
 * Only a POST is overridden, and that is the point rather than a detail.
 * Honouring it on a GET would let a link carry `?_method=delete`, and a link
 * is followed by crawlers, prefetchers and the back button — the failure
 * `ButtonTo` exists to avoid, reintroduced one layer down.
 */
describe("what it refuses to override", () => {
  it("leaves a GET alone", async () => {
    const response = await handler(
      new Request("http://test.host/posts?_method=delete", { method: "GET" }),
    );

    expect(await actionOf(response)).toBe("index");
  });

  it("leaves a GET alone even with the header", async () => {
    const response = await handler(
      new Request("http://test.host/posts", {
        method: "GET",
        headers: { "x-http-method-override": "DELETE" },
      }),
    );

    expect(await actionOf(response)).toBe("index");
  });

  it("refuses a method that is not one of the three", async () => {
    for (const wanted of ["GET", "HEAD", "OPTIONS", "TRACE", "nonsense", ""]) {
      const response = await post({ _method: wanted }, "/posts");

      expect(await actionOf(response)).toBe("create");
    }
  });

  it("ignores a body it cannot parse", async () => {
    const response = await handler(
      new Request("http://test.host/posts", {
        method: "POST",
        body: "not a form",
        headers: { "content-type": "application/json" },
      }),
    );

    expect(await actionOf(response)).toBe("create");
  });
});
