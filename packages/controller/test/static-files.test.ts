/**
 * Serving files from a directory.
 *
 * Mirrors actionpack/test/dispatch/static_test.rb.
 *
 * The whole subject is which files it will *not* serve. A static server that
 * joins a request path onto a directory and opens the result will serve
 * `/../../etc/passwd`, and that has been the defect in a great many of them —
 * so most of what follows is the refusals.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveStaticPath, serveStatic } from "../src/static-files.js";

let root: string;
let outside: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "altair-static-"));
  mkdirSync(join(root, "assets"));

  await Bun.write(join(root, "index.html"), "<h1>home</h1>");
  await Bun.write(join(root, "assets", "app.css"), "body{}");
  await Bun.write(join(root, "assets", "index.html"), "assets index");

  // A file the server must never reach, one level above the root.
  outside = join(root, "..", "altair-static-secret.txt");
  await Bun.write(outside, "SECRET");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { force: true });
});

const ask = async (path: string, method = "GET") =>
  await serveStatic({ root })(
    new Request(`http://test.host${path}`, { method }),
    async () => new Response("the application", { status: 404 }),
  );

describe("a path it will serve", () => {
  it("resolves a file", () => {
    expect(resolveStaticPath("/assets/app.css")).toBe("assets/app.css");
  });

  it("resolves the root to the index", () => {
    expect(resolveStaticPath("/")).toBe("index.html");
  });

  it("resolves a directory to its index", () => {
    expect(resolveStaticPath("/assets/")).toBe("assets/index.html");
  });
});

/**
 * Each of these has been a working exploit against some static server.
 */
describe("a path it will not", () => {
  it("refuses a plain climb", () => {
    expect(resolveStaticPath("/../secret.txt")).toBeNull();
    expect(resolveStaticPath("/a/../../secret.txt")).toBeNull();
  });

  it("refuses one that is encoded", () => {
    expect(resolveStaticPath("/..%2Fsecret.txt")).toBeNull();
    expect(resolveStaticPath("/%2e%2e/secret.txt")).toBeNull();
    expect(resolveStaticPath("/%2E%2E%2Fsecret.txt")).toBeNull();
  });

  // A backslash separates on Windows and is an ordinary character in a URL, so
  // this climbs on the platform where it matters and reads as a filename to a
  // check that only looks for slashes.
  it("refuses a Windows separator", () => {
    expect(resolveStaticPath("/a\\..\\secret.txt")).toBeNull();
    expect(resolveStaticPath("/..\\secret.txt")).toBeNull();
  });

  it("refuses a null byte", () => {
    expect(resolveStaticPath("/index.html%00.txt")).toBeNull();
  });

  it("refuses an escape that is not one", () => {
    expect(resolveStaticPath("/%zz")).toBeNull();
  });

  // `.` is harmless and a browser never sends it, so it is refused with
  // everything else rather than specially allowed.
  it("refuses a single dot segment", () => {
    expect(resolveStaticPath("/./index.html")).toBeNull();
  });
});

describe("the middleware", () => {
  it("serves a file that is there", async () => {
    const response = await ask("/assets/app.css");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("body{}");
  });

  it("says what the file is", async () => {
    expect((await ask("/assets/app.css")).headers.get("content-type")).toBe(
      "text/css; charset=utf-8",
    );
    expect((await ask("/")).headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("serves the index for the root", async () => {
    expect(await (await ask("/")).text()).toBe("<h1>home</h1>");
  });

  // Not a 403: an attempt to climb and a path that is simply not a file get
  // the same answer, so nothing tells an attacker which guess was interesting.
  it("hands a climb to the application, like any other unknown path", async () => {
    const climbed = await ask("/../altair-static-secret.txt");

    expect(climbed.status).toBe(404);
    expect(await climbed.text()).toBe("the application");
  });

  it("never returns the file above the root", async () => {
    for (const path of [
      "/../altair-static-secret.txt",
      "/..%2Faltair-static-secret.txt",
      "/assets/../../altair-static-secret.txt",
    ]) {
      expect(await (await ask(path)).text()).not.toContain("SECRET");
    }
  });

  it("gets out of the way when there is no such file", async () => {
    expect(await (await ask("/nothing-here.txt")).text()).toBe("the application");
  });

  it("answers HEAD with the headers and no body", async () => {
    const response = await ask("/", "HEAD");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(response.headers.get("content-length")).toBe("13");
  });

  // A POST to a path that happens to name a file is a request for the
  // application, not for the file.
  it("leaves anything that is not a GET or HEAD alone", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const response = await serveStatic({ root })(
        new Request("http://test.host/index.html", { method }),
        async () => new Response("the application"),
      );

      expect(await response.text()).toBe("the application");
    }
  });

  it("sets a cache header, and takes one", async () => {
    expect((await ask("/")).headers.get("cache-control")).toBe("public, max-age=3600");

    const custom = await serveStatic({ root, cacheControl: "no-store" })(
      new Request("http://test.host/"),
      async () => new Response("x"),
    );

    expect(custom.headers.get("cache-control")).toBe("no-store");
  });
});
