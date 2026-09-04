/**
 * Refusing a Host header this application does not answer to.
 *
 * Mirrors actionpack/test/dispatch/host_authorization_test.rb.
 *
 * Two attacks start here. DNS rebinding is aimed at a development machine: a
 * page on the attacker's site re-resolves their own domain to 127.0.0.1 after
 * loading, and the browser then talks to the server on your laptop with their
 * origin's cookies, because as far as it is concerned nothing changed. The
 * other works anywhere — an application that builds a password reset link from
 * the Host header sends the user a link to whatever host was asked for.
 */

import { describe, expect, it } from "bun:test";
import { hostAuthorization } from "../src/middleware.js";

const ok = async () => new Response("ok");

const ask = async (
  host: string,
  allowed: readonly (string | RegExp)[],
  path = "/",
  exclude?: (path: string) => boolean,
) => {
  const middleware = hostAuthorization({ allowed, exclude });

  return await middleware(new Request(`http://${host}${path}`, { headers: { host } }), ok);
};

describe("a host on the list", () => {
  it("gets through", async () => {
    expect((await ask("example.com", ["example.com"])).status).toBe(200);
  });

  it("gets through whatever its case", async () => {
    expect((await ask("EXAMPLE.com", ["example.com"])).status).toBe(200);
  });

  // A browser sends a port whenever the server is not on 80 or 443, which in
  // development is always. A rule naming the host has to match anyway.
  it("gets through with a port on it", async () => {
    expect((await ask("localhost:3000", ["localhost"])).status).toBe(200);
  });

  it("matches any of several rules", async () => {
    expect((await ask("127.0.0.1", ["localhost", "127.0.0.1"])).status).toBe(200);
  });
});

describe("a host that is not", () => {
  it("is refused", async () => {
    expect((await ask("evil.example", ["example.com"])).status).toBe(403);
  });

  it("says which host it refused", async () => {
    expect(await (await ask("evil.example", ["example.com"])).text()).toContain("evil.example");
  });

  // The two that a naive `endsWith` or `includes` would wave through.
  it("is refused when it merely ends with an allowed name", async () => {
    expect((await ask("notexample.com", ["example.com"])).status).toBe(403);
  });

  it("is refused when it merely contains one", async () => {
    expect((await ask("example.com.evil.test", ["example.com"])).status).toBe(403);
  });
});

describe("a subdomain rule", () => {
  it("allows anything under the domain", async () => {
    expect((await ask("app.example.com", [".example.com"])).status).toBe(200);
    expect((await ask("a.b.example.com", [".example.com"])).status).toBe(200);
  });

  // Rails reads `.example.com` as covering the bare domain too, which is what
  // people mean when they write it.
  it("allows the domain itself", async () => {
    expect((await ask("example.com", [".example.com"])).status).toBe(200);
  });

  it("does not allow a domain that only ends the same way", async () => {
    expect((await ask("notexample.com", [".example.com"])).status).toBe(403);
  });
});

describe("a pattern", () => {
  it("is matched against the host", async () => {
    expect((await ask("app-42.example.com", [/^app-\d+\.example\.com$/])).status).toBe(200);
    expect((await ask("app-x.example.com", [/^app-\d+\.example\.com$/])).status).toBe(403);
  });
});

describe("an empty list", () => {
  // What Rails does when `config.hosts` is empty, and what this defaults to
  // outside development.
  it("answers to anything", async () => {
    expect((await ask("anything.example", [])).status).toBe(200);
  });
});

describe("an excluded path", () => {
  // A load balancer's health check arrives with whatever Host the balancer
  // uses, which is rarely the application's own.
  it("answers whatever the Host says", async () => {
    const exclude = (path: string) => path === "/up";

    expect((await ask("10.0.0.1", ["example.com"], "/up", exclude)).status).toBe(200);
  });

  it("still guards everything else", async () => {
    const exclude = (path: string) => path === "/up";

    expect((await ask("10.0.0.1", ["example.com"], "/admin", exclude)).status).toBe(403);
  });
});
