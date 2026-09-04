/**
 * Head and script tags, ported from
 * `actionview/test/template/asset_tag_helper_test.rb`,
 * `javascript_helper_test.rb` and `csrf_helper_test.rb`.
 */

import { describe, expect, it } from "bun:test";
import type { RawHtml } from "../src/render.js";
import {
  autoDiscoveryLinkTag,
  cspMetaTag,
  csrfMetaTags,
  escapeJavascript,
  imageSubmitTag,
  javascriptCdataSection,
  javascriptTag,
  pictureTag,
  timeTag,
  utf8EnforcerTag,
} from "../src/meta-tags.js";

function html(node: unknown): string {
  return (node as RawHtml).value;
}

describe("autoDiscoveryLinkTag", () => {
  /** A reader looks for the exact type; text/xml is a feed nobody finds. */
  it("uses the type a reader looks for", () => {
    expect(html(autoDiscoveryLinkTag("rss", "/feed"))).toContain('type="application/rss+xml"');
    expect(html(autoDiscoveryLinkTag("atom", "/feed"))).toContain('type="application/atom+xml"');
  });

  it("defaults the title to the type", () => {
    expect(html(autoDiscoveryLinkTag("atom", "/feed"))).toContain('title="ATOM"');
  });

  it("takes a title of its own", () => {
    expect(html(autoDiscoveryLinkTag("rss", "/feed", { title: "Posts" }))).toContain(
      'title="Posts"',
    );
  });

  it("escapes the href", () => {
    expect(html(autoDiscoveryLinkTag("rss", '/feed?a="b"'))).toContain("&quot;");
  });
});

describe("pictureTag", () => {
  it("renders a source per alternative", () => {
    const markup = html(
      pictureTag(
        [
          { srcset: "/a.avif", type: "image/avif" },
          { srcset: "/a.webp", type: "image/webp" },
        ],
        { src: "/a.jpg", alt: "A" },
      ),
    );

    expect(markup.match(/<source/g)).toHaveLength(2);
  });

  /** A picture with no img inside renders nothing at all. */
  it("always includes the fallback img", () => {
    const markup = html(pictureTag([], { src: "/a.jpg", alt: "A" }));

    expect(markup).toContain('<img src="/a.jpg" alt="A" />');
  });

  it("keeps the sources in order, since order is preference", () => {
    const markup = html(
      pictureTag([{ srcset: "/first.avif" }, { srcset: "/second.webp" }], {
        src: "/a.jpg",
        alt: "A",
      }),
    );

    expect(markup.indexOf("first")).toBeLessThan(markup.indexOf("second"));
  });

  it("carries a media query", () => {
    const markup = html(
      pictureTag([{ srcset: "/wide.jpg", media: "(min-width: 800px)" }], {
        src: "/a.jpg",
        alt: "A",
      }),
    );

    expect(markup).toContain('media="(min-width: 800px)"');
  });
});

describe("imageSubmitTag", () => {
  it("is an image input", () => {
    const markup = html(imageSubmitTag("/go.png", "Search"));

    expect(markup).toContain('type="image"');
    expect(markup).toContain('src="/go.png"');
  });

  /** Without it a screen reader announces a button with no name. */
  it("always carries the alt text", () => {
    expect(html(imageSubmitTag("/go.png", "Search"))).toContain('alt="Search"');
  });
});

describe("javascriptTag", () => {
  it("wraps the body", () => {
    const markup = html(javascriptTag("var a = 1;"));

    expect(markup).toContain("<script>");
    expect(markup).toContain("var a = 1;");
  });

  /** Escaping the body as HTML would break every < in a comparison. */
  it("does not escape the body as HTML", () => {
    expect(html(javascriptTag("if (a < b) { c(); }"))).toContain("a < b");
  });

  /**
   * `</script` ends the element wherever it appears, including inside a string
   * literal, and everything after it parses as markup.
   */
  it("refuses a body that would end the tag early", () => {
    expect(() => javascriptTag('var a = "</script>";')).toThrow(/<\/script/);
  });

  it("refuses it whatever the case", () => {
    expect(() => javascriptTag("var a = '</SCRIPT>';")).toThrow();
  });

  it("carries a nonce", () => {
    expect(html(javascriptTag("var a = 1;", { nonce: "abc" }))).toContain('nonce="abc"');
  });
});

describe("javascriptCdataSection", () => {
  /** JSON alone leaves </script> intact; HTML escaping alone breaks the JSON. */
  it("neutralises a closing tag inside the data", () => {
    const markup = html(javascriptCdataSection({ bio: "</script>" }));

    expect(markup).not.toContain("</script>");
  });

  it("stays parseable as JSON", () => {
    const markup = html(javascriptCdataSection({ a: 1 }));
    const json = markup.split("\n")[1] as string;

    expect(JSON.parse(json)).toEqual({ a: 1 });
  });
});

describe("escapeJavascript", () => {
  it("escapes quotes and backslashes", () => {
    expect(escapeJavascript(`a"b'c\\d`)).toBe(`a\\"b\\'c\\\\d`);
  });

  it("escapes newlines", () => {
    expect(escapeJavascript("a\nb")).toBe("a\\nb");
  });

  it("escapes a backtick, which a template literal would end on", () => {
    expect(escapeJavascript("a`b")).toBe("a\\`b");
  });

  /** Legal in JSON, and a line terminator in JavaScript. */
  it("escapes the line separators", () => {
    expect(escapeJavascript("a\u2028b")).toBe("a&#x2028;b");
    expect(escapeJavascript("a\u2029b")).toBe("a&#x2029;b");
  });

  it("leaves ordinary text alone", () => {
    expect(escapeJavascript("hello")).toBe("hello");
  });
});

describe("the meta tags", () => {
  /** Hard-coding the parameter name is how a rename breaks every async form. */
  it("names the parameter as well as the token", () => {
    const markup = html(csrfMetaTags("abc"));

    expect(markup).toContain('name="csrf-param" content="authenticity_token"');
    expect(markup).toContain('name="csrf-token" content="abc"');
  });

  it("takes a different parameter name", () => {
    expect(html(csrfMetaTags("abc", "custom_token"))).toContain('content="custom_token"');
  });

  it("renders nothing without a token", () => {
    expect(html(csrfMetaTags(undefined))).toBe("");
  });

  it("escapes the token", () => {
    expect(html(csrfMetaTags('a"b'))).toContain("&quot;");
  });

  it("renders the nonce for a script that has to read it", () => {
    expect(html(cspMetaTag("n0nce"))).toContain('name="csp-nonce" content="n0nce"');
    expect(html(cspMetaTag(undefined))).toBe("");
  });

  it("renders the utf8 enforcer", () => {
    const markup = html(utf8EnforcerTag());

    expect(markup).toContain('name="utf8"');
    expect(markup).toContain('type="hidden"');
  });
});

describe("timeTag", () => {
  /** The text is for a person; the attribute stays exact for a parser. */
  it("carries the exact time in the attribute", () => {
    const markup = html(timeTag(new Date("2026-03-09T12:00:00Z"), "three days ago"));

    expect(markup).toContain('datetime="2026-03-09T12:00:00.000Z"');
    expect(markup).toContain(">three days ago<");
  });

  it("falls back to the timestamp as its text", () => {
    expect(html(timeTag(new Date("2026-03-09T12:00:00Z")))).toContain(">2026-03-09T12:00:00.000Z<");
  });

  it("escapes the text", () => {
    expect(html(timeTag(new Date(0), "<b>now</b>"))).toContain("&lt;b&gt;");
  });
});
