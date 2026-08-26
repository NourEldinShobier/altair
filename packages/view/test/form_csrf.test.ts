/**
 * A form and the token it has to carry.
 *
 * `useCsrfToken` existed so a form deep in a partial could reach the token
 * without being handed it — its own comment says exactly that — and `FormWith`
 * never called it. So every form written without passing the token by hand
 * rendered without one, and its POST came back 422: the protection working
 * precisely as designed, against the application's own pages.
 *
 * Nothing short of rendering a form inside a request would have caught it. The
 * form helper had passing tests, the CSRF check had passing tests, and neither
 * knew about the other.
 */

import { describe, expect, it } from "bun:test";
import { Current } from "@altair/support";
import { FormWith } from "../src/form.js";
import { renderToString } from "../src/render.js";

/** Renders inside a request that carries a token, as a controller does. */
const inRequest = async (token: string | undefined, node: () => unknown): Promise<string> =>
  await Current.run({ csrfToken: token } as never, async () =>
    renderToString((await node()) as never),
  );

describe("a form rendered in a request", () => {
  it("carries the token without being handed one", async () => {
    const html = await inRequest("abc123", () => FormWith({ url: "/posts", children: () => null }));

    expect(html).toContain('name="authenticity_token"');
    expect(html).toContain('value="abc123"');
  });

  it("takes one it was handed over the request's", async () => {
    const html = await inRequest("abc123", () =>
      FormWith({ url: "/posts", authenticityToken: "explicit", children: () => null }),
    );

    expect(html).toContain('value="explicit"');
    expect(html).not.toContain("abc123");
  });

  /**
   * A GET changes nothing, so it needs no token — and putting one in a query
   * string leaves it in browser history and in every server log along the way.
   */
  it("leaves it out of a GET", async () => {
    const html = await inRequest("abc123", () =>
      FormWith({ url: "/search", method: "get", children: () => null }),
    );

    expect(html).not.toContain("authenticity_token");
  });

  it("puts it on a patch, which is sent as a post", async () => {
    const html = await inRequest("abc123", () =>
      FormWith({ url: "/posts/1", method: "patch", children: () => null }),
    );

    expect(html).toContain('name="authenticity_token"');
    expect(html).toContain('name="_method"');
  });

  // For the rare form that posts somewhere else, where sending the token would
  // be handing it to another origin.
  it("can be told to leave it out", async () => {
    const html = await inRequest("abc123", () =>
      FormWith({ url: "https://elsewhere.example", authenticityToken: null, children: () => null }),
    );

    expect(html).not.toContain("authenticity_token");
  });

  it("renders without one when the request has none", async () => {
    const html = await inRequest(undefined, () =>
      FormWith({ url: "/posts", children: () => null }),
    );

    expect(html).not.toContain("authenticity_token");
  });
});
