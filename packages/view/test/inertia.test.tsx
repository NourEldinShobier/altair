/**
 * Inertia protocol suite.
 *
 * Asserts the wire behaviour described at https://inertiajs.com/the-protocol,
 * since that is the contract other adapters implement.
 */

import { describe, expect, it } from "bun:test";
import {
  INERTIA_HEADER,
  LOCATION_HEADER,
  PARTIAL_COMPONENT_HEADER,
  PARTIAL_DATA_HEADER,
  inertiaLocation,
  inertiaRedirect,
  isInertiaRequest,
  lazy,
  renderInertia,
  resolveProps,
} from "../src/inertia.js";
import { renderDocument } from "../src/render.js";

function visit(headers: Record<string, string> = {}, method = "GET"): Request {
  return new Request("http://test.host/posts?page=2", {
    method,
    headers: { [INERTIA_HEADER]: "true", ...headers },
  });
}

function firstLoad(): Request {
  return new Request("http://test.host/posts?page=2");
}

describe("request detection", () => {
  it("recognizes an Inertia visit", () => {
    expect(isInertiaRequest(visit())).toBe(true);
    expect(isInertiaRequest(firstLoad())).toBe(false);
  });
});

describe("first load", () => {
  it("returns HTML with the page object embedded", async () => {
    const response = await renderInertia(firstLoad(), "Posts/Index", { total: 3 });

    expect(response.headers.get("content-type")).toContain("text/html");

    const html = await response.text();
    expect(html).toStartWith("<!DOCTYPE html>");
    expect(html).toContain('id="app"');
    expect(html).toContain("Posts/Index");
  });

  it("uses a custom root layout", async () => {
    const response = await renderInertia(
      firstLoad(),
      "Posts/Index",
      {},
      {
        rootLayout: (page) => (
          <html lang="en">
            <body>
              <div id="root" data-page={JSON.stringify(page)} />
            </body>
          </html>
        ),
      },
    );

    expect(await response.text()).toContain('id="root"');
  });

  // The page object must survive being written into an attribute.
  it("escapes the page object in the markup", async () => {
    const response = await renderInertia(firstLoad(), "Posts/Index", {
      title: '"><script>alert(1)</script>',
    });
    const html = await response.text();

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("visits", () => {
  it("returns the page object as JSON", async () => {
    const response = await renderInertia(visit(), "Posts/Index", { total: 3 });

    expect(response.headers.get(INERTIA_HEADER)).toBe("true");
    expect(response.headers.get("vary")).toBe(INERTIA_HEADER);

    expect(await response.json()).toEqual({
      component: "Posts/Index",
      props: { total: 3 },
      url: "/posts?page=2",
      version: null,
    });
  });

  it("carries the asset version", async () => {
    const response = await renderInertia(visit(), "Posts/Index", {}, { version: "abc123" });
    expect((await response.json()).version).toBe("abc123");
  });

  it("merges shared props under page props", async () => {
    const response = await renderInertia(
      visit(),
      "Posts/Index",
      { total: 3 },
      { shared: { user: "ada", total: 0 } },
    );

    expect((await response.json()).props).toEqual({ user: "ada", total: 3 });
  });

  it("awaits promised props", async () => {
    const response = await renderInertia(visit(), "Posts/Index", {
      posts: Promise.resolve([{ id: 1 }]),
    });

    expect((await response.json()).props).toEqual({ posts: [{ id: 1 }] });
  });
});

describe("partial reloads", () => {
  it("returns only the requested props", async () => {
    const request = visit({
      [PARTIAL_COMPONENT_HEADER]: "Posts/Index",
      [PARTIAL_DATA_HEADER]: "total",
    });

    const props = await resolveProps(request, "Posts/Index", { total: 3, posts: [1, 2, 3] });
    expect(props).toEqual({ total: 3 });
  });

  // A partial reload naming a different component is a full reload.
  it("ignores the partial headers for another component", async () => {
    const request = visit({
      [PARTIAL_COMPONENT_HEADER]: "Posts/Show",
      [PARTIAL_DATA_HEADER]: "total",
    });

    const props = await resolveProps(request, "Posts/Index", { total: 3, posts: [] });
    expect(Object.keys(props).sort()).toEqual(["posts", "total"]);
  });

  it("skips a lazy prop unless it is named", async () => {
    let evaluated = false;
    const stats = lazy(() => {
      evaluated = true;
      return { count: 1 };
    });

    const full = await resolveProps(visit(), "Posts/Index", { total: 3, stats });
    expect(full).toEqual({ total: 3 });
    expect(evaluated).toBe(false);

    const partial = await resolveProps(
      visit({ [PARTIAL_COMPONENT_HEADER]: "Posts/Index", [PARTIAL_DATA_HEADER]: "stats" }),
      "Posts/Index",
      { total: 3, stats },
    );
    expect(partial).toEqual({ stats: { count: 1 } });
    expect(evaluated).toBe(true);
  });
});

describe("redirects", () => {
  // A visit is an XHR, so 302 after PATCH would repeat the method.
  it("uses 303 after a mutating method", () => {
    expect(inertiaRedirect(visit({}, "PUT"), "/posts").status).toBe(303);
    expect(inertiaRedirect(visit({}, "PATCH"), "/posts").status).toBe(303);
    expect(inertiaRedirect(visit({}, "DELETE"), "/posts").status).toBe(303);
  });

  it("uses 302 otherwise", () => {
    expect(inertiaRedirect(visit({}, "GET"), "/posts").status).toBe(302);
    expect(inertiaRedirect(visit({}, "POST"), "/posts").status).toBe(302);
  });

  it("sets the location header", () => {
    expect(inertiaRedirect(visit(), "/posts").headers.get("location")).toBe("/posts");
  });

  // A visit cannot follow a cross-origin redirect, so the protocol uses 409.
  it("sends an external redirect as 409", () => {
    const response = inertiaLocation("https://example.com");

    expect(response.status).toBe(409);
    expect(response.headers.get(LOCATION_HEADER)).toBe("https://example.com");
  });
});

describe("root layout rendering", () => {
  it("renders a realistic document", async () => {
    const html = await renderDocument(
      <html lang="en">
        <head>
          <title>Posts</title>
        </head>
        <body>
          <div id="app" />
        </body>
      </html>,
    );

    expect(html).toBe(
      '<!DOCTYPE html><html lang="en"><head><title>Posts</title></head><body><div id="app"></div></body></html>',
    );
  });
});
