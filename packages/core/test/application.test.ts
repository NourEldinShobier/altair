/**
 * Application suite.
 *
 * Mirrors railties/test/application/ — configuration, boot, the request
 * handler and error handling.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { Controller } from "@altair/controller";
import { Application, createApplication } from "../src/application.js";
import { buildConfig, currentEnvironment, defaultsFor } from "../src/config.js";

const SECRET = "x".repeat(64);

class HomeController extends Controller {
  index(): void {
    this.render.json({ ok: true });
  }
  boom(): void {
    throw new Error("kaboom");
  }
  counter(): void {
    const visits = Number(this.session.get("visits") ?? 0) + 1;
    this.session.set("visits", visits);
    this.render.json({ visits });
  }
}

function app(overrides: Parameters<typeof createApplication>[0] = {}): Application {
  return createApplication({
    env: "test",
    secretKeyBase: SECRET,
    database: { url: "sqlite://:memory:" },
    routes: (r) => {
      r.root("home#index");
      r.get("boom", { to: "home#boom" });
      r.get("counter", { to: "home#counter" });
    },
    controllers: { home: HomeController },
    ...overrides,
  });
}

let running: Application | undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
});

describe("environment", () => {
  it("defaults to development", () => {
    expect(currentEnvironment({})).toBe("development");
    expect(currentEnvironment({ NODE_ENV: "weird" })).toBe("development");
  });

  it("reads production and test", () => {
    expect(currentEnvironment({ NODE_ENV: "production" })).toBe("production");
    expect(currentEnvironment({ ALTAIR_ENV: "test" })).toBe("test");
  });

  it("prefers ALTAIR_ENV", () => {
    expect(currentEnvironment({ ALTAIR_ENV: "test", NODE_ENV: "production" })).toBe("test");
  });
});

describe("config", () => {
  // Safe settings have to be the default; nobody reads the config until
  // something breaks.
  it("is strict in production and helpful elsewhere", () => {
    const production = defaultsFor("production", "/app");
    expect(production.showDetailedErrors).toBe(false);
    expect(production.forceSsl).toBe(true);

    const development = defaultsFor("development", "/app");
    expect(development.showDetailedErrors).toBe(true);
    expect(development.forceSsl).toBe(false);
    expect(development.database.logQueries).toBe(true);
  });

  it("uses an in-memory database for tests", () => {
    expect(defaultsFor("test", "/app").database.url).toBe("sqlite://:memory:");
  });

  it("lets overrides win", () => {
    const config = buildConfig({
      env: "test",
      secretKeyBase: SECRET,
      server: { port: 4567 },
    });

    expect(config.server.port).toBe(4567);
    expect(config.env).toBe("test");
  });

  // A generated secret would invalidate every session on restart, and a
  // hard-coded one would be shared by every application.
  it("refuses to start in production with no secret", () => {
    expect(() => buildConfig({ env: "production", secretKeyBase: undefined })).toThrow(
      "SECRET_KEY_BASE is required in production",
    );
  });

  it("allows a development default", () => {
    expect(buildConfig({ env: "development" }).secretKeyBase.length).toBeGreaterThanOrEqual(32);
  });
});

describe("boot", () => {
  it("connects the database", async () => {
    const application = await app().boot();
    running = application;

    expect(application.isBooted).toBe(true);
    expect(application.connection.adapter).toBe("sqlite");
  });

  it("refuses the connection before boot", () => {
    expect(() => app().connection).toThrow("not connected yet");
  });

  it("is idempotent", async () => {
    const application = app();
    running = application;

    await application.boot();
    await application.boot();
    expect(application.isBooted).toBe(true);
  });

  it("runs providers in phase order", async () => {
    const order: string[] = [];
    const application = app({
      providers: [
        {
          name: "first",
          register: () => void order.push("register"),
          boot: () => void order.push("boot"),
        },
      ],
    });
    running = application;

    await application.boot();
    expect(order).toEqual(["register", "boot"]);
  });

  it("terminates providers in reverse order", async () => {
    const order: string[] = [];
    const application = app({
      providers: [
        { terminate: () => void order.push("first") },
        { terminate: () => void order.push("second") },
      ],
    });

    await application.boot();
    await application.stop();

    expect(order).toEqual(["second", "first"]);
  });
});

describe("handler", () => {
  it("answers a request end to end", async () => {
    const application = await app().boot();
    running = application;

    const response = await application.handler()(new Request("http://test.host/"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("404s an unknown path", async () => {
    const application = await app().boot();
    running = application;

    expect((await application.handler()(new Request("http://test.host/nope"))).status).toBe(404);
  });

  // Sessions only work if the application's secrets reach every controller.
  it("gives controllers the secrets, so sessions work", async () => {
    const application = await app().boot();
    running = application;
    const handler = application.handler();

    const first = await handler(new Request("http://test.host/counter"));
    expect(await first.json()).toEqual({ visits: 1 });

    const cookie = first.headers.getSetCookie()[0]!.split(";")[0]!;
    const second = await handler(new Request("http://test.host/counter", { headers: { cookie } }));

    expect(await second.json()).toEqual({ visits: 2 });
  });
});

describe("errors", () => {
  it("shows the detail in development", async () => {
    const application = await app({
      env: "development",
      secretKeyBase: SECRET,
      // A development app logs like a development app; this suite does not
      // need two lines per request in among its assertions.
      log: { level: "fatal", format: "text", queries: false },
    }).boot();
    running = application;

    // `localhost` rather than `test.host`: a development application answers
    // only to the hosts a development server actually sees, which is what
    // stops a page on another site reaching this one after re-resolving its
    // own domain to 127.0.0.1.
    const response = await application.handler()(new Request("http://localhost/boom"));

    expect(response.status).toBe(500);
    expect(await response.text()).toContain("kaboom");
  });

  // A stack trace in a production response is an information leak.
  //
  // Requested over https, because production also turns on the forceSsl
  // middleware and a plaintext request would be redirected before it ever
  // reached an action to fail in.
  it("hides the detail in production", async () => {
    const application = await app({
      env: "production",
      secretKeyBase: SECRET,
      log: { level: "fatal", format: "json", queries: false },
    }).boot();
    running = application;

    const response = await application.handler()(new Request("https://test.host/boom"));

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal Server Error");
  });

  it("uses a custom handler when given one", async () => {
    const application = await app().boot();
    running = application;
    application.onError((error) =>
      Response.json({ error: (error as Error).message }, { status: 500 }),
    );

    const response = await application.handler()(new Request("http://test.host/boom"));
    expect(await response.json()).toEqual({ error: "kaboom" });
  });
});

describe("composition", () => {
  it("accepts routes and controllers after construction", async () => {
    const application = createApplication({
      env: "test",
      secretKeyBase: SECRET,
      database: { url: "sqlite://:memory:" },
    });
    running = application;

    application.draw((r) => r.get("late", { to: "home#index" })).register({ home: HomeController });
    await application.boot();

    expect((await application.handler()(new Request("http://test.host/late"))).status).toBe(200);
  });

  it("serves a real request over HTTP", async () => {
    const application = app();
    running = application;

    const server = await application.listen(0);
    const response = await fetch(`http://localhost:${server.port}/`);

    expect(await response.json()).toEqual({ ok: true });
  });
});

describe("middleware", () => {
  it("ships a default stack", () => {
    expect(app().middleware.names).toContain("requestId");
    expect(app().middleware.names).toContain("securityHeaders");
  });

  // Only in production, where the redirect is correct and useful.
  it("adds ssl only when forceSsl is on", () => {
    expect(app().middleware.has("ssl")).toBe(false);
    expect(app({ forceSsl: true }).middleware.has("ssl")).toBe(true);
  });

  it("runs the stack around every request", async () => {
    const application = await app().boot();
    running = application;

    const response = await application.handler()(new Request("http://test.host/"));

    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });

  it("takes an application's own middleware", async () => {
    const seen: string[] = [];
    const application = await app({
      middleware: (stack) =>
        stack.use("audit", async (request, next) => {
          seen.push(new URL(request.url).pathname);
          return await next(request);
        }),
    }).boot();
    running = application;

    await application.handler()(new Request("http://test.host/"));
    expect(seen).toEqual(["/"]);
  });

  it("lets a middleware answer before the router", async () => {
    const application = await app({
      middleware: (stack) =>
        stack.unshift("maintenance", async () => new Response("down", { status: 503 })),
    }).boot();
    running = application;

    const response = await application.handler()(new Request("http://test.host/"));
    expect(response.status).toBe(503);
  });
});

describe("current", () => {
  // Two requests in flight must not see each other's state.
  it("gives every request its own scope", async () => {
    const application = await app().boot();
    running = application;
    const handler = application.handler();

    const [first, second] = await Promise.all([
      handler(new Request("http://test.host/", { headers: { "x-request-id": "one" } })),
      handler(new Request("http://test.host/", { headers: { "x-request-id": "two" } })),
    ]);

    expect(first.headers.get("x-request-id")).toBe("one");
    expect(second.headers.get("x-request-id")).toBe("two");
  });
});
