/**
 * Choosing a locale for a request.
 *
 * Mirrors the `set_locale` pattern Rails' internationalization guide builds,
 * plus the `Accept-Language` negotiation Rack does underneath it.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { i18n, t } from "@altair/support";
import { negotiateLocale, preferredLocales, setLocale } from "../src/locale.js";

afterEach(() => {
  i18n.reset();
});

const get = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });

const run = async (request: Request, options = {}) =>
  await setLocale(options)(request, async () => Response.json({ locale: i18n.locale }));

const localeOf = async (response: Response) =>
  ((await response.json()) as { locale: string }).locale;

describe("reading Accept-Language", () => {
  it("takes the languages in order", () => {
    expect(preferredLocales("fr-CA,fr;q=0.9,en;q=0.8")).toEqual(["fr-CA", "fr", "en"]);
  });

  // A browser sends quality values and means them; ignoring q is how a site
  // ends up in someone's third language.
  it("orders by quality, not by position", () => {
    expect(preferredLocales("en;q=0.2,fr;q=0.9")).toEqual(["fr", "en"]);
  });

  it("treats a missing quality as the highest", () => {
    expect(preferredLocales("de,fr;q=0.9")).toEqual(["de", "fr"]);
  });

  it("keeps equal qualities in the order they were written", () => {
    expect(preferredLocales("de;q=0.5,fr;q=0.5,en;q=0.5")).toEqual(["de", "fr", "en"]);
  });

  it("ignores the wildcard and an absent header", () => {
    expect(preferredLocales("*")).toEqual([]);
    expect(preferredLocales("")).toEqual([]);
    expect(preferredLocales(null)).toEqual([]);
  });

  // The quality is unreadable but the language is not, and the result is
  // checked against the locales that exist anyway — so dropping French here
  // would answer in English for no reason.
  it("keeps a language whose quality is unreadable", () => {
    expect(preferredLocales("fr;q=nonsense")).toEqual(["fr"]);
    expect(preferredLocales("de;q=0.9,fr;q=nonsense")).toEqual(["fr", "de"]);
  });
});

describe("negotiating", () => {
  it("takes an exact match", () => {
    expect(negotiateLocale(["fr"], ["en", "fr"])).toBe("fr");
  });

  // A page in French is much closer to what someone asked for than a page in
  // English.
  it("falls back from a region to its language", () => {
    expect(negotiateLocale(["fr-CA"], ["en", "fr"])).toBe("fr");
  });

  it("prefers the region when it has one", () => {
    expect(negotiateLocale(["en-GB"], ["en", "en-GB"])).toBe("en-GB");
  });

  it("moves on to the next language asked for", () => {
    expect(negotiateLocale(["ja", "de", "en"], ["en", "de"])).toBe("de");
  });

  it("gives nothing when nothing matches", () => {
    expect(negotiateLocale(["ja"], ["en", "fr"])).toBeUndefined();
  });

  it("ignores case in the tag", () => {
    expect(negotiateLocale(["FR-ca"], ["fr-CA"])).toBe("fr-CA");
  });
});

describe("the middleware", () => {
  const available = ["en", "fr", "de"];

  it("sets the locale from the header", async () => {
    const response = await run(get("http://test/", { "accept-language": "fr" }), { available });
    expect(await localeOf(response)).toBe("fr");
  });

  it("lets a parameter win over the header", async () => {
    const response = await run(get("http://test/?locale=de", { "accept-language": "fr" }), {
      available,
    });

    expect(await localeOf(response)).toBe("de");
  });

  it("can be told not to look at the parameter", async () => {
    const response = await run(get("http://test/?locale=de", { "accept-language": "fr" }), {
      available,
      parameter: false,
    });

    expect(await localeOf(response)).toBe("fr");
  });

  it("takes one from anywhere else it is told to look", async () => {
    const response = await run(get("http://test/", { "accept-language": "fr" }), {
      available,
      from: (request: Request) => request.headers.get("x-locale") ?? undefined,
    });

    expect(await localeOf(response)).toBe("fr");

    const chosen = await run(get("http://test/", { "x-locale": "de", "accept-language": "fr" }), {
      available,
      from: (request: Request) => request.headers.get("x-locale") ?? undefined,
    });

    expect(await localeOf(chosen)).toBe("de");
  });

  // Honouring a language nobody translated would make every string a
  // missing-translation marker.
  it("refuses a locale it has no translations for", async () => {
    const response = await run(get("http://test/?locale=ja", { "accept-language": "ja" }), {
      available,
    });

    expect(await localeOf(response)).toBe("en");
  });

  it("takes the fallback it was given", async () => {
    const response = await run(get("http://test/", { "accept-language": "ja" }), {
      available,
      fallback: "de",
    });

    expect(await localeOf(response)).toBe("de");
  });

  it("defaults to whatever has been stored", async () => {
    i18n.store("fr", { a: "a" });

    const response = await run(get("http://test/", { "accept-language": "fr" }));
    expect(await localeOf(response)).toBe("fr");
  });

  // The response depends on the header, so it has to say so — otherwise a
  // shared cache stores the English page and hands it to the next French
  // reader, in front of an application behaving perfectly.
  it("says the response varies by Accept-Language", async () => {
    const response = await run(get("http://test/", { "accept-language": "fr" }), { available });

    expect(response.headers.get("vary")).toBe("Accept-Language");
  });

  it("adds to a Vary the action already set rather than replacing it", async () => {
    const response = await setLocale({ available })(get("http://test/"), async () =>
      Response.json({}, { headers: { vary: "Accept" } }),
    );

    expect(response.headers.get("vary")).toBe("Accept, Accept-Language");
  });

  it("does not repeat itself", async () => {
    const response = await setLocale({ available })(get("http://test/"), async () =>
      Response.json({}, { headers: { vary: "Accept-Language" } }),
    );

    expect(response.headers.get("vary")).toBe("Accept-Language");
  });

  it("does not leak the locale past the request", async () => {
    await run(get("http://test/?locale=fr"), { available });
    expect(i18n.locale).toBe("en");
  });

  it("translates inside the request", async () => {
    i18n.store("fr", { errors: { messages: { blank: "doit être rempli(e)" } } });

    const response = await setLocale({ available })(get("http://test/?locale=fr"), async () =>
      Response.json({ message: t("errors.messages.blank") }),
    );

    expect((await response.json()) as { message: string }).toEqual({
      message: "doit être rempli(e)",
    });
  });
});
