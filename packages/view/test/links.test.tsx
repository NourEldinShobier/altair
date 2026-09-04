/**
 * Links, buttons and layout content.
 *
 * Mirrors actionview/test/template/url_helper_test.rb and
 * capture_helper_test.rb. Two tests here are about consequences rather than
 * output: a destructive action behind a GET link, and a layout that renders
 * before the page it wraps.
 */

import { describe, expect, it } from "bun:test";
import { Current } from "@altair/support";
import { renderToString } from "../src/render.js";
import { ButtonTo, Link } from "../src/links.js";
import {
  hasContentFor,
  contentFor,
  provide,
  renderWithLayout,
  withContentStore,
  yieldContent,
} from "../src/content-for.js";

const withCsrf = async <T,>(body: () => Promise<T>): Promise<T> =>
  await Current.run({ request: new Request("http://test.host/"), csrfToken: "tok3n" }, body);

describe("a link", () => {
  it("is an anchor", async () => {
    expect(await renderToString(<Link to="/posts">All posts</Link>)).toBe(
      '<a href="/posts">All posts</a>',
    );
  });

  it("passes anything else through", async () => {
    expect(
      await renderToString(
        <Link to="/posts" class="nav">
          x
        </Link>,
      ),
    ).toContain('class="nav"');
  });

  // A page opened with `target` can reach back through `window.opener` and
  // navigate the page that opened it.
  it("closes the opener when it opens elsewhere", async () => {
    const html = await renderToString(
      <Link to="https://example.com" target="_blank">
        x
      </Link>,
    );

    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("leaves a rel that was given alone", async () => {
    const html = await renderToString(
      <Link to="https://example.com" target="_blank" rel="me">
        x
      </Link>,
    );

    expect(html).toContain('rel="me"');
  });

  it("adds nothing when it opens in place", async () => {
    expect(await renderToString(<Link to="/posts">x</Link>)).not.toContain("rel=");
  });
});

// The one that carries weight. A destructive action reached by a link is one a
// crawler will follow, a prefetcher will warm, and a browser will replay on
// back — GET is defined as safe and the whole web assumes it.
describe("a button that posts", () => {
  it("is a form, not a link", async () => {
    const html = await withCsrf(async () =>
      renderToString(<ButtonTo to="/posts/1">Delete</ButtonTo>),
    );

    expect(html).toStartWith("<form");
    expect(html).not.toContain("<a ");
  });

  // A browser sends only GET and POST from a form, so anything else travels
  // as `_method`, which is what the router already reads.
  it("posts, and carries the real method alongside", async () => {
    const html = await withCsrf(async () =>
      renderToString(
        <ButtonTo to="/posts/1" method="delete">
          Delete
        </ButtonTo>,
      ),
    );

    expect(html).toContain('method="post"');
    expect(html).toContain('name="_method" value="delete"');
  });

  it("does not add _method for a plain post", async () => {
    const html = await withCsrf(async () => renderToString(<ButtonTo to="/posts">New</ButtonTo>));

    expect(html).not.toContain("_method");
  });

  // A form that posts without a token is a form that fails, and remembering it
  // at each call site is how one gets forgotten.
  it("includes the token without being asked", async () => {
    const html = await withCsrf(async () =>
      renderToString(
        <ButtonTo to="/posts/1" method="delete">
          x
        </ButtonTo>,
      ),
    );

    expect(html).toContain('name="authenticity_token" value="tok3n"');
  });

  // On a GET the token would land in the query string, and from there in the
  // history, the server log and any referrer.
  it("leaves the token off a GET", async () => {
    const html = await withCsrf(async () =>
      renderToString(
        <ButtonTo to="/search" method="get">
          Search
        </ButtonTo>,
      ),
    );

    expect(html).toContain('method="get"');
    expect(html).not.toContain("authenticity_token");
  });

  it("carries extra fields", async () => {
    const html = await withCsrf(async () =>
      renderToString(
        <ButtonTo to="/posts/1" method="patch" params={{ status: "published" }}>
          Publish
        </ButtonTo>,
      ),
    );

    expect(html).toContain('name="status" value="published"');
  });

  it("renders without a request, for a test or a static page", async () => {
    const html = await renderToString(<ButtonTo to="/posts/1">x</ButtonTo>);

    expect(html).toContain("<form");
    expect(html).not.toContain("authenticity_token");
  });
});

describe("content for a layout", () => {
  it("comes back out", async () => {
    await withContentStore(async () => {
      contentFor("title", "All posts");

      expect(yieldContent("title")).toBe("All posts");
      expect(hasContentFor("title")).toBe(true);
    });
  });

  it("is undefined when nothing provided it", async () => {
    await withContentStore(async () => {
      expect(yieldContent("title")).toBeUndefined();
      expect(hasContentFor("title")).toBe(false);
    });
  });

  // A page and a partial inside it both adding to `head` is what the appending
  // is for.
  it("appends rather than replacing", async () => {
    await withContentStore(async () => {
      contentFor("head", "a");
      contentFor("head", "b");

      expect(yieldContent("head")).toEqual(["a", "b"]);
    });
  });

  it("can replace instead", async () => {
    await withContentStore(async () => {
      contentFor("title", "first");
      provide("title", "second");

      expect(yieldContent("title")).toBe("second");
    });
  });

  // A component used in a test without a layout is not a bug.
  it("says nothing outside a render", () => {
    expect(() => contentFor("title", "x")).not.toThrow();
    expect(yieldContent("title")).toBeUndefined();
  });

  // Two requests rendering at once must not see each other's title.
  it("keeps concurrent renders apart", async () => {
    const [one, two] = await Promise.all([
      withContentStore(async () => {
        contentFor("title", "slow");
        await new Promise((resolve) => setTimeout(resolve, 5));
        return yieldContent("title");
      }),
      withContentStore(async () => {
        contentFor("title", "fast");
        return yieldContent("title");
      }),
    ]);

    expect(one).toBe("slow");
    expect(two).toBe("fast");
  });
});

// The reason `renderWithLayout` exists rather than `<Layout><Page /></Layout>`.
// A layout wraps a page, so in JSX it runs first — and the naive nesting reads
// a store the page has not filled in yet, and quietly renders nothing.
describe("rendering a page inside a layout", () => {
  function Page() {
    contentFor("title", "All posts");
    return <p>body</p>;
  }

  function Layout({ children }: { children: unknown }) {
    return (
      <html>
        <head>
          <title>{(yieldContent("title") as string) ?? "MISSING"}</title>
        </head>
        <body>{children as never}</body>
      </html>
    );
  }

  it("lets the page reach the layout", async () => {
    const html = await renderWithLayout(<Page />, Layout as never);

    expect(html).toContain("<title>All posts</title>");
    expect(html).toContain("<p>body</p>");
  });

  it("renders the page before the layout, which is the whole point", async () => {
    const order: string[] = [];

    function Ordered() {
      order.push("page");
      return <p>x</p>;
    }

    function Wrapper({ children }: { children: unknown }) {
      order.push("layout");
      return <div>{children as never}</div>;
    }

    await renderWithLayout(<Ordered />, Wrapper as never);

    expect(order).toEqual(["page", "layout"]);
  });

  // Nesting them the obvious way is what does not work, and it is worth having
  // that written down rather than rediscovered.
  it("is not what plain nesting does", async () => {
    const html = await withContentStore(async () =>
      renderToString(
        <Layout>
          <Page />
        </Layout>,
      ),
    );

    expect(html).toContain("<title>MISSING</title>");
  });
});
