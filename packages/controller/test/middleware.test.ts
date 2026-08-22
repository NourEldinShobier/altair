/**
 * Middleware suite.
 *
 * Mirrors actionpack/test/dispatch/middleware_stack_test.rb, plus the
 * middleware Rails ships by default. The CORS cases lean on the failure side,
 * because a permissive default is the kind of bug nobody notices.
 */

import { describe, expect, it } from "bun:test";
import {
  MiddlewareStack,
  UnknownMiddleware,
  cors,
  forceSsl,
  requestId,
  securityHeaders,
  type Middleware,
} from "../src/middleware.js";

const ok: (request: Request) => Promise<Response> = async () => new Response("ok");

function get(url = "http://test.host/", init: RequestInit = {}): Request {
  return new Request(url, init);
}

/** A middleware that records when it ran, for ordering assertions. */
function record(order: string[], name: string): Middleware {
  return async (request, next) => {
    order.push(`${name}:in`);
    const response = await next(request);
    order.push(`${name}:out`);
    return response;
  };
}

describe("the stack", () => {
  it("runs middleware outside in and unwinds inside out", async () => {
    const order: string[] = [];
    const stack = new MiddlewareStack()
      .use("first", record(order, "first"))
      .use("second", record(order, "second"));

    await stack.build(ok)(get());

    expect(order).toEqual(["first:in", "second:in", "second:out", "first:out"]);
  });

  it("reaches the application when empty", async () => {
    expect(await (await new MiddlewareStack().build(ok)(get())).text()).toBe("ok");
  });

  it("lets a middleware answer without calling the application", async () => {
    let reached = false;
    const stack = new MiddlewareStack().use(
      "gate",
      async () => new Response("blocked", { status: 403 }),
    );

    const response = await stack.build(async () => {
      reached = true;
      return new Response("ok");
    })(get());

    expect(response.status).toBe(403);
    expect(reached).toBe(false);
  });

  it("puts one at the front with unshift", () => {
    const stack = new MiddlewareStack().use("second", ok as never).unshift("first", ok as never);
    expect(stack.names).toEqual(["first", "second"]);
  });

  // Ordering is the point of a stack; "compression after caching" has to be
  // sayable or the middleware does not work.
  it("inserts before and after a named entry", () => {
    const stack = new MiddlewareStack()
      .use("cache", ok as never)
      .use("app", ok as never)
      .insertBefore("cache", "logging", ok as never)
      .insertAfter("cache", "compression", ok as never);

    expect(stack.names).toEqual(["logging", "cache", "compression", "app"]);
  });

  it("swaps one in place", async () => {
    const order: string[] = [];
    const stack = new MiddlewareStack()
      .use("first", record(order, "original"))
      .use("second", record(order, "second"))
      .swap("first", record(order, "replacement"));

    await stack.build(ok)(get());

    expect(stack.names).toEqual(["first", "second"]);
    expect(order[0]).toBe("replacement:in");
  });

  it("deletes one", () => {
    const stack = new MiddlewareStack()
      .use("a", ok as never)
      .use("b", ok as never)
      .delete("a");

    expect(stack.names).toEqual(["b"]);
    expect(stack.has("a")).toBe(false);
  });

  it("names what it holds when asked for something it does not", () => {
    const stack = new MiddlewareStack().use("cache", ok as never);

    expect(() => stack.insertBefore("nope", "x", ok as never)).toThrow(UnknownMiddleware);
    expect(() => stack.delete("nope")).toThrow("It holds: cache");
  });
});

describe("requestId", () => {
  it("generates one when the client sends none", async () => {
    const response = await new MiddlewareStack().use("id", requestId()).build(ok)(get());
    expect(response.headers.get("x-request-id")).toMatch(/[0-9a-f-]{36}/);
  });

  it("keeps the one the client sent", async () => {
    const stack = new MiddlewareStack().use("id", requestId());
    const response = await stack.build(ok)(
      get("http://test.host/", { headers: { "x-request-id": "abc" } }),
    );

    expect(response.headers.get("x-request-id")).toBe("abc");
  });

  it("keeps the response body and status", async () => {
    const stack = new MiddlewareStack().use("id", requestId());
    const response = await stack.build(async () => new Response("body", { status: 201 }))(get());

    expect(response.status).toBe(201);
    expect(await response.text()).toBe("body");
  });
});

describe("cors", () => {
  // A framework whose CORS middleware is permissive by default ships
  // applications that accept requests from anywhere.
  it("allows nothing when no origin is configured", async () => {
    const stack = new MiddlewareStack().use("cors", cors());
    const response = await stack.build(ok)(
      get("http://test.host/", { headers: { origin: "http://evil.test" } }),
    );

    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("allows a configured origin", async () => {
    const stack = new MiddlewareStack().use("cors", cors({ origin: "http://app.test" }));
    const response = await stack.build(ok)(
      get("http://test.host/", { headers: { origin: "http://app.test" } }),
    );

    expect(response.headers.get("access-control-allow-origin")).toBe("http://app.test");
  });

  it("refuses an origin that is not on the list", async () => {
    const stack = new MiddlewareStack().use("cors", cors({ origin: ["http://app.test"] }));
    const response = await stack.build(ok)(
      get("http://test.host/", { headers: { origin: "http://evil.test" } }),
    );

    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("takes a predicate", async () => {
    const stack = new MiddlewareStack().use(
      "cors",
      cors({ origin: (origin) => origin.endsWith(".app.test") }),
    );

    const allowed = await stack.build(ok)(
      get("http://test.host/", { headers: { origin: "http://x.app.test" } }),
    );
    expect(allowed.headers.get("access-control-allow-origin")).toBe("http://x.app.test");
  });

  it("answers a preflight without touching the application", async () => {
    let reached = false;
    const stack = new MiddlewareStack().use("cors", cors({ origin: "http://app.test" }));

    const response = await stack.build(async () => {
      reached = true;
      return new Response("ok");
    })(
      get("http://test.host/", {
        method: "OPTIONS",
        headers: { origin: "http://app.test", "access-control-request-method": "POST" },
      }),
    );

    expect(response.status).toBe(204);
    expect(reached).toBe(false);
  });

  it("refuses a preflight from an origin it does not allow", async () => {
    const stack = new MiddlewareStack().use("cors", cors({ origin: "http://app.test" }));
    const response = await stack.build(ok)(
      get("http://test.host/", {
        method: "OPTIONS",
        headers: { origin: "http://evil.test", "access-control-request-method": "POST" },
      }),
    );

    expect(response.status).toBe(403);
  });

  // A response that varies by origin must say so, or a shared cache serves one
  // origin's response to another.
  it("marks the response as varying by origin", async () => {
    const stack = new MiddlewareStack().use("cors", cors({ origin: "http://app.test" }));
    const response = await stack.build(ok)(
      get("http://test.host/", { headers: { origin: "http://app.test" } }),
    );

    expect(response.headers.get("vary")).toBe("Origin");
  });

  it("sends credentials and max-age when configured", async () => {
    const stack = new MiddlewareStack().use(
      "cors",
      cors({ origin: "http://app.test", credentials: true, maxAge: 600 }),
    );
    const response = await stack.build(ok)(
      get("http://test.host/", {
        method: "OPTIONS",
        headers: { origin: "http://app.test", "access-control-request-method": "GET" },
      }),
    );

    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    expect(response.headers.get("access-control-max-age")).toBe("600");
  });
});

describe("securityHeaders", () => {
  it("sends Rails' defaults", async () => {
    const response = await new MiddlewareStack().use("security", securityHeaders()).build(ok)(
      get(),
    );

    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });

  it("takes overrides", async () => {
    const stack = new MiddlewareStack().use(
      "security",
      securityHeaders({ "x-frame-options": "DENY" }),
    );
    const response = await stack.build(ok)(get());

    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  // An application that set one deliberately keeps it.
  it("does not overwrite a header the application set", async () => {
    const stack = new MiddlewareStack().use("security", securityHeaders());
    const response = await stack.build(
      async () => new Response("ok", { headers: { "x-frame-options": "ALLOWALL" } }),
    )(get());

    expect(response.headers.get("x-frame-options")).toBe("ALLOWALL");
  });
});

describe("forceSsl", () => {
  it("redirects http to https", async () => {
    const stack = new MiddlewareStack().use("ssl", forceSsl());
    const response = await stack.build(ok)(get("http://app.test/posts?page=2"));

    // 301, so a browser stops sending the first request in plaintext at all.
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("https://app.test/posts?page=2");
  });

  it("passes https through", async () => {
    const stack = new MiddlewareStack().use("ssl", forceSsl());
    expect((await stack.build(ok)(get("https://app.test/"))).status).toBe(200);
  });

  it("trusts the proxy header", async () => {
    const stack = new MiddlewareStack().use("ssl", forceSsl());
    const response = await stack.build(ok)(
      get("http://app.test/", { headers: { "x-forwarded-proto": "https" } }),
    );

    expect(response.status).toBe(200);
  });

  it("leaves localhost alone", async () => {
    const stack = new MiddlewareStack().use("ssl", forceSsl());
    expect((await stack.build(ok)(get("http://localhost:3000/"))).status).toBe(200);
  });
});

describe("composition", () => {
  it("stacks several middleware over one application", async () => {
    const stack = new MiddlewareStack()
      .use("ssl", forceSsl())
      .use("security", securityHeaders())
      .use("cors", cors({ origin: "http://app.test" }))
      .use("id", requestId());

    const response = await stack.build(ok)(
      get("https://app.test/", { headers: { origin: "http://app.test" } }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("access-control-allow-origin")).toBe("http://app.test");
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });
});
