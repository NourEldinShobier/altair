/**
 * Forcing https, and saying so.
 *
 * Mirrors actionpack/test/dispatch/ssl_test.rb.
 *
 * The redirect and the header do different jobs and neither replaces the
 * other. The redirect turns one plaintext request into an encrypted one. The
 * header stops the plaintext request being made at all — which matters
 * because the plaintext request is the one a network can answer instead.
 */

import { describe, expect, it } from "bun:test";
import { forceSsl } from "../src/middleware.js";

const ok = async () => new Response("ok");

const ask = async (url: string, headers: Record<string, string> = {}, options = {}) =>
  await forceSsl(options)(new Request(url, { headers }), ok);

describe("a plaintext request", () => {
  it("is redirected to https", async () => {
    const response = await ask("http://app.example/orders");

    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("https://app.example/orders");
  });

  // A browser that remembers a 302 is a browser that stops remembering.
  it("is redirected permanently", async () => {
    expect((await ask("http://app.example/")).status).toBe(301);
  });

  it("keeps the path and the query", async () => {
    const response = await ask("http://app.example/search?q=hello&page=2");

    expect(response.headers.get("location")).toBe("https://app.example/search?q=hello&page=2");
  });

  // Behind a load balancer the connection to the application is plaintext and
  // the connection to the user was not.
  it("is left alone when a proxy says it was encrypted", async () => {
    const response = await ask("http://app.example/", { "x-forwarded-proto": "https" });

    expect(response.status).toBe(200);
  });
});

/**
 * The redirect only helps a browser that has already been told once. Somebody
 * typing the bare domain sends plaintext every time that memory expires, and a
 * network that is listening answers instead.
 */
describe("the promise not to speak plaintext", () => {
  it("is made on an encrypted response", async () => {
    const response = await ask("https://app.example/");

    expect(response.headers.get("strict-transport-security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
  });

  it("lasts a year by default, as the preload list requires", async () => {
    expect(await header("https://app.example/")).toContain("max-age=31536000");
  });

  it("covers subdomains, which is where the forgotten host lives", async () => {
    expect(await header("https://app.example/")).toContain("includeSubDomains");
  });

  it("takes a different age", async () => {
    expect(await header("https://app.example/", {}, { maxAge: 300 })).toContain("max-age=300");
  });

  it("can leave subdomains out", async () => {
    expect(await header("https://app.example/", {}, { includeSubDomains: false })).not.toContain(
      "includeSubDomains",
    );
  });

  /**
   * Getting a domain onto the preload list is a form submission and getting it
   * off again takes months, during which every subdomain must speak https or
   * be unreachable. Not something to be opted into by default.
   */
  it("does not ask for preloading unless asked", async () => {
    expect(await header("https://app.example/")).not.toContain("preload");
    expect(await header("https://app.example/", {}, { preload: true })).toContain("preload");
  });

  it("does not overwrite one the application set itself", async () => {
    const response = await forceSsl()(
      new Request("https://app.example/"),
      async () => new Response("ok", { headers: { "strict-transport-security": "max-age=60" } }),
    );

    expect(response.headers.get("strict-transport-security")).toBe("max-age=60");
  });

  it("leaves the response otherwise alone", async () => {
    const response = await ask("https://app.example/");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });
});

/**
 * A year of refusing plaintext on `localhost` would apply to every project on
 * the machine that uses the name, and there is no way to serve https there
 * without a certificate somebody has to make.
 */
describe("on a developer's own machine", () => {
  it("does not redirect", async () => {
    expect((await ask("http://localhost:3000/")).status).toBe(200);
    expect((await ask("http://127.0.0.1:3000/")).status).toBe(200);
  });

  it("makes no promise it would be stuck with", async () => {
    const response = await ask("http://localhost:3000/");

    expect(response.headers.get("strict-transport-security")).toBeNull();
  });
});

/** The header, for the cases that only care about it. */
async function header(
  url: string,
  headers: Record<string, string> = {},
  options = {},
): Promise<string> {
  return (await ask(url, headers, options)).headers.get("strict-transport-security") ?? "";
}
