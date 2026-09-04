/**
 * Telling the browser what to fetch before the page exists, ported from
 * `actionpack/test/dispatch/request_test.rb`'s early-hints cases.
 *
 * A hint is a guess, and every case here is a wrong guess costing more than no
 * guess at all.
 */

import { describe, expect, it } from "bun:test";
import {
  MissingCrossOrigin,
  type PreloadLink,
  earlyHintsHeaders,
  earlyHintsLinks,
  preloadLink,
  sendEarlyHints,
} from "../src/early-hints.js";

const style: PreloadLink = { href: "/application.css", as: "style" };

describe("one link header", () => {
  it("names the url, the relation and the destination", () => {
    expect(preloadLink(style)).toBe("</application.css>; rel=preload; as=style");
  });

  it("takes another relation", () => {
    expect(preloadLink({ href: "https://cdn.example", as: "fetch", rel: "preconnect" })).toBe(
      "<https://cdn.example>; rel=preconnect; as=fetch",
    );
  });

  it("carries the type and the origin mode", () => {
    expect(
      preloadLink({
        href: "/f.woff2",
        as: "font",
        type: "font/woff2",
        crossorigin: "anonymous",
      }),
    ).toBe("</f.woff2>; rel=preload; as=font; type=font/woff2; crossorigin=anonymous");
  });

  /** So a hint for a print stylesheet costs nothing on screen. */
  it("carries a media query, quoted", () => {
    expect(preloadLink({ href: "/print.css", as: "style", media: "print" })).toBe(
      '</print.css>; rel=preload; as=style; media="print"',
    );
  });

  /**
   * Fonts are fetched in anonymous mode whatever the page says, so a preload
   * without it lands in a different cache entry from the request the page
   * makes — and the font is fetched twice.
   */
  it("refuses a font with no origin mode", () => {
    expect(() => preloadLink({ href: "/f.woff2", as: "font" })).toThrow(MissingCrossOrigin);
    expect(() => preloadLink({ href: "/f.woff2", as: "font" })).toThrow("/f.woff2");
  });

  /**
   * A fixed order, not whatever order the object happened to have: a header
   * that varies by key order defeats every cache and every test comparing one.
   */
  it("writes the parameters in one order", () => {
    const link: PreloadLink = {
      nonce: "abc",
      media: "screen",
      crossorigin: "anonymous",
      type: "text/css",
      as: "style",
      href: "/a.css",
    };

    expect(preloadLink(link)).toBe(
      '</a.css>; rel=preload; as=style; type=text/css; crossorigin=anonymous; media="screen"; nonce=abc',
    );
  });
});

describe("the headers a 103 carries", () => {
  /**
   * One value per hint, checked on its own — a font with no origin mode is
   * refused here, before anything is sent, rather than discovered as a
   * duplicate fetch in somebody's network tab.
   */
  it("is one value per link", () => {
    expect(earlyHintsLinks([style, { href: "/app.js", as: "script" }])).toEqual([
      "</application.css>; rel=preload; as=style",
      "</app.js>; rel=preload; as=script",
    ]);
  });

  it("refuses the whole set when one hint is wrong", () => {
    expect(() => earlyHintsLinks([style, { href: "/f.woff2", as: "font" }])).toThrow(
      MissingCrossOrigin,
    );
  });

  it("carries every link", () => {
    const headers = earlyHintsHeaders([style, { href: "/app.js", as: "script" }]);

    expect(headers?.get("link")).toContain("/application.css");
    expect(headers?.get("link")).toContain("/app.js");
  });

  /**
   * An empty `Link:` is a 103 that told the browser nothing and cost it a
   * round trip to read.
   */
  it("is nothing at all for no links", () => {
    expect(earlyHintsHeaders([])).toBeUndefined();
  });
});

describe("sending them", () => {
  it("hands the headers to the server", () => {
    const sent: Headers[] = [];

    expect(sendEarlyHints({ sendEarlyHints: (headers) => sent.push(headers) }, [style])).toBe(true);
    expect(sent[0]?.get("link")).toContain("/application.css");
  });

  /**
   * Silently nothing, deliberately: early hints are an optimisation, most
   * proxies cannot carry them, and an application that raised here could not
   * be deployed behind an ordinary load balancer.
   */
  it("does nothing when the server cannot send them", () => {
    expect(sendEarlyHints({}, [style])).toBe(false);
  });

  it("does nothing when there is nothing to say", () => {
    let called = 0;

    expect(
      sendEarlyHints(
        {
          sendEarlyHints: () => {
            called += 1;
          },
        },
        [],
      ),
    ).toBe(false);
    expect(called).toBe(0);
  });

  /** So a caller that wants to know can ask rather than guess. */
  it("says whether they went", () => {
    expect(sendEarlyHints({ sendEarlyHints: () => undefined }, [style])).toBe(true);
  });
});
