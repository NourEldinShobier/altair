/**
 * Turning away browsers too old to run the application, ported from Rails
 * 7.2's `allow_browser`.
 *
 * A browser that cannot run the JavaScript an application ships does not fail
 * visibly: it renders the page, silently drops whatever needed the features it
 * lacks, and the person using it sees a site that is subtly broken with nothing
 * to explain why. A plain 406 saying so is kinder, and far easier to support
 * than a bug report nobody can reproduce.
 */

import { describe, expect, it } from "bun:test";
import {
  browserAllowed,
  browserBlockedResponse,
  Controller,
  identifyBrowser,
  MODERN_BROWSERS,
} from "../src/index.js";

const AGENTS = {
  chrome120:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  chrome98:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.102 Safari/537.36",
  safari17:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  safari15:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Safari/605.1.15",
  firefox122: "Mozilla/5.0 (X11; Linux x86_64; rv:122.0) Gecko/20100101 Firefox/122.0",
  firefox100: "Mozilla/5.0 (X11; Linux x86_64; rv:100.0) Gecko/20100101 Firefox/100.0",
  edge120:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
  opera106:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 OPR/106.0.0.0",
  curl: "curl/8.4.0",
  googlebot: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
};

const requestFrom = (agent?: string) =>
  new Request("https://app.example/", { headers: agent ? { "user-agent": agent } : {} });

/**
 * Every browser lies. Chrome's string contains `Safari`, Edge's contains both
 * `Chrome` and `Safari`, and Opera's contains all three — so the order these
 * are matched in is the whole difficulty.
 */
describe("reading a user agent", () => {
  it("reads Chrome", () => {
    expect(identifyBrowser(AGENTS.chrome120)).toEqual({ name: "chrome", version: 120 });
  });

  it("reads Safari, which Chrome also claims to be", () => {
    expect(identifyBrowser(AGENTS.safari17)).toEqual({ name: "safari", version: 17.4 });
  });

  it("reads Firefox", () => {
    expect(identifyBrowser(AGENTS.firefox122)).toEqual({ name: "firefox", version: 122 });
  });

  it("reads Edge rather than the Chrome it claims to be", () => {
    expect(identifyBrowser(AGENTS.edge120)?.name).toBe("edge");
  });

  it("reads Opera rather than the Chrome it claims to be", () => {
    expect(identifyBrowser(AGENTS.opera106)?.name).toBe("opera");
  });

  it("gives nothing for an agent it does not know", () => {
    expect(identifyBrowser(AGENTS.curl)).toBeUndefined();
  });

  it("gives nothing when there is no header at all", () => {
    expect(identifyBrowser(null)).toBeUndefined();
  });
});

describe("deciding whether to serve", () => {
  it("serves a browser at the minimum", () => {
    expect(browserAllowed(requestFrom(AGENTS.chrome120), MODERN_BROWSERS)).toBe(true);
  });

  it("turns away one below it", () => {
    expect(browserAllowed(requestFrom(AGENTS.chrome98), MODERN_BROWSERS)).toBe(false);
    expect(browserAllowed(requestFrom(AGENTS.safari15), MODERN_BROWSERS)).toBe(false);
    expect(browserAllowed(requestFrom(AGENTS.firefox100), MODERN_BROWSERS)).toBe(false);
  });

  it("compares a decimal version properly", () => {
    // Safari 17.2 is the threshold, so 17.1 is out and 17.4 is in — a string
    // comparison would put "17.4" below "17.2" for neither reason.
    expect(browserAllowed(requestFrom(AGENTS.safari17), { safari: 17.2 })).toBe(true);
    expect(browserAllowed(requestFrom(AGENTS.safari17), { safari: 17.5 })).toBe(false);
  });

  /**
   * Allowing the unrecognised is deliberate, and is what Rails does. The long
   * tail of user agents is enormous, and refusing everything unknown turns a
   * feature meant to help a handful of people into an outage for a bot, a
   * screen reader, a webview, or next year's browser.
   */
  it("serves an agent it cannot identify", () => {
    expect(browserAllowed(requestFrom(AGENTS.curl), MODERN_BROWSERS)).toBe(true);
    expect(browserAllowed(requestFrom(AGENTS.googlebot), MODERN_BROWSERS)).toBe(true);
    expect(browserAllowed(requestFrom(), MODERN_BROWSERS)).toBe(true);
  });

  it("serves a browser nobody set a minimum for", () => {
    expect(browserAllowed(requestFrom(AGENTS.edge120), { chrome: 120 })).toBe(true);
  });

  it("takes false as never, whatever the version", () => {
    expect(browserAllowed(requestFrom(AGENTS.chrome120), { chrome: false })).toBe(false);
  });
});

/**
 * 406 rather than 403: the request was understood, and the problem is that
 * nothing the server can send is acceptable to this client. That is what 406
 * means, and what Rails answers.
 */
describe("the refusal", () => {
  it("is a 406", () => {
    expect(browserBlockedResponse().status).toBe(406);
  });

  it("is HTML a person can read", async () => {
    const response = browserBlockedResponse();

    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("not supported");
  });

  /**
   * The reason this visitor is here is that their browser cannot run what the
   * application ships, so the page that says so must need nothing.
   */
  it("needs no script and no stylesheet", async () => {
    const body = await browserBlockedResponse().text();

    expect(body).not.toContain("<script");
    expect(body).not.toContain("<link");
  });
});

describe("declared on a controller", () => {
  class Pages extends Controller {
    static {
      this.allowBrowser({ versions: "modern" });
    }

    async show(): Promise<Response> {
      return this.render.text("the page");
    }
  }

  const get = async (agent: string) =>
    await new Pages({ request: requestFrom(agent) }).processAction("show");

  it("lets a current browser through to the action", async () => {
    const response = await get(AGENTS.chrome120);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("the page");
  });

  it("stops an old one before the action runs", async () => {
    const response = await get(AGENTS.chrome98);

    expect(response.status).toBe(406);
    expect(await response.text()).not.toContain("the page");
  });

  it("takes a block of the application's own", async () => {
    class Custom extends Controller {
      static {
        this.allowBrowser({
          versions: { chrome: 120 },
          block: () => new Response("upgrade please", { status: 426 }),
        });
      }

      async show(): Promise<Response> {
        return this.render.text("the page");
      }
    }

    const response = await new Custom({ request: requestFrom(AGENTS.chrome98) }).processAction(
      "show",
    );

    expect(response.status).toBe(426);
    expect(await response.text()).toBe("upgrade please");
  });

  /**
   * A public marketing page usually should not be refused, and only the
   * controller knows which those are — so this has to be an ordinary filter
   * that `only`/`except` and `skipBeforeAction` can reach.
   */
  it("takes the filter options every other before-action takes", async () => {
    class Mixed extends Controller {
      static {
        this.allowBrowser({ versions: "modern", only: ["app"] });
      }

      async app(): Promise<Response> {
        return this.render.text("the app");
      }

      async marketing(): Promise<Response> {
        return this.render.text("the marketing page");
      }
    }

    const old = () => new Mixed({ request: requestFrom(AGENTS.chrome98) });

    expect((await old().processAction("app")).status).toBe(406);
    expect((await old().processAction("marketing")).status).toBe(200);
  });
});
