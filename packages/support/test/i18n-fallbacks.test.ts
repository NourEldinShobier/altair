/**
 * What to show when a translation is missing, ported from
 * `activesupport/test/i18n_test.rb` and the fallback cases in
 * `railties/test/application/initializers/i18n_test.rb`.
 *
 * A partially translated application is the normal state, not the exception —
 * a string added in one language reaches the others weeks later — so these are
 * mostly about the gap rather than the happy path.
 */

import { describe, expect, it } from "bun:test";
import { MissingTranslation } from "../src/i18n.js";
import {
  fallBackTo,
  heading,
  htmlSafeTranslationKey,
  includeFallbacksModule,
  initFallbacks,
  initializeI18n,
  lookupWithFallback,
  missingName,
  missingTranslationFor,
  renderTranslation,
  setupRaiseOnMissingTranslationsConfig,
  validateFallbacks,
} from "../src/i18n-fallbacks.js";

describe("the chain a locale falls back through", () => {
  /**
   * `pt-BR` before `pt` before the default. Going straight to the default
   * skips the language the reader actually speaks.
   */
  it("tries the language before the default", () => {
    expect(fallBackTo("pt-BR")).toEqual(["pt-BR", "pt", "en"]);
  });

  it("handles a three-part tag", () => {
    expect(fallBackTo("zh-Hant-TW")).toEqual(["zh-Hant-TW", "zh-Hant", "zh", "en"]);
  });

  it("does not repeat the default", () => {
    expect(fallBackTo("en")).toEqual(["en"]);
  });

  it("takes a different default", () => {
    expect(fallBackTo("pt-BR", "fr")).toEqual(["pt-BR", "pt", "fr"]);
  });

  it("builds a chain per locale", () => {
    expect(initFallbacks(["en", "pt", "pt-BR"])).toEqual({
      en: ["en"],
      pt: ["pt", "en"],
      "pt-BR": ["pt-BR", "pt", "en"],
    });
  });

  /** A chain step with no translations behind it is a lookup that always misses. */
  it("drops a step nobody loaded", () => {
    expect(initFallbacks(["en", "pt-BR"])["pt-BR"]).toEqual(["pt-BR", "en"]);
  });

  /** Being the default does not put translations behind a locale. */
  it("drops the default too when nobody loaded it", () => {
    expect(initFallbacks(["pt-BR"], "en")["pt-BR"]).toEqual(["pt-BR"]);
  });
});

describe("checking the chains at boot", () => {
  it("accepts one whose every step was loaded", () => {
    expect(() =>
      validateFallbacks({ "pt-BR": ["pt-BR", "pt", "en"] }, ["pt-BR", "pt", "en"]),
    ).not.toThrow();
  });

  /**
   * A fallback to a locale nothing was loaded for does nothing and says
   * nothing, so a typo produces no error and no fallback.
   */
  it("refuses one naming a locale nobody loaded", () => {
    expect(() => validateFallbacks({ de: ["de", "en"] }, ["de"])).toThrow("en");
  });

  it("names the missing locale rather than the whole chain", () => {
    expect(() => validateFallbacks({ de: ["de", "fr", "en"] }, ["de", "en"])).toThrow(
      "names fr, which",
    );
  });

  it("says what would have happened", () => {
    expect(() => validateFallbacks({ de: ["de", "en"] }, ["de"])).toThrow("does nothing");
  });

  /** Off is a real choice for an application that wants gaps to be visible. */
  it("is on unless turned off", () => {
    expect(includeFallbacksModule(undefined)).toBe(true);
    expect(includeFallbacksModule(true)).toBe(true);
    expect(includeFallbacksModule(false)).toBe(false);
  });
});

describe("looking a key up across a chain", () => {
  const translations = {
    "pt-BR": { greeting: "Oi" },
    pt: { greeting: "Olá", farewell: "Adeus" },
    en: { greeting: "Hello", farewell: "Goodbye", welcome: "Welcome" },
  };

  it("takes the first locale that has it", () => {
    expect(lookupWithFallback("greeting", fallBackTo("pt-BR"), translations)).toEqual({
      value: "Oi",
      locale: "pt-BR",
    });
  });

  it("falls back to the language", () => {
    expect(lookupWithFallback("farewell", fallBackTo("pt-BR"), translations)).toEqual({
      value: "Adeus",
      locale: "pt",
    });
  });

  it("falls back to the default", () => {
    expect(lookupWithFallback("welcome", fallBackTo("pt-BR"), translations)?.locale).toBe("en");
  });

  it("finds nothing when nothing has it", () => {
    expect(lookupWithFallback("absent", fallBackTo("pt-BR"), translations)).toBeUndefined();
  });

  /**
   * A page silently rendered in the wrong language is the failure fallbacks
   * introduce, and the only way to notice is for something to say which locale
   * answered.
   */
  it("says which locale answered", () => {
    expect(lookupWithFallback("welcome", fallBackTo("pt-BR"), translations)?.locale).not.toBe(
      "pt-BR",
    );
  });
});

describe("when nothing answers", () => {
  /**
   * Raising in production turns a missing string into a 500 for a page that is
   * otherwise fine; humanising in development hides the omission from the
   * person who can fix it.
   */
  it("raises in development and test", () => {
    expect(setupRaiseOnMissingTranslationsConfig("development")).toBe("raise");
    expect(setupRaiseOnMissingTranslationsConfig("test")).toBe("raise");
  });

  it("humanises in production", () => {
    expect(setupRaiseOnMissingTranslationsConfig("production")).toBe("humanize");
  });

  it("raises the error the rest of the framework catches", () => {
    expect(() => missingTranslationFor("posts.title", ["en"], "raise")).toThrow(MissingTranslation);
  });

  it("humanises the key", () => {
    expect(missingTranslationFor("posts.index.page_title", ["en"], "humanize")).toBe("Page title");
  });

  it("can say so plainly instead", () => {
    expect(missingTranslationFor("posts.title", ["en"], "message")).toContain(
      "translation missing",
    );
  });

  /**
   * The last segment rather than the whole key: "Posts index title" is noise,
   * "Title" is at least a plausible heading.
   */
  it("humanises only the last segment", () => {
    expect(missingName("posts.index.title")).toBe("Title");
  });

  it("turns underscores into spaces", () => {
    expect(heading("page_title")).toBe("Page title");
    expect(heading("title")).toBe("Title");
  });
});

describe("markup in a translation", () => {
  /**
   * The suffix is the declaration. Treating every translation as HTML makes
   * each translator an author of unescaped markup — an injection with a person
   * in the loop, which is harder to spot than one with a request in it.
   */
  it("allows markup only where the key says so", () => {
    expect(htmlSafeTranslationKey("terms_html")).toBe(true);
    expect(htmlSafeTranslationKey("posts.terms_html")).toBe(true);
    expect(htmlSafeTranslationKey("posts.html.body")).toBe(true);
    expect(htmlSafeTranslationKey("posts.title")).toBe(false);
  });

  it("does not mistake a key that merely contains the letters", () => {
    expect(htmlSafeTranslationKey("htmlish")).toBe(false);
    expect(htmlSafeTranslationKey("posts.htmlx")).toBe(false);
  });

  it("interpolates", () => {
    expect(renderTranslation("greeting", "Hello %{name}", { name: "Ada" })).toBe("Hello Ada");
  });

  it("leaves a placeholder with no value alone", () => {
    expect(renderTranslation("greeting", "Hello %{name}", {})).toBe("Hello %{name}");
  });

  /**
   * The key declares that the *translator's* text is markup. It says nothing
   * about the values an application substitutes in, which are usually user
   * data.
   */
  it("escapes interpolated values into a markup key", () => {
    expect(renderTranslation("greeting_html", "Hi <b>%{name}</b>", { name: "<script>" })).toBe(
      "Hi <b>&lt;script&gt;</b>",
    );
  });

  it("leaves values alone for a plain key, which is escaped later anyway", () => {
    expect(renderTranslation("greeting", "Hi %{name}", { name: "<script>" })).toBe("Hi <script>");
  });
});

describe("setting i18n up", () => {
  it("builds the chains", () => {
    expect(initializeI18n({ availableLocales: ["en", "pt", "pt-BR"] }).fallbacks["pt-BR"]).toEqual([
      "pt-BR",
      "pt",
      "en",
    ]);
  });

  it("trims a chain to what was loaded", () => {
    expect(initializeI18n({ availableLocales: ["en", "pt-BR"] }).fallbacks["pt-BR"]).toEqual([
      "pt-BR",
      "en",
    ]);
  });

  it("uses each locale alone when fallbacks are off", () => {
    const setup = initializeI18n({ availableLocales: ["en", "pt-BR"], fallbacksEnabled: false });

    expect(setup.fallbacks["pt-BR"]).toEqual(["pt-BR"]);
  });

  /**
   * Validated once at boot rather than per lookup: a chain leading nowhere is
   * a configuration mistake, and those should be found by starting the
   * application rather than by a reader.
   */
  it("takes an explicit map", () => {
    const setup = initializeI18n({
      availableLocales: ["en", "de"],
      fallbacksEnabled: { de: ["en"] },
    });

    expect(setup.fallbacks["de"]).toEqual(["de", "en"]);
    expect(setup.fallbacks["en"]).toEqual(["en"]);
  });

  /**
   * The reason validation exists at all: a derived chain is trimmed to what
   * was loaded and so can never be wrong, but a map somebody wrote by hand can
   * name a locale that was never there.
   */
  it("refuses a map naming a locale nobody loaded", () => {
    expect(() =>
      initializeI18n({ availableLocales: ["de"], fallbacksEnabled: { de: ["en"] } }),
    ).toThrow("no translations were loaded");
  });

  it("takes the missing behaviour from the environment", () => {
    expect(initializeI18n({ env: "development" }).onMissing).toBe("raise");
    expect(initializeI18n({ env: "production" }).onMissing).toBe("humanize");
  });

  it("defaults to English alone", () => {
    expect(initializeI18n().availableLocales).toEqual(["en"]);
  });
});
