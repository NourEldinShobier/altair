/**
 * Asset and link helpers, ported from
 * `actionview/test/template/asset_tag_helper_test.rb` and
 * `url_helper_test.rb`.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { Current } from "@altair/support";
import {
  AudioTag,
  FaviconLinkTag,
  ImageTag,
  JavascriptIncludeTag,
  LinkToIf,
  LinkToUnless,
  LinkToUnlessCurrent,
  MailTo,
  PhoneTo,
  PreloadLinkTag,
  SmsTo,
  StylesheetLinkTag,
  VideoTag,
  assetPath,
  imagePath,
  isCurrentPage,
  setAssetHost,
} from "../src/assets.js";
import { renderToString } from "../src/render.js";

const html = async (node: unknown) => await renderToString(node as never);

afterEach(() => {
  setAssetHost(undefined);
});

describe("where an asset lives", () => {
  it("puts a bare name in its folder", () => {
    expect(imagePath("logo.png")).toBe("/images/logo.png");
    expect(assetPath("app.css", "stylesheets")).toBe("/stylesheets/app.css");
  });

  it("leaves a rooted path where it is", () => {
    expect(imagePath("/uploads/a.png")).toBe("/uploads/a.png");
  });

  /**
   * Something already pointing at another origin is not ours to prefix — and
   * prefixing it would break it silently, since the result is still a valid
   * path.
   */
  it("leaves an absolute URL alone", () => {
    expect(imagePath("https://cdn.example/a.png")).toBe("https://cdn.example/a.png");
    expect(imagePath("//cdn.example/a.png")).toBe("//cdn.example/a.png");
    expect(imagePath("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
  });

  it("puts everything on the asset host when there is one", () => {
    setAssetHost("https://cdn.example/");

    expect(imagePath("logo.png")).toBe("https://cdn.example/images/logo.png");
  });
});

describe("media tags", () => {
  it("writes an image with its path resolved", async () => {
    expect(await html(ImageTag({ src: "logo.png", alt: "Logo" }))).toBe(
      '<img src="/images/logo.png" alt="Logo">',
    );
  });

  // Giving both stops the page moving as images arrive, which is the whole
  // reason Rails has the shorthand.
  it("turns a size into a width and a height", async () => {
    expect(await html(ImageTag({ src: "a.png", size: "16x24" }))).toContain(
      'width="16" height="24"',
    );
  });

  it("treats a single number as a square", async () => {
    expect(await html(ImageTag({ src: "a.png", size: "16" }))).toContain('width="16" height="16"');
  });

  it("writes video, audio, stylesheet and script tags", async () => {
    expect(await html(VideoTag({ src: "a.mp4", controls: true }))).toBe(
      '<video src="/videos/a.mp4" controls></video>',
    );
    expect(await html(AudioTag({ src: "a.mp3" }))).toContain('src="/audios/a.mp3"');
    expect(await html(StylesheetLinkTag({ href: "app.css" }))).toBe(
      '<link rel="stylesheet" href="/stylesheets/app.css">',
    );
    expect(await html(JavascriptIncludeTag({ src: "app.js" }))).toContain(
      'src="/javascripts/app.js"',
    );
  });

  it("has a favicon with sensible defaults", async () => {
    expect(await html(FaviconLinkTag())).toBe(
      '<link rel="icon" type="image/x-icon" href="/images/favicon.ico">',
    );
  });

  // Without `as` the browser ignores the hint, so the tag is written and
  // nothing happens — which is why it is required rather than optional.
  it("preloads with the kind the browser needs", async () => {
    expect(
      await html(PreloadLinkTag({ href: "/f.woff2", as: "font", crossorigin: "anonymous" })),
    ).toBe('<link rel="preload" href="/f.woff2" as="font" crossorigin="anonymous">');
  });
});

describe("knowing which page this is", () => {
  const at = async <T>(path: string, body: () => T): Promise<T> =>
    await Current.run({ request: new Request(`https://app.example${path}`) } as never, body);

  it("says yes for the path being rendered", async () => {
    expect(await at("/posts", () => isCurrentPage("/posts"))).toBe(true);
    expect(await at("/posts", () => isCurrentPage("/about"))).toBe(false);
  });

  // `/posts` and `/posts/` are the same page, and only one of them is in the
  // link.
  it("ignores a trailing slash on either side", async () => {
    expect(await at("/posts/", () => isCurrentPage("/posts"))).toBe(true);
    expect(await at("/posts", () => isCurrentPage("/posts/"))).toBe(true);
  });

  it("says no outside a request", () => {
    expect(isCurrentPage("/posts")).toBe(false);
  });
});

describe("links that are sometimes not links", () => {
  it("links when the condition holds", async () => {
    expect(await html(LinkToIf({ condition: true, href: "/a", text: "A" }))).toBe(
      '<a href="/a">A</a>',
    );
  });

  it("writes the words alone when it does not", async () => {
    expect(await html(LinkToIf({ condition: false, href: "/a", text: "A" }))).toBe("A");
  });

  it("escapes those words", async () => {
    expect(await html(LinkToIf({ condition: false, href: "/a", text: "<b>" }))).toBe("&lt;b&gt;");
  });

  it("is the other way round for unless", async () => {
    expect(await html(LinkToUnless({ condition: true, href: "/a", text: "A" }))).toBe("A");
  });

  /**
   * What a navigation bar wants: the current section as plain words rather
   * than a link to where you already are.
   */
  it("stops linking to the page you are on", async () => {
    const here = await Current.run(
      { request: new Request("https://app.example/posts") } as never,
      async () => await html(LinkToUnlessCurrent({ href: "/posts", text: "Posts" })),
    );

    const elsewhere = await Current.run(
      { request: new Request("https://app.example/about") } as never,
      async () => await html(LinkToUnlessCurrent({ href: "/posts", text: "Posts" })),
    );

    expect(here).toBe("Posts");
    expect(elsewhere).toBe('<a href="/posts">Posts</a>');
  });
});

describe("links that are not to pages", () => {
  it("writes a mail link", async () => {
    expect(await html(MailTo({ address: "ada@example.com" }))).toBe(
      '<a href="mailto:ada%40example.com">ada@example.com</a>',
    );
  });

  it("carries a subject and a body", async () => {
    const rendered = await html(
      MailTo({ address: "a@b.com", subject: "Hello there", text: "Write" }),
    );

    expect(rendered).toContain("subject=Hello+there");
    expect(rendered).toContain(">Write</a>");
  });

  /**
   * An unencoded `?` or `&` in the address would start a header the sender
   * never wrote — a `bcc` on a link somebody clicked from a page.
   */
  it("encodes an address that would otherwise add a header", async () => {
    const rendered = await html(MailTo({ address: "a@b.com?bcc=eve@evil.example" }));
    const href = /href="([^"]*)"/.exec(rendered)?.[1] as string;

    // The href is what the mail client reads, and it carries no header. The
    // visible text still shows the address as typed, which is what Rails does
    // and what a person needs to see to know it is wrong.
    expect(href).not.toContain("?bcc=");
    expect(href).toContain("%3Fbcc%3D");
  });

  it("writes phone and sms links, keeping only the dialable part", async () => {
    expect(await html(PhoneTo({ number: "+44 20 7946 0000" }))).toContain(
      'href="tel:+442079460000"',
    );
    // `&` is escaped in an attribute, which is correct HTML rather than a
    // mangled link — a browser reads `&amp;` back as `&`.
    expect(await html(SmsTo({ number: "+44 20 7946 0000", body: "hi" }))).toContain(
      "sms:+442079460000?&amp;body=hi",
    );
  });
});
