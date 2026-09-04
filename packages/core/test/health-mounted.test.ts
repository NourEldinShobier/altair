/**
 * `/up`, on the stack rather than as a function.
 *
 * `healthCheck` was written, tested, and never added to the default stack —
 * while `hostAuthorization` in that same stack excluded `/up` from its host
 * rules so a load balancer checking by IP would not be turned away. The
 * exclusion was there for an endpoint that answered 404.
 */

import { describe, expect, it } from "bun:test";
import { createApplication } from "../src/index.js";

const application = (options: Record<string, unknown> = {}) =>
  createApplication({
    secretKeyBase: "x".repeat(64),
    database: { url: "sqlite://:memory:" },
    routes: () => undefined,
    ...options,
  });

describe("the health endpoint", () => {
  it("answers once the application has booted", async () => {
    const app = application();
    await app.boot();

    const response = await app.handler()(new Request("https://app.example/up"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  // A cached health check is a load balancer reading a reply from before the
  // thing it is checking broke.
  it("is never cached", async () => {
    const app = application();
    await app.boot();

    const response = await app.handler()(new Request("https://app.example/up"));

    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  /**
   * The failure that looks healthiest from outside: the process is up and
   * answering, and every request that touches the database is failing.
   */
  it("fails when the database does", async () => {
    const app = application();
    await app.boot();
    await app.connection.close();

    const response = await app.handler()(new Request("https://app.example/up"));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "error", failed: ["database"] });
  });

  // Before boot there is no connection, and a check that throws is a check
  // that fails for the wrong reason.
  it("reports unhealthy rather than throwing before boot", async () => {
    const response = await application().handler()(new Request("https://app.example/up"));

    expect(response.status).toBe(503);
  });

  it("can be left to the application", async () => {
    const app = application({ healthCheck: false });
    await app.boot();

    expect((await app.handler()(new Request("https://app.example/up"))).status).toBe(404);
  });
});
