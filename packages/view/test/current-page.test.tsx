/**
 * Whether a link points at the page being rendered, ported from the
 * `current_page?` cases in `actionview/test/template/url_helper_test.rb`.
 *
 * Compared on path alone, a link to another host reads as current — and
 * `LinkToUnlessCurrent` then renders that external link as plain text,
 * dropping it from the page entirely.
 */

import { describe, expect, it } from "bun:test";
import { Current } from "@altair/support";
import { LinkToUnlessCurrent, currentPageAttributes, isCurrentPage } from "../src/assets.js";
import { RawHtml, type Node } from "../src/render.js";

/** Renders a body as though a request for `url` were being served. */
async function onPage<T>(url: string, body: () => T): Promise<T> {
  return await Current.run({ request: new Request(url) }, async () => body());
}

const html = (node: Node): string => (node as RawHtml).value;

describe("isCurrentPage", () => {
  it("is true for the page being rendered", async () => {
    expect(await onPage("https://app.test/posts", () => isCurrentPage("/posts"))).toBe(true);
  });

  it("is false for another page", async () => {
    expect(await onPage("https://app.test/posts", () => isCurrentPage("/about"))).toBe(false);
  });

  it("ignores a trailing slash on either side", async () => {
    expect(await onPage("https://app.test/posts/", () => isCurrentPage("/posts"))).toBe(true);
    expect(await onPage("https://app.test/posts", () => isCurrentPage("/posts/"))).toBe(true);
  });

  it("is true for the root", async () => {
    expect(await onPage("https://app.test/", () => isCurrentPage("/"))).toBe(true);
  });

  /** The fix. A link elsewhere is never this page, however the paths line up. */
  it("is false for the same path on another host", async () => {
    expect(
      await onPage("https://app.test/posts", () => isCurrentPage("https://elsewhere.test/posts")),
    ).toBe(false);
  });

  it("is false for the same path over another scheme", async () => {
    expect(
      await onPage("https://app.test/posts", () => isCurrentPage("http://app.test/posts")),
    ).toBe(false);
  });

  it("is true for an absolute url naming this host", async () => {
    expect(
      await onPage("https://app.test/posts", () => isCurrentPage("https://app.test/posts")),
    ).toBe(true);
  });

  /** `/posts?page=2` is still the posts page; a nav that unmarks it looks broken. */
  it("ignores the query by default", async () => {
    expect(await onPage("https://app.test/posts?page=2", () => isCurrentPage("/posts"))).toBe(true);
  });

  it("compares the query when asked", async () => {
    expect(
      await onPage("https://app.test/posts?page=2", () =>
        isCurrentPage("/posts?page=2", { matchQuery: true }),
      ),
    ).toBe(true);

    expect(
      await onPage("https://app.test/posts?page=2", () =>
        isCurrentPage("/posts?page=3", { matchQuery: true }),
      ),
    ).toBe(false);
  });

  /** The same filter written in another order is the same filter. */
  it("does not mind the order of the query", async () => {
    expect(
      await onPage("https://app.test/posts?b=2&a=1", () =>
        isCurrentPage("/posts?a=1&b=2", { matchQuery: true }),
      ),
    ).toBe(true);
  });

  it("marks a section current for a page inside it when asked", async () => {
    expect(
      await onPage("https://app.test/posts/1", () =>
        isCurrentPage("/posts", { matchPrefix: true }),
      ),
    ).toBe(true);
  });

  /** Segment-wise, so `/post` is not a prefix of `/posts`. */
  it("does not treat a partial segment as a prefix", async () => {
    expect(
      await onPage("https://app.test/posts", () => isCurrentPage("/post", { matchPrefix: true })),
    ).toBe(false);
  });

  it("does not match a prefix unless asked", async () => {
    expect(await onPage("https://app.test/posts/1", () => isCurrentPage("/posts"))).toBe(false);
  });

  /** A component rendered in a test with no request is not a bug. */
  it("is false with no request at all", () => {
    expect(isCurrentPage("/posts")).toBe(false);
  });

  it("is false for a target that is not a url", async () => {
    expect(await onPage("https://app.test/posts", () => isCurrentPage("http://"))).toBe(false);
  });
});

describe("currentPageAttributes", () => {
  /**
   * Without aria-current a nav reads as a run of identical links, and the
   * highlight a sighted reader sees conveys nothing.
   */
  it("marks the current page for a screen reader", async () => {
    expect(await onPage("https://app.test/posts", () => currentPageAttributes("/posts"))).toEqual({
      "aria-current": "page",
    });
  });

  it("adds a class when given one", async () => {
    expect(
      await onPage("https://app.test/posts", () =>
        currentPageAttributes("/posts", { class: "active" }),
      ),
    ).toEqual({ "aria-current": "page", class: "active" });
  });

  it("gives nothing for another page", async () => {
    expect(await onPage("https://app.test/posts", () => currentPageAttributes("/about"))).toEqual(
      {},
    );
  });

  it("follows the same options", async () => {
    expect(
      await onPage("https://app.test/posts/1", () =>
        currentPageAttributes("/posts", { matchPrefix: true }),
      ),
    ).toEqual({ "aria-current": "page" });
  });
});

describe("LinkToUnlessCurrent", () => {
  it("renders plain words on the page it points at", async () => {
    const rendered = await onPage("https://app.test/posts", () =>
      html(LinkToUnlessCurrent({ href: "/posts", text: "Posts" })),
    );

    expect(rendered).toBe("Posts");
  });

  it("renders a link anywhere else", async () => {
    const rendered = await onPage("https://app.test/about", () =>
      html(LinkToUnlessCurrent({ href: "/posts", text: "Posts" })),
    );

    expect(rendered).toContain('href="/posts"');
  });

  /** It used to lose an external link that happened to share a path. */
  it("keeps a link to another host", async () => {
    const rendered = await onPage("https://app.test/posts", () =>
      html(LinkToUnlessCurrent({ href: "https://elsewhere.test/posts", text: "Elsewhere" })),
    );

    expect(rendered).toContain("https://elsewhere.test/posts");
  });
});
