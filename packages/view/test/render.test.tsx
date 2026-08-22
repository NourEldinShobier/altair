/**
 * Rendering suite.
 *
 * Covers what ActionView's escaping and tag helpers cover, and the JSX
 * semantics that replace them. There is no Rails fixture to port here: the
 * behaviour being matched is "output correct, escaped HTML", not ERB's API.
 */

import { describe, expect, it } from "bun:test";
import { escapeHtml, raw, renderDocument, renderToString } from "../src/render.js";

describe("escaping", () => {
  it("escapes the five dangerous characters", () => {
    expect(escapeHtml(`<script>&"'`)).toBe("&lt;script&gt;&amp;&quot;&#39;");
  });

  // The default has to be safe: unescaped interpolation is how XSS happens.
  it("escapes text children", async () => {
    expect(await renderToString(<p>{"<script>alert(1)</script>"}</p>)).toBe(
      "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>",
    );
  });

  it("escapes attribute values", async () => {
    expect(await renderToString(<a title={'" onmouseover="x'}>hi</a>)).toBe(
      '<a title="&quot; onmouseover=&quot;x">hi</a>',
    );
  });

  it("writes raw HTML only when asked", async () => {
    expect(await renderToString(<div>{raw("<b>bold</b>")}</div>)).toBe("<div><b>bold</b></div>");
  });

  it("supports dangerouslySetInnerHTML", async () => {
    expect(await renderToString(<div dangerouslySetInnerHTML={{ __html: "<i>x</i>" }} />)).toBe(
      "<div><i>x</i></div>",
    );
  });
});

describe("elements", () => {
  it("renders nested elements", async () => {
    expect(
      await renderToString(
        <section>
          <h1>Title</h1>
          <p>Body</p>
        </section>,
      ),
    ).toBe("<section><h1>Title</h1><p>Body</p></section>");
  });

  it("renders void elements without a closing tag", async () => {
    expect(await renderToString(<img src="/a.png" alt="" />)).toBe('<img src="/a.png" alt="">');
    expect(await renderToString(<br />)).toBe("<br>");
  });

  it("renders a fragment with no wrapper", async () => {
    expect(
      await renderToString(
        <>
          <li>one</li>
          <li>two</li>
        </>,
      ),
    ).toBe("<li>one</li><li>two</li>");
  });

  it("renders arrays, skipping null and false", async () => {
    const items = ["a", "b"];
    expect(
      await renderToString(
        <ul>
          {items.map((item) => (
            <li>{item}</li>
          ))}
          {null}
          {false}
        </ul>,
      ),
    ).toBe("<ul><li>a</li><li>b</li></ul>");
  });

  it("renders numbers", async () => {
    expect(await renderToString(<span>{42}</span>)).toBe("<span>42</span>");
  });

  it("adds a doctype for a document", async () => {
    expect(await renderDocument(<html lang="en" />)).toBe('<!DOCTYPE html><html lang="en"></html>');
  });
});

describe("attributes", () => {
  it("accepts both class and className", async () => {
    expect(await renderToString(<div class="a" />)).toBe('<div class="a"></div>');
    expect(await renderToString(<div className="b" />)).toBe('<div class="b"></div>');
  });

  it("maps htmlFor to for", async () => {
    expect(await renderToString(<label htmlFor="x" />)).toBe('<label for="x"></label>');
  });

  // `disabled="false"` is read as true by browsers, so it must be omitted.
  it("omits a false boolean attribute", async () => {
    expect(await renderToString(<input disabled={false} />)).toBe("<input>");
    expect(await renderToString(<input disabled />)).toBe("<input disabled>");
  });

  it("omits null and undefined", async () => {
    expect(await renderToString(<div id={null} title={undefined} />)).toBe("<div></div>");
  });

  it("renders a style object as CSS", async () => {
    expect(await renderToString(<div style={{ backgroundColor: "red", fontSize: "1rem" }} />)).toBe(
      '<div style="background-color:red;font-size:1rem"></div>',
    );
  });

  // An event handler cannot cross to the server.
  it("drops function attributes", async () => {
    expect(await renderToString(<button onClick={() => {}}>Go</button>)).toBe(
      "<button>Go</button>",
    );
  });

  it("keeps data and aria attributes verbatim", async () => {
    expect(await renderToString(<div data-id="7" aria-label="Close" />)).toBe(
      '<div data-id="7" aria-label="Close"></div>',
    );
  });
});

describe("components", () => {
  it("renders a component", async () => {
    function Badge({ label }: { label: string }) {
      return <span class="badge">{label}</span>;
    }

    expect(await renderToString(<Badge label="new" />)).toBe('<span class="badge">new</span>');
  });

  it("passes children through", async () => {
    function Card({ children }: { children?: unknown }) {
      return <div class="card">{children}</div>;
    }

    expect(
      await renderToString(
        <Card>
          <p>inside</p>
        </Card>,
      ),
    ).toBe('<div class="card"><p>inside</p></div>');
  });

  // A layout is a component; there is no separate layout mechanism to build.
  it("composes a layout with a page", async () => {
    function Layout({ title, children }: { title: string; children?: unknown }) {
      return (
        <html lang="en">
          <head>
            <title>{title}</title>
          </head>
          <body>{children}</body>
        </html>
      );
    }

    function Show({ post }: { post: { title: string } }) {
      return <h1>{post.title}</h1>;
    }

    const html = await renderDocument(
      <Layout title="Posts">
        <Show post={{ title: "Hello" }} />
      </Layout>,
    );

    expect(html).toBe(
      '<!DOCTYPE html><html lang="en"><head><title>Posts</title></head><body><h1>Hello</h1></body></html>',
    );
  });

  // Async components let a page await its own data.
  it("renders an async component", async () => {
    async function Total() {
      const value = await Promise.resolve(7);
      return <strong>{value}</strong>;
    }

    expect(await renderToString(<Total />)).toBe("<strong>7</strong>");
  });

  it("renders nested async components", async () => {
    async function Inner() {
      return <em>{await Promise.resolve("deep")}</em>;
    }
    async function Outer() {
      return (
        <div>
          <Inner />
        </div>
      );
    }

    expect(await renderToString(<Outer />)).toBe("<div><em>deep</em></div>");
  });
});
