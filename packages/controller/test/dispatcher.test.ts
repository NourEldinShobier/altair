/**
 * Dispatcher suite.
 *
 * Mirrors the integration behaviour of actionpack/test/controller/integration_test.rb:
 * a request goes in, a route is recognized, a controller answers.
 */

import { describe, expect, it } from "bun:test";
import { Router } from "@altair/router";
import { Controller, beforeAction } from "../src/controller.js";
import { MissingController, createDispatcher, parseBody } from "../src/dispatcher.js";

class PostsController extends Controller {
  // These build a controller directly rather than through an application, so
  // the test environment's setting never reaches them. They are about dispatch
  // and request scope, not forgery.
  static {
    this.skipForgeryProtection();
  }

  index(): void {
    this.render.json({ action: "index" });
  }
  show(): void {
    this.render.json({ action: "show", id: this.params.get("id") });
  }
  create(): void {
    this.render.json({ action: "create", title: this.params.get("title") }, { status: 201 });
  }
  update(): void {
    this.render.json({ action: "update", id: this.params.get("id") });
  }
  destroy(): void {
    this.head(204);
  }
}

function app(controllers: Record<string, typeof PostsController> = { posts: PostsController }) {
  const router = new Router().draw((r) => r.resources("posts"));
  return createDispatcher({ router, controllers });
}

function request(method: string, path: string, init: RequestInit = {}): Request {
  return new Request(`http://test.host${path}`, { method, ...init });
}

describe("dispatch", () => {
  it("routes a request to a controller action", async () => {
    const response = await app()(request("GET", "/posts"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ action: "index" });
  });

  it("passes route params through", async () => {
    const response = await app()(request("GET", "/posts/7"));
    expect(await response.json()).toEqual({ action: "show", id: "7" });
  });

  it("dispatches by verb", async () => {
    expect(await (await app()(request("PATCH", "/posts/7"))).json()).toMatchObject({
      action: "update",
    });

    const destroyed = await app()(request("DELETE", "/posts/7"));
    expect(destroyed.status).toBe(204);
  });

  it("returns 404 when no route matches", async () => {
    const response = await app()(request("GET", "/nope"));
    expect(response.status).toBe(404);
  });

  it("uses a custom notFound handler", async () => {
    const router = new Router().draw((r) => r.resources("posts"));
    const dispatch = createDispatcher({
      router,
      controllers: { posts: PostsController },
      notFound: () => Response.json({ error: "not found" }, { status: 404 }),
    });

    const response = await dispatch(request("GET", "/nope"));
    expect(await response.json()).toEqual({ error: "not found" });
  });

  it("reports a route whose controller is not registered", async () => {
    const router = new Router().draw((r) => r.resources("comments"));
    const dispatch = createDispatcher({ router, controllers: {} });

    await expect(dispatch(request("GET", "/comments"))).rejects.toThrow(MissingController);
  });

  it("routes an error to onError", async () => {
    class BrokenController extends Controller {
      index(): void {
        throw new Error("boom");
      }
    }
    const router = new Router().draw((r) => r.resources("posts"));
    const dispatch = createDispatcher({
      router,
      controllers: { posts: BrokenController as never },
      onError: (error) => Response.json({ error: (error as Error).message }, { status: 500 }),
    });

    const response = await dispatch(request("GET", "/posts"));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "boom" });
  });

  it("runs filters through the dispatcher", async () => {
    class GuardedController extends Controller {
      @beforeAction
      requireToken(): void {
        if (!this.request.headers.get("authorization")) this.head(401);
      }
      index(): void {
        this.render.json({ ok: true });
      }
    }

    const router = new Router().draw((r) => r.resources("posts"));
    const dispatch = createDispatcher({
      router,
      controllers: { posts: GuardedController as never },
    });

    expect((await dispatch(request("GET", "/posts"))).status).toBe(401);
    expect(
      (await dispatch(request("GET", "/posts", { headers: { authorization: "t" } }))).status,
    ).toBe(200);
  });
});

describe("body parsing", () => {
  it("parses a JSON body into params", async () => {
    const response = await app()(
      request("POST", "/posts", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Hello" }),
      }),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ action: "create", title: "Hello" });
  });

  it("parses a form-encoded body", async () => {
    const body = new URLSearchParams({ title: "Formed" });
    const response = await app()(
      request("POST", "/posts", {
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      }),
    );

    expect(await response.json()).toMatchObject({ title: "Formed" });
  });

  // Rails' tags[] convention collects repeated keys into an array.
  it("collects repeated bracket keys into an array", async () => {
    const body = new URLSearchParams();
    body.append("tags[]", "a");
    body.append("tags[]", "b");

    const parsed = await parseBody(
      request("POST", "/posts", {
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      }),
    );

    expect(parsed).toEqual({ tags: ["a", "b"] });
  });

  it("ignores a body on GET", async () => {
    expect(await parseBody(request("GET", "/posts"))).toEqual({});
  });

  it("survives a malformed JSON body", async () => {
    const parsed = await parseBody(
      request("POST", "/posts", {
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
    );

    expect(parsed).toEqual({});
  });

  it("merges query string over nothing and route params over both", async () => {
    const response = await app()(request("GET", "/posts/9?page=2"));
    expect(await response.json()).toEqual({ action: "show", id: "9" });
  });
});
