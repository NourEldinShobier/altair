/**
 * Turning away browsers too old to run the application, ported from Rails
 * 7.2's `allow_browser`.
 *
 *     class ApplicationController extends Controller {
 *       static { this.allowBrowser({ versions: "modern" }) }
 *     }
 *
 * Rails generates exactly that line in every new application, and the reason
 * is worth stating: a browser that cannot run the JavaScript the application
 * ships does not fail visibly. It renders the page, silently drops the parts
 * that need `import maps` or `:has()` or web push, and the person using it
 * sees a site that is subtly broken with nothing to explain why. A plain 406
 * with a page saying "this browser is too old" is kinder and far easier to
 * support than a bug report that cannot be reproduced.
 *
 * The version numbers below are Rails' own for `:modern`, which it defines as
 * the browsers supporting webp images, web push, badges, import maps, CSS
 * nesting and `:has()`.
 */

/** The minimum version of each browser, by the name the parser reports. */
export type BrowserVersions = Record<string, number | false>;

/**
 * Rails' `:modern`. Anything not listed is allowed through.
 *
 * Allowing the unknown is deliberate and is what Rails does: the long tail of
 * user agents is enormous, and refusing everything unrecognised turns a
 * feature meant to help a handful of people into an outage for a bot, a
 * screen reader, a webview, or next year's browser.
 */
export const MODERN_BROWSERS: BrowserVersions = {
  safari: 17.2,
  chrome: 120,
  firefox: 121,
  opera: 106,
};

export interface AllowBrowserOptions {
  /** `"modern"`, or the minimum version of each browser by name. */
  versions?: "modern" | BrowserVersions;
  /** What to send a browser that is turned away. */
  block?: (request: Request) => Response | Promise<Response>;
}

/** What a user-agent string says it is, as far as this needs to know. */
export interface BrowserIdentity {
  name: string;
  version: number;
}

/**
 * Reads a user-agent string.
 *
 * Order matters and is the whole difficulty. Every browser lies: Chrome's
 * string contains `Safari`, Edge's contains both `Chrome` and `Safari`, and
 * Opera's contains all three. So the most specific token is looked for first,
 * and the generic ones only once the specific ones have been ruled out —
 * which is why `Safari` is last.
 */
export function identifyBrowser(userAgent: string | null): BrowserIdentity | undefined {
  if (!userAgent) return undefined;

  const patterns: [string, RegExp][] = [
    ["edge", /Edg(?:e|A|iOS)?\/(\d+(?:\.\d+)?)/],
    ["opera", /OPR\/(\d+(?:\.\d+)?)/],
    ["opera", /Opera[ /](\d+(?:\.\d+)?)/],
    ["firefox", /(?:Firefox|FxiOS)\/(\d+(?:\.\d+)?)/],
    ["chrome", /(?:Chrome|CriOS)\/(\d+(?:\.\d+)?)/],
    ["safari", /Version\/(\d+(?:\.\d+)?).*Safari/],
  ];

  for (const [name, pattern] of patterns) {
    const match = pattern.exec(userAgent);
    if (match) return { name, version: Number(match[1]) };
  }

  return undefined;
}

/**
 * Whether this request comes from a browser the application will serve.
 *
 * An agent it cannot identify is allowed. See `MODERN_BROWSERS` for why.
 */
export function browserAllowed(request: Request, versions: BrowserVersions): boolean {
  const browser = identifyBrowser(request.headers.get("user-agent"));
  if (!browser) return true;

  const minimum = versions[browser.name];

  // `false` is Rails' spelling of "this one, never" — for a browser an
  // application has decided not to support at any version.
  if (minimum === false) return false;
  if (minimum === undefined) return true;

  return browser.version >= minimum;
}

/**
 * The default refusal.
 *
 * 406 rather than 403, because the request was understood and the problem is
 * that nothing the server can send is acceptable to this client — which is
 * what 406 means and what Rails answers.
 *
 * The body is plain HTML with no script and no stylesheet, since the reason
 * the visitor is here is that their browser cannot run what the application
 * ships.
 */
export function browserBlockedResponse(): Response {
  return new Response(
    `<!doctype html><html lang=en><head><meta charset=utf-8>` +
      `<meta name=viewport content="width=device-width, initial-scale=1">` +
      `<title>Your browser is out of date</title></head>` +
      `<body style="font:16px/1.6 system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.5rem">` +
      `<h1 style="font-size:1.4rem">Your browser is not supported</h1>` +
      `<p>This site needs a newer browser than the one you are using. ` +
      `Updating it, or switching to a recent version of Chrome, Firefox, Safari or Edge, will fix this.</p>` +
      `</body></html>`,
    { status: 406, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

/** The versions an option means. */
export function versionsFor(option: AllowBrowserOptions["versions"]): BrowserVersions {
  return option === undefined || option === "modern" ? MODERN_BROWSERS : option;
}
