/**
 * Internationalization.
 *
 * Mirrors the i18n gem's own suite (simple backend, interpolation,
 * pluralization, fallbacks) and the parts of it Rails leans on. Real locale
 * data where it matters: the plural tests use Polish and Arabic, because a
 * scheme that only ever sees English singular/plural is not tested at all.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  fallbackChain,
  I18n,
  i18n,
  interpolate,
  l,
  MissingTranslation,
  pluralFor,
  t,
} from "../src/i18n.js";

afterEach(() => {
  i18n.reset();
});

describe("interpolation", () => {
  it("fills placeholders", () => {
    expect(interpolate("Hello %{name}", { name: "Ada" })).toBe("Hello Ada");
  });

  it("fills the same one twice", () => {
    expect(interpolate("%{a} and %{a}", { a: "x" })).toBe("x and x");
  });

  // A visible %{name} is a bug report; the word "undefined" is a mystery.
  it("leaves one it has nothing for", () => {
    expect(interpolate("Hello %{name}", {})).toBe("Hello %{name}");
  });

  it("leaves text with no placeholders alone", () => {
    expect(interpolate("plain", { name: "x" })).toBe("plain");
  });
});

describe("fallbacks", () => {
  it("tries the region, then the language", () => {
    expect(fallbackChain("en-GB", "en")).toEqual(["en-GB", "en"]);
  });

  it("ends at the default locale", () => {
    expect(fallbackChain("fr", "en")).toEqual(["fr", "en"]);
    expect(fallbackChain("pt-BR", "en")).toEqual(["pt-BR", "pt", "en"]);
  });

  it("does not repeat the default", () => {
    expect(fallbackChain("en", "en")).toEqual(["en"]);
  });
});

describe("looking a key up", () => {
  it("finds a nested one", () => {
    i18n.store("en", { greetings: { hello: "Hello" } });
    expect(t("greetings.hello")).toBe("Hello");
  });

  it("takes a scope", () => {
    i18n.store("en", { greetings: { hello: "Hello" } });

    expect(t("hello", { scope: "greetings" })).toBe("Hello");
    expect(t("hello", { scope: ["greetings"] })).toBe("Hello");
  });

  it("interpolates", () => {
    i18n.store("en", { hello: "Hello %{name}" });
    expect(t("hello", { name: "Ada" })).toBe("Hello Ada");
  });

  // A page with one untranslated string is worth more than a 500, and the
  // marker is impossible to miss in review.
  it("marks a missing key rather than throwing", () => {
    expect(t("nothing.here")).toBe("translation missing: en.nothing.here");
  });

  it("takes a default instead", () => {
    expect(t("nothing.here", { default: "Fallback" })).toBe("Fallback");
    expect(t("nothing.here", { default: "Hello %{name}", name: "Ada" })).toBe("Hello Ada");
  });

  it("throws when told to, which is what a test suite wants", () => {
    const strict = new I18n();
    strict.raiseOnMissing = true;

    expect(() => strict.translate("nothing")).toThrow(MissingTranslation);
  });

  it("says whether a key is there", () => {
    i18n.store("en", { a: { b: "c" } });

    expect(i18n.exists("a.b")).toBe(true);
    expect(i18n.exists("a.c")).toBe(false);
  });

  // A key that names a branch rather than a leaf is a mistake, not a string.
  it("does not return a whole branch as a string", () => {
    i18n.store("en", { a: { b: "c" } });
    expect(t("a")).toBe("translation missing: en.a");
  });
});

describe("locales", () => {
  it("uses the one in effect", () => {
    i18n.store("en", { hello: "Hello" });
    i18n.store("fr", { hello: "Bonjour" });

    expect(i18n.withLocale("fr", () => t("hello"))).toBe("Bonjour");
    expect(t("hello")).toBe("Hello");
  });

  it("takes one for a single lookup", () => {
    i18n.store("fr", { hello: "Bonjour" });
    expect(t("hello", { locale: "fr" })).toBe("Bonjour");
  });

  it("falls back through the region to the language", () => {
    i18n.store("en", { hello: "Hello", colour: "Color" });
    i18n.store("en-GB", { colour: "Colour" });

    expect(t("colour", { locale: "en-GB" })).toBe("Colour");
    expect(t("hello", { locale: "en-GB" })).toBe("Hello");
  });

  it("falls back to the default locale", () => {
    i18n.store("en", { hello: "Hello" });
    i18n.store("fr", {});

    expect(t("hello", { locale: "fr" })).toBe("Hello");
  });

  it("lists what it has", () => {
    i18n.store("fr", { a: "a" });
    i18n.store("de", { a: "a" });

    expect(i18n.availableLocales).toEqual(["de", "en", "fr"]);
  });

  // A server answers a French request and an English one at the same time; a
  // global would give one of them the other's language.
  it("keeps concurrent requests apart", async () => {
    i18n.store("en", { hello: "Hello" });
    i18n.store("fr", { hello: "Bonjour" });

    const slow = i18n.withLocale("fr", async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return t("hello");
    });

    const fast = i18n.withLocale("en", async () => t("hello"));

    expect(await Promise.all([slow, fast])).toEqual(["Bonjour", "Hello"]);
  });

  it("merges into what is already stored", () => {
    i18n.store("en", { a: { b: "b" } });
    i18n.store("en", { a: { c: "c" } });

    expect(t("a.b")).toBe("b");
    expect(t("a.c")).toBe("c");
  });

  it("does not keep a reference to the object it was given", () => {
    const catalog = { a: "before" };
    i18n.store("de", catalog);
    catalog.a = "after";

    expect(t("a", { locale: "de" })).toBe("before");
  });
});

describe("pluralization", () => {
  it("picks one or other, by count", () => {
    i18n.store("en", { apples: { one: "an apple", other: "%{count} apples" } });

    expect(t("apples", { count: 1 })).toBe("an apple");
    expect(t("apples", { count: 5 })).toBe("5 apples");
  });

  it("honours a zero entry", () => {
    i18n.store("en", { apples: { zero: "no apples", one: "an apple", other: "%{count} apples" } });
    expect(t("apples", { count: 0 })).toBe("no apples");
  });

  it("uses `other` for zero when no zero was written", () => {
    i18n.store("en", { apples: { one: "an apple", other: "%{count} apples" } });
    expect(t("apples", { count: 0 })).toBe("0 apples");
  });

  // The reason this is on Intl.PluralRules rather than a one/other switch:
  // Polish has three forms, and choosing the wrong one is not a rounding
  // error to somebody reading it.
  it("gets Polish right", () => {
    const forms = { one: "plik", few: "pliki", many: "plików", other: "pliku" };

    expect(pluralFor(forms, 1, "pl")).toBe("plik");
    expect(pluralFor(forms, 3, "pl")).toBe("pliki");
    expect(pluralFor(forms, 5, "pl")).toBe("plików");
  });

  it("gets Arabic's six right", () => {
    const forms = { zero: "0", one: "1", two: "2", few: "few", many: "many", other: "other" };

    expect(pluralFor(forms, 2, "ar")).toBe("2");
    expect(pluralFor(forms, 3, "ar")).toBe("few");
    expect(pluralFor(forms, 11, "ar")).toBe("many");
    expect(pluralFor(forms, 100, "ar")).toBe("other");
  });

  // A catalog that only wrote one/other still has to work in a language with
  // more forms, or adding a locale would break every existing string.
  it("falls back to other when a form is missing", () => {
    expect(pluralFor({ one: "one", other: "other" }, 5, "pl")).toBe("other");
  });

  it("interpolates the count without being asked", () => {
    i18n.store("en", { apples: { one: "%{count} apple", other: "%{count} apples" } });
    expect(t("apples", { count: 7 })).toBe("7 apples");
  });
});

describe("localizing", () => {
  const date = new Date(Date.UTC(2026, 0, 15, 12));

  it("formats a date in the locale's conventions", () => {
    expect(l(date, { locale: "en-GB", format: { dateStyle: "short", timeZone: "UTC" } })).toBe(
      "15/01/2026",
    );
    expect(l(date, { locale: "en-US", format: { dateStyle: "short", timeZone: "UTC" } })).toBe(
      "1/15/26",
    );
  });

  it("formats a number in the locale's conventions", () => {
    expect(l(1234.5, { locale: "en" })).toBe("1,234.5");
    expect(l(1234.5, { locale: "de" })).toBe("1.234,5");
  });

  it("follows the locale in effect", () => {
    expect(i18n.withLocale("de", () => l(1234.5))).toBe("1.234,5");
  });
});

// The framework's own English lives under the gem's keys, so rails-i18n's
// translations of them drop in and work.
describe("the framework's messages", () => {
  it("are there under Rails' keys", () => {
    expect(t("errors.messages.blank")).toBe("can't be blank");
    expect(t("errors.messages.taken")).toBe("has already been taken");
  });

  it("count correctly", () => {
    expect(t("errors.messages.too_short", { count: 1 })).toBe(
      "is too short (minimum is 1 character)",
    );
    expect(t("errors.messages.too_short", { count: 8 })).toBe(
      "is too short (minimum is 8 characters)",
    );
  });

  it("can be translated without touching the framework", () => {
    i18n.store("fr", { errors: { messages: { blank: "doit être rempli(e)" } } });

    expect(i18n.withLocale("fr", () => t("errors.messages.blank"))).toBe("doit être rempli(e)");
  });
});
