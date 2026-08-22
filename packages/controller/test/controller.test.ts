/**
 * Controller parity suite.
 *
 * Mirrors actionpack/test/controller/filters_test.rb and the strong-parameters
 * tests. Each case names the Rails behaviour it covers.
 */

import { describe, expect, it } from "bun:test";
import { Controller, afterAction, aroundAction, beforeAction } from "../src/controller.js";
import {
  ParameterMissing,
  ParameterValidationError,
  Parameters,
  UnpermittedParameters,
  type StandardSchemaV1,
} from "../src/parameters.js";

function get(path = "http://test.host/posts", init?: RequestInit): Request {
  return new Request(path, init);
}

describe("actions", () => {
  it("runs an action and returns its response", async () => {
    class PostsController extends Controller {
      index(): void {
        this.render.json({ ok: true });
      }
    }

    const response = await new PostsController({ request: get() }).processAction("index");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  // Rails: an action that renders nothing sends 204.
  it("sends 204 when an action renders nothing", async () => {
    class PostsController extends Controller {
      index(): void {}
    }

    const response = await new PostsController({ request: get() }).processAction("index");
    expect(response.status).toBe(204);
  });

  it("reports a missing action", async () => {
    class PostsController extends Controller {}

    await expect(new PostsController({ request: get() }).processAction("nope")).rejects.toThrow(
      'The action "nope" could not be found',
    );
  });

  // Rails: DoubleRenderError
  it("refuses to render twice", async () => {
    class PostsController extends Controller {
      index(): void {
        this.render.json({ first: true });
        this.render.json({ second: true });
      }
    }

    await expect(new PostsController({ request: get() }).processAction("index")).rejects.toThrow(
      "Render and/or redirect were called multiple times",
    );
  });

  it("redirects with 302 by default", async () => {
    class PostsController extends Controller {
      index(): void {
        this.redirectTo("/login");
      }
    }

    const response = await new PostsController({ request: get() }).processAction("index");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/login");
  });

  it("sends a bare status with head", async () => {
    class PostsController extends Controller {
      index(): void {
        this.head(418);
      }
    }

    const response = await new PostsController({ request: get() }).processAction("index");
    expect(response.status).toBe(418);
    expect(await response.text()).toBe("");
  });
});

describe("filters", () => {
  // Rails: test_before_filter
  it("runs a before filter", async () => {
    const order: string[] = [];

    class PostsController extends Controller {
      @beforeAction
      authenticate(): void {
        order.push("filter");
      }

      index(): void {
        order.push("action");
        this.render.json({});
      }
    }

    await new PostsController({ request: get() }).processAction("index");
    expect(order).toEqual(["filter", "action"]);
  });

  // Rails: a filter that renders halts the chain and the action never runs.
  it("halts when a before filter responds", async () => {
    const order: string[] = [];

    class PostsController extends Controller {
      @beforeAction
      requireLogin(): void {
        order.push("filter");
        this.redirectTo("/login");
      }

      index(): void {
        order.push("action");
      }
    }

    const response = await new PostsController({ request: get() }).processAction("index");

    expect(order).toEqual(["filter"]);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/login");
  });

  // Rails: test_before_filter_chain_is_halted — later filters are skipped too.
  it("skips later filters after a halt", async () => {
    const order: string[] = [];

    class PostsController extends Controller {
      @beforeAction
      first(): void {
        order.push("first");
        this.head(401);
      }

      @beforeAction
      second(): void {
        order.push("second");
      }

      index(): void {
        order.push("action");
      }
    }

    await new PostsController({ request: get() }).processAction("index");
    expect(order).toEqual(["first"]);
  });

  // Rails: after filters run in reverse order
  it("runs after filters in reverse order", async () => {
    const order: string[] = [];

    class PostsController extends Controller {
      @afterAction
      first(): void {
        order.push("after-first");
      }

      @afterAction
      second(): void {
        order.push("after-second");
      }

      index(): void {
        order.push("action");
        this.render.json({});
      }
    }

    await new PostsController({ request: get() }).processAction("index");
    expect(order).toEqual(["action", "after-second", "after-first"]);
  });

  // Rails: around filters wrap the action
  it("wraps the action with an around filter", async () => {
    const order: string[] = [];

    class PostsController extends Controller {
      @aroundAction
      async instrument(_c: PostsController, block: () => Promise<unknown>): Promise<void> {
        order.push("in");
        await block();
        order.push("out");
      }

      index(): void {
        order.push("action");
        this.render.json({});
      }
    }

    await new PostsController({ request: get() }).processAction("index");
    expect(order).toEqual(["in", "action", "out"]);
  });

  // Rails: test_before_filter_with_only
  it("honours only:", async () => {
    const ran: string[] = [];

    class PostsController extends Controller {
      @beforeAction({ only: ["edit"] })
      requireLogin(): void {
        ran.push(this.actionName);
      }

      index(): void {
        this.render.json({});
      }
      edit(): void {
        this.render.json({});
      }
    }

    await new PostsController({ request: get() }).processAction("index");
    expect(ran).toEqual([]);

    await new PostsController({ request: get() }).processAction("edit");
    expect(ran).toEqual(["edit"]);
  });

  // Rails: test_before_filter_with_except
  it("honours except:", async () => {
    const ran: string[] = [];

    class PostsController extends Controller {
      @beforeAction({ except: ["index"] })
      audit(): void {
        ran.push(this.actionName);
      }

      index(): void {
        this.render.json({});
      }
      show(): void {
        this.render.json({});
      }
    }

    await new PostsController({ request: get() }).processAction("index");
    expect(ran).toEqual([]);

    await new PostsController({ request: get() }).processAction("show");
    expect(ran).toEqual(["show"]);
  });

  // Rails: filters are inherited by subclasses
  it("inherits filters", async () => {
    const order: string[] = [];

    class ApplicationController extends Controller {
      @beforeAction
      setLocale(): void {
        order.push("locale");
      }
    }

    class PostsController extends ApplicationController {
      @beforeAction
      loadPost(): void {
        order.push("load");
      }

      index(): void {
        order.push("action");
        this.render.json({});
      }
    }

    await new PostsController({ request: get() }).processAction("index");
    expect(order).toEqual(["locale", "load", "action"]);
  });

  // Rails: test_skipping_filters
  it("lets a subclass skip an inherited filter", async () => {
    const order: string[] = [];

    class ApplicationController extends Controller {
      @beforeAction
      requireLogin(): void {
        order.push("login");
      }
    }

    class PublicController extends ApplicationController {
      index(): void {
        order.push("action");
        this.render.json({});
      }
    }
    PublicController.skipBeforeAction("requireLogin");

    await new PublicController({ request: get() }).processAction("index");
    expect(order).toEqual(["action"]);
  });

  // The explicit form registers the same chain the decorator does.
  it("supports the explicit registration form", async () => {
    const order: string[] = [];

    class PostsController extends Controller {
      index(): void {
        order.push("action");
        this.render.json({});
      }
      audit(): void {
        order.push("audit");
      }
    }
    PostsController.beforeAction("audit");

    await new PostsController({ request: get() }).processAction("index");
    expect(order).toEqual(["audit", "action"]);
  });
});

describe("params", () => {
  it("merges query, body and route params", () => {
    const controller = new (class extends Controller {})({
      request: get("http://test.host/posts?page=2"),
      params: { title: "Hello" },
      routeParams: { id: "7" },
    });

    expect(controller.params.get("page")).toBe("2");
    expect(controller.params.get("title")).toBe("Hello");
    expect(controller.params.get("id")).toBe("7");
  });

  // Rails: params.require(:post)
  it("requires a key", () => {
    const params = new Parameters({ post: { title: "Hi" } });
    expect(params.require("post")).toBeInstanceOf(Parameters);
  });

  // Rails: ParameterMissing for a missing or empty value
  it("throws when a required key is missing or empty", () => {
    expect(() => new Parameters({}).require("post")).toThrow(ParameterMissing);
    expect(() => new Parameters({ post: {} }).require("post")).toThrow(ParameterMissing);
    expect(() => new Parameters({ post: "" }).require("post")).toThrow(ParameterMissing);
  });

  // Rails: `false` is a value, not a missing parameter
  it("treats false as present", () => {
    expect(new Parameters({ admin: false }).require("admin")).toBe(false);
  });

  // Rails: permit drops anything not listed
  it("permits only the listed keys", () => {
    const params = new Parameters({ title: "Hi", body: "There", admin: true });
    const permitted = params.require("title") as unknown;

    expect(permitted).toBe("Hi");
    expect(params.permit("title", "body").toObject()).toEqual({ title: "Hi", body: "There" });
  });

  // Rails: a bare key does not permit a nested hash
  it("does not permit a nested object through a bare key", () => {
    const params = new Parameters({ author: { name: "Ada" } });
    expect(params.permit("author").toObject()).toEqual({});
  });

  // Rails: permit(tags: []) allows an array of scalars
  it("permits arrays and nested objects explicitly", () => {
    const params = new Parameters({
      tags: ["a", "b"],
      author: { name: "Ada", secret: "x" },
    });

    expect(params.permit({ tags: [] }, { author: ["name"] }).toObject()).toEqual({
      tags: ["a", "b"],
      author: { name: "Ada" },
    });
  });

  // Rails: mass assignment from unpermitted params is refused
  it("refuses to hand over unpermitted params", () => {
    expect(() => new Parameters({ title: "Hi" }).toObject()).toThrow(UnpermittedParameters);
    expect(new Parameters({ title: "Hi" }).toUnsafeObject()).toEqual({ title: "Hi" });
  });
});

describe("validate", () => {
  /** A hand-rolled Standard Schema, so the test needs no validator dependency. */
  const postSchema: StandardSchemaV1<unknown, { title: string; body: string }> = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value) => {
        const raw = value as Record<string, unknown>;
        if (typeof raw.title !== "string" || raw.title.length === 0) {
          return { issues: [{ message: "title is required", path: ["title"] }] };
        }
        if (typeof raw.body !== "string") {
          return { issues: [{ message: "body must be a string", path: ["body"] }] };
        }
        return { value: { title: raw.title, body: raw.body } };
      },
    },
  };

  // Altair-specific: what strong parameters were reaching for. Zod, Valibot and
  // ArkType all implement this interface, so any of them works here.
  it("returns typed data from any Standard Schema validator", async () => {
    const params = new Parameters({ post: { title: "Hi", body: "There", admin: true } });
    const post = await (params.require("post") as Parameters).validate(postSchema);

    // post.title is string at compile time, not unknown.
    expect(post.title.toUpperCase()).toBe("HI");
    expect(post).toEqual({ title: "Hi", body: "There" });
  });

  it("throws with the validator's issues", async () => {
    const params = new Parameters({ title: "", body: "x" });

    await expect(params.validate(postSchema)).rejects.toThrow(ParameterValidationError);
    await expect(params.validate(postSchema)).rejects.toThrow("title is required");
  });
});
