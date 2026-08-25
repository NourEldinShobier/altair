/**
 * What the renderer refuses to write.
 *
 * Mirrors the ground actionview/test/template/output_safety_helper_test.rb
 * covers, and the part React handles by warning rather than refusing.
 *
 * Escaping the value was already right. These are the three places a value was
 * never the thing that mattered: an attribute's name, a tag's name, and a URL
 * that needs no special characters to run code.
 */

import { describe, expect, it } from "bun:test";
import { UnsafeMarkup, renderToString } from "../src/render.js";

/** Builds an element without going through JSX, which would not allow these. */
const element = (type: string, props: Record<string, unknown>) =>
  renderToString({ type, props } as never);

describe("what was already safe", () => {
  it("escapes a text child", async () => {
    expect(await element("p", { children: "<script>alert(1)</script>" })).toBe(
      "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>",
    );
  });

  it("escapes an attribute value", async () => {
    const html = await element("p", { title: '"><script>alert(1)</script>', children: "x" });

    expect(html).not.toContain("<script");
    expect(html).toContain("&quot;");
  });

  it("escapes through nesting and arrays", async () => {
    const html = await element("div", {
      children: [{ type: "p", props: { children: "<img onerror=x>" } }, "<b>"],
    });

    expect(html).not.toMatch(/<img|<b>/);
  });
});

/**
 * The value was escaped and the name was not, so a name carrying a quote
 * closed the attribute and opened another:
 *
 *     <p x" onmouseover="alert(1)="y">
 *
 * Which a browser reads as a live handler. Spreading props built from data —
 * a CMS payload, a form schema, a JSON column — is how that gets reached.
 */
describe("an attribute name", () => {
  it("cannot close its own attribute", () => {
    expect(element("p", { 'x" onmouseover="alert(1)': "y", children: "z" })).rejects.toBeInstanceOf(
      UnsafeMarkup,
    );
  });

  it("cannot contain whitespace, a bracket, a slash or an equals sign", () => {
    for (const name of ["a b", "a>b", "a/b", "a=b", "a'b", '"']) {
      expect(element("p", { [name]: "y" })).rejects.toBeInstanceOf(UnsafeMarkup);
    }
  });

  it("says which name it refused", () => {
    expect(element("p", { "a b": "y" })).rejects.toThrow(/"a b"/);
  });

  // The guard has to leave every attribute anybody actually writes alone.
  it("allows the names real markup uses", async () => {
    const html = await element("div", {
      "data-id": "1",
      "aria-label": "x",
      "xml:lang": "en",
      class: "a",
      children: "y",
    });

    expect(html).toContain('data-id="1"');
    expect(html).toContain('aria-label="x"');
    expect(html).toContain('xml:lang="en"');
  });
});

describe("a tag name", () => {
  it("cannot carry an attribute of its own", () => {
    expect(element('p onmouseover="alert(1)"', { children: "x" })).rejects.toBeInstanceOf(
      UnsafeMarkup,
    );
  });

  it("allows an ordinary tag and a custom element", async () => {
    expect(await element("p", { children: "x" })).toBe("<p>x</p>");
    expect(await element("my-widget", { children: "x" })).toBe("<my-widget>x</my-widget>");
  });
});

/**
 * The escaping stops a value ending its attribute, and does nothing about a
 * scheme — `javascript:alert(1)` needs no special characters at all. The
 * ordinary way in is `href={user.website}`.
 */
describe("a URL that runs rather than fetches", () => {
  it("is refused", () => {
    expect(element("a", { href: "javascript:alert(1)", children: "x" })).rejects.toBeInstanceOf(
      UnsafeMarkup,
    );
  });

  // A browser decodes entities and drops control characters before deciding
  // what a URL means, so a check on the raw string reads a different one.
  it("is refused however it is spelled", async () => {
    const payloads = [
      "JaVaScRiPt:alert(1)",
      "  javascript:alert(1)",
      "java\tscript:alert(1)",
      "&#106;avascript:alert(1)",
      "vbscript:msgbox(1)",
    ];

    for (const href of payloads) {
      expect(element("a", { href, children: "x" })).rejects.toBeInstanceOf(UnsafeMarkup);
    }
  });

  it("is refused on every attribute a browser follows", () => {
    for (const name of ["href", "src", "action", "formaction", "poster", "cite"]) {
      expect(element("a", { [name]: "javascript:alert(1)" })).rejects.toBeInstanceOf(UnsafeMarkup);
    }
  });

  it("leaves the URLs a page is made of alone", async () => {
    for (const href of [
      "/posts",
      "https://example.com",
      "mailto:a@b.c",
      "tel:+123",
      "#top",
      "?page=2",
      "//cdn.example.com/x.js",
    ]) {
      expect(await element("a", { href, children: "x" })).toContain("href=");
    }
  });

  // Refusing every `data:` would break every inlined icon and every emailed
  // logo, which is how a guard gets removed rather than kept. A picture is not
  // a document.
  it("allows an image or a font inlined as data", async () => {
    expect(await element("img", { src: "data:image/png;base64,AAA" })).toContain("data:image/png");
    expect(await element("img", { src: "data:font/woff2;base64,AAA" })).toContain("data:font");
  });

  // SVG is a document wearing an image's content type: harmless in an `<img>`,
  // script-bearing in an `<object>`, and this cannot see which it is.
  it("refuses an SVG or a document inlined as data", () => {
    for (const src of [
      "data:image/svg+xml,<svg onload=alert(1)>",
      "data:text/html,<script>alert(1)</script>",
      "data:application/javascript,alert(1)",
    ]) {
      expect(element("img", { src })).rejects.toBeInstanceOf(UnsafeMarkup);
    }
  });
});
