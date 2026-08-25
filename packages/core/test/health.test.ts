/**
 * The health check.
 *
 * Mirrors railties/test/application/health_controller_test.rb. The tests that
 * matter are the ones about what it deliberately does *not* check: a health
 * check that touches a shared dependency takes every instance out of rotation
 * at once, which is a much worse outage than the blip that caused it.
 */

import { describe, expect, it } from "bun:test";
import { healthCheck } from "../src/health.js";

const fellThrough = new Response("fell through", { status: 404 });

const call = async (path: string, options = {}) =>
  await healthCheck(options)(new Request(`http://test.host${path}`), async () => fellThrough);

const body = async (response: Response) =>
  (await response.json()) as { status: string; failed?: string[] };

describe("with nothing to check", () => {
  // The question it answers: did this process boot and can it serve a request.
  it("says it is up", async () => {
    const response = await call("/up");

    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ status: "ok" });
  });

  it("passes anything else along", async () => {
    expect(await (await call("/posts")).text()).toBe("fell through");
  });

  it("can be moved", async () => {
    expect((await call("/healthz", { path: "/healthz" })).status).toBe(200);
    expect((await call("/up", { path: "/healthz" })).status).toBe(404);
  });

  // A cached health check is a load balancer reading a reply from before the
  // thing it is checking broke.
  it("is never cached", async () => {
    expect((await call("/up")).headers.get("cache-control")).toBe("no-store");
  });
});

describe("with checks", () => {
  it("passes when they all pass", async () => {
    const response = await call("/up", {
      checks: { disk: () => true, migrations: async () => true },
    });

    expect(response.status).toBe(200);
  });

  it("fails with 503 when one does not", async () => {
    const response = await call("/up", { checks: { disk: () => true, queue: () => false } });

    expect(response.status).toBe(503);
    expect(await body(response)).toEqual({ status: "error", failed: ["queue"] });
  });

  it("counts a check that throws as failed", async () => {
    const response = await call("/up", {
      checks: {
        queue: () => {
          throw new Error("connection refused to 10.0.1.7:5432");
        },
      },
    });

    expect(response.status).toBe(503);
  });

  // The endpoint is usually reachable from outside, and the shape of the
  // internal network is not something to publish on it.
  it("names what failed and nothing about why", async () => {
    const response = await call("/up", {
      checks: {
        queue: () => {
          throw new Error("connection refused to 10.0.1.7:5432");
        },
      },
    });

    expect(await response.text()).not.toContain("10.0.1.7");
  });

  it("lists every failure, not just the first", async () => {
    const response = await call("/up", {
      checks: { a: () => false, b: () => true, c: () => false },
    });

    expect((await body(response)).failed).toEqual(["a", "c"]);
  });

  // Without a timeout, a health endpoint waiting on a wedged connection stops
  // answering at all — and a load balancer reads no answer the same way it
  // reads a failure, after waiting out its own much longer timeout.
  it("treats a check that hangs as failed", async () => {
    const response = await call("/up", {
      timeout: 20,
      checks: { wedged: () => new Promise<boolean>(() => {}) },
    });

    expect(response.status).toBe(503);
    expect((await body(response)).failed).toEqual(["wedged"]);
  });

  it("does not wait for a slow check any longer than it was told to", async () => {
    const started = Date.now();

    await call("/up", { timeout: 20, checks: { slow: () => new Promise<boolean>(() => {}) } });

    expect(Date.now() - started).toBeLessThan(500);
  });
});
