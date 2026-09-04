/**
 * Building an element without writing the string by hand, ported from the
 * `tag` and `content_tag` cases in
 * `actionview/test/template/tag_helper_test.rb`.
 */

import { describe, expect, it } from "bun:test";
import { RawHtml, type Node } from "../src/render.js";
import {
  contentTagString,
  defineElement,
  defineSelfClosingElement,
  defineVoidElement,
  selfClosingTag,
} from "../src/tags.js";

const html = (node: Node): string => (node as RawHtml).value;

describe("selfClosingTag", () => {
  /**
   * In SVG, `<circle>` without the slash is an unclosed element rather than an
   * empty one, and an unclosed element swallows everything after it — so one
   * missing slash silently empties the rest of the drawing.
   */
  it("closes itself", () => {
    expect(html(selfClosingTag("circle", { r: 5 }))).toBe('<circle r="5" />');
  });

  it("writes one with no attributes", () => {
    expect(html(selfClosingTag("br"))).toBe("<br />");
  });

  it("escapes an attribute", () => {
    expect(html(selfClosingTag("circle", { id: '"><script>' }))).not.toContain("<script>");
  });
});

describe("contentTagString", () => {
  it("builds the markup", () => {
    expect(contentTagString("p", "hello", { class: "note" })).toBe('<p class="note">hello</p>');
  });

  /** The alternative is the caller escaping, which is where escaping stops. */
  it("escapes the content", () => {
    expect(contentTagString("p", "<script>alert(1)</script>")).toBe(
      "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>",
    );
  });

  it("can be told the content is already safe", () => {
    expect(contentTagString("p", "<b>bold</b>", {}, false)).toBe("<p><b>bold</b></p>");
  });

  it("escapes an attribute either way", () => {
    expect(contentTagString("p", "x", { title: '"><script>' }, false)).not.toContain("<script>");
  });

  it("writes an empty element", () => {
    expect(contentTagString("div", "")).toBe("<div></div>");
  });
});

describe("defineElement", () => {
  /**
   * A custom element used in twenty places is twenty chances to mistype the
   * tag, and a mistyped tag renders as nothing rather than as an error.
   */
  it("makes a helper for one element", () => {
    const Widget = defineElement("my-widget");

    expect(html(Widget("Hello"))).toBe("<my-widget>Hello</my-widget>");
  });

  it("takes attributes", () => {
    const Widget = defineElement("my-widget");

    expect(html(Widget("Hello", { theme: "dark" }))).toBe(
      '<my-widget theme="dark">Hello</my-widget>',
    );
  });

  it("escapes the content", () => {
    const Widget = defineElement("my-widget");

    expect(html(Widget("<script>"))).not.toContain("<script>");
  });

  it("writes an empty one when given nothing", () => {
    const Widget = defineElement("my-widget");

    expect(html(Widget())).toBe("<my-widget></my-widget>");
  });

  it("keeps two definitions apart", () => {
    const One = defineElement("one");
    const Two = defineElement("two");

    expect(html(One("a"))).toContain("<one>");
    expect(html(Two("a"))).toContain("<two>");
  });
});

describe("defineVoidElement", () => {
  it("makes a helper for an element with nothing inside", () => {
    const Break = defineVoidElement("br");

    expect(html(Break())).toBe("<br>");
  });

  it("takes attributes", () => {
    const Image = defineVoidElement("img");

    expect(html(Image({ src: "/a.png", alt: "A" }))).toBe('<img src="/a.png" alt="A">');
  });

  /** `disabled={false}` must not write `disabled="false"`, which is truthy. */
  it("drops a false attribute rather than writing it", () => {
    const Input = defineVoidElement("input");

    expect(html(Input({ disabled: false }))).toBe("<input>");
  });
});

describe("defineSelfClosingElement", () => {
  it("makes a helper that closes itself", () => {
    const Circle = defineSelfClosingElement("circle");

    expect(html(Circle({ r: 5 }))).toBe('<circle r="5" />');
  });

  it("differs from the void form", () => {
    const asVoid = defineVoidElement("circle");
    const asSelfClosing = defineSelfClosingElement("circle");

    expect(html(asVoid())).not.toBe(html(asSelfClosing()));
  });
});
