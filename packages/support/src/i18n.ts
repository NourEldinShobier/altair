/**
 * Internationalization, ported from the `i18n` gem as Rails uses it.
 *
 * Rails puts every string an application shows a person behind a key, so that
 * translating it later is a data problem rather than a code problem — and so
 * that the framework's own messages ("can't be blank") can be translated
 * without anyone editing the framework.
 *
 *     i18n.store("fr", { errors: { messages: { blank: "doit être rempli" } } })
 *     i18n.withLocale("fr", () => t("errors.messages.blank"))
 *
 * Keys and interpolation follow the gem exactly — dotted keys, `%{name}`
 * placeholders, `one`/`other` plural entries — so a Rails locale file works
 * here unchanged. That is the whole reason not to invent a nicer syntax: the
 * translations already exist, in forty languages, in rails-i18n.
 *
 * One thing is better than the gem rather than the same: plural categories
 * come from `Intl.PluralRules`, so Polish gets `few` and `many` and Arabic
 * gets all six, without the CLDR pluralization plugin Rails needs. Choosing
 * the wrong plural form is not a rounding error to someone reading it.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export type TranslationValue = string | number | { [key: string]: TranslationValue };
export type Catalog = { [key: string]: TranslationValue };

export interface TranslateOptions {
  /** Prefixed to the key, as Rails' `scope:`. */
  scope?: string | string[];
  /** Used when the key is missing, instead of the missing-translation marker. */
  default?: string;
  /** Selects a plural form, and is interpolated as `%{count}`. */
  count?: number;
  /** Overrides the ambient locale for this lookup. */
  locale?: string;
  /** Everything else is interpolated into `%{placeholders}`. */
  [key: string]: unknown;
}

/** What comes back for a key nobody translated. Rails' wording. */
export function missingTranslation(locale: string, key: string): string {
  return `translation missing: ${locale}.${key}`;
}

export class MissingTranslation extends Error {
  constructor(
    readonly locale: string,
    readonly key: string,
  ) {
    super(`${missingTranslation(locale, key)}`);
    this.name = "MissingTranslation";
  }
}

/**
 * Fills `%{placeholders}`.
 *
 * A placeholder with nothing to fill it is left as written rather than
 * replaced with "undefined", because a visible `%{name}` in a page is a bug
 * report and the word "undefined" is a mystery.
 */
export function interpolate(text: string, values: Record<string, unknown>): string {
  return text.replaceAll(/%\{(\w+)\}/gu, (whole, name: string) =>
    name in values ? String(values[name]) : whole,
  );
}

/**
 * The locale to fall back through: `en-GB` tries `en-GB`, then `en`.
 *
 * A region has its own spellings and rarely its own vocabulary, so falling
 * back to the language is almost always right and is what the gem's fallback
 * plugin does.
 */
export function fallbackChain(locale: string, defaultLocale: string): string[] {
  const chain: string[] = [];

  for (let candidate = locale; candidate; candidate = candidate.replace(/[-_][^-_]+$/, "")) {
    chain.push(candidate);
    if (!/[-_]/.test(candidate)) break;
  }

  if (!chain.includes(defaultLocale)) chain.push(defaultLocale);
  return chain;
}

function deepMerge(into: Catalog, from: Catalog): Catalog {
  for (const [key, value] of Object.entries(from)) {
    const existing = into[key];

    if (
      value !== null &&
      typeof value === "object" &&
      existing !== null &&
      typeof existing === "object"
    ) {
      deepMerge(existing as Catalog, value as Catalog);
    } else {
      into[key] = value;
    }
  }

  return into;
}

function lookupPath(catalog: Catalog, path: string[]): TranslationValue | undefined {
  let value: TranslationValue | undefined = catalog;

  for (const segment of path) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Catalog)[segment];
  }

  return value;
}

/** The locale in effect for the current request, if one was set. */
const scopedLocale = new AsyncLocalStorage<string>();

export class I18n {
  defaultLocale = "en";
  /** Throws instead of returning the marker. Worth turning on in tests. */
  raiseOnMissing = false;

  #catalogs = new Map<string, Catalog>();
  #locale: string | undefined;

  /**
   * The locale in effect.
   *
   * Per request rather than per process: a server handles a French request and
   * an English one at the same time, and a global that the last request won
   * would translate one of them wrongly.
   */
  get locale(): string {
    return scopedLocale.getStore() ?? this.#locale ?? this.defaultLocale;
  }

  set locale(locale: string) {
    this.#locale = locale;
  }

  /** Every locale something has been stored for. */
  get availableLocales(): string[] {
    return [...this.#catalogs.keys()].sort();
  }

  /** Adds translations, merging into whatever is already there. */
  store(locale: string, catalog: Catalog): void {
    const existing = this.#catalogs.get(locale);
    this.#catalogs.set(locale, existing ? deepMerge(existing, catalog) : structuredClone(catalog));
  }

  /** Runs a block with a locale in effect. Rails' `with_locale`. */
  withLocale<T>(locale: string, body: () => T): T {
    return scopedLocale.run(locale, body);
  }

  /** Whether a key resolves, without producing a marker for it. */
  exists(key: string, locale = this.locale): boolean {
    return this.#lookup(key, locale) !== undefined;
  }

  #lookup(key: string, locale: string): TranslationValue | undefined {
    const path = key.split(".");

    for (const candidate of fallbackChain(locale, this.defaultLocale)) {
      const catalog = this.#catalogs.get(candidate);
      if (!catalog) continue;

      const found = lookupPath(catalog, path);
      if (found !== undefined) return found;
    }

    return undefined;
  }

  /**
   * Rails' `I18n.t`.
   *
   * Missing keys produce `translation missing: en.some.key` rather than
   * throwing, because a page with one untranslated string is worth more than a
   * 500, and the marker is impossible to miss in review.
   */
  translate(key: string, options: TranslateOptions = {}): string {
    const { scope, default: fallback, count, locale = this.locale, ...values } = options;

    const scopes = scope === undefined ? [] : Array.isArray(scope) ? scope : [scope];
    const scoped = [...scopes, key].join(".");

    let entry = this.#lookup(scoped, locale);

    if (entry !== undefined && count !== undefined && typeof entry === "object") {
      entry = pluralFor(entry as Catalog, count, locale);
    }

    if (entry === undefined || typeof entry === "object") {
      if (fallback !== undefined) {
        return interpolate(fallback, { ...values, ...(count === undefined ? {} : { count }) });
      }
      if (this.raiseOnMissing) throw new MissingTranslation(locale, scoped);

      return missingTranslation(locale, scoped);
    }

    return interpolate(String(entry), {
      ...values,
      ...(count === undefined ? {} : { count }),
    });
  }

  /**
   * Rails' `I18n.l`: a date or a number in the conventions of a locale.
   *
   * `Intl` does the work. Rails carries format strings per locale in YAML
   * because Ruby has no equivalent; the platform has one, and it is kept up to
   * date by people who track CLDR for a living.
   */
  localize(
    value: Date | number,
    options: {
      locale?: string;
      format?: Intl.DateTimeFormatOptions | Intl.NumberFormatOptions;
    } = {},
  ): string {
    const locale = options.locale ?? this.locale;

    if (typeof value === "number") {
      return new Intl.NumberFormat(locale, options.format as Intl.NumberFormatOptions).format(
        value,
      );
    }

    return new Intl.DateTimeFormat(
      locale,
      (options.format as Intl.DateTimeFormatOptions) ?? { dateStyle: "long" },
    ).format(value);
  }

  /** Forgets everything. For tests. */
  reset(): void {
    this.#catalogs.clear();
    this.#locale = undefined;
    this.raiseOnMissing = false;
    this.defaultLocale = "en";
    this.store("en", EN);
  }
}

/**
 * Picks the plural form for a count.
 *
 * `Intl.PluralRules` gives the CLDR category, and the entry is consulted for
 * it, then for `other` — so a catalog that only wrote `one`/`other` still
 * works in a language with more forms, and one that wrote all six is used in
 * full. Zero is special-cased the way the gem allows: a catalog with a `zero`
 * key means it, even in languages where CLDR calls zero `other`.
 */
export function pluralFor(entry: Catalog, count: number, locale: string): TranslationValue {
  if (count === 0 && entry.zero !== undefined) return entry.zero;

  const category = new Intl.PluralRules(locale).select(count);
  return entry[category] ?? entry.other ?? entry.one ?? "";
}

/**
 * The framework's own English, under the keys the gem uses.
 *
 * Word for word what Rails ships, so a page that shows a validation error
 * reads identically — and so rails-i18n's translation of these keys, in forty
 * languages, drops in and works.
 */
export const EN: Catalog = {
  // Rails' own `datetime.distance_in_words`, key for key, so a catalog from
  // rails-i18n drops in and translates this without anything being renamed.
  datetime: {
    distance_in_words: {
      half_a_minute: "half a minute",
      less_than_x_seconds: { one: "less than 1 second", other: "less than %{count} seconds" },
      x_seconds: { one: "1 second", other: "%{count} seconds" },
      less_than_x_minutes: { one: "less than a minute", other: "less than %{count} minutes" },
      x_minutes: { one: "1 minute", other: "%{count} minutes" },
      about_x_hours: { one: "about 1 hour", other: "about %{count} hours" },
      x_days: { one: "1 day", other: "%{count} days" },
      about_x_months: { one: "about 1 month", other: "about %{count} months" },
      x_months: { one: "1 month", other: "%{count} months" },
      about_x_years: { one: "about 1 year", other: "about %{count} years" },
      over_x_years: { one: "over 1 year", other: "over %{count} years" },
      almost_x_years: { one: "almost 1 year", other: "almost %{count} years" },
    },
  },
  errors: {
    format: "%{attribute} %{message}",
    messages: {
      blank: "can't be blank",
      present: "must be blank",
      too_short: {
        one: "is too short (minimum is 1 character)",
        other: "is too short (minimum is %{count} characters)",
      },
      too_long: {
        one: "is too long (maximum is 1 character)",
        other: "is too long (maximum is %{count} characters)",
      },
      wrong_length: {
        one: "is the wrong length (should be 1 character)",
        other: "is the wrong length (should be %{count} characters)",
      },
      invalid: "is invalid",
      inclusion: "is not included in the list",
      exclusion: "is reserved",
      not_a_number: "is not a number",
      not_an_integer: "must be an integer",
      greater_than: "must be greater than %{count}",
      greater_than_or_equal_to: "must be greater than or equal to %{count}",
      less_than: "must be less than %{count}",
      less_than_or_equal_to: "must be less than or equal to %{count}",
      taken: "has already been taken",
      // Rails' message for a required `belongs_to` with nothing on the other end.
      required: "must exist",
      // Rails names the attribute here, and rails-i18n's translations of this
      // key all carry the placeholder, so dropping it would show a raw
      // "%{attribute}" the moment a catalog was loaded.
      confirmation: "doesn't match %{attribute}",
      accepted: "must be accepted",
    },
    template: {
      header: {
        one: "1 error prohibited this record from being saved",
        other: "%{count} errors prohibited this record from being saved",
      },
      body: "There were problems with the following fields:",
    },
  },
};

/** The one every part of the framework reads. Rails' `I18n`. */
export const i18n = new I18n();
i18n.store("en", EN);

/** Rails' `t`. A function rather than a method, so it imports on its own. */
export function t(key: string, options: TranslateOptions = {}): string {
  return i18n.translate(key, options);
}

/** Rails' `l`. */
export function l(
  value: Date | number,
  options: { locale?: string; format?: Intl.DateTimeFormatOptions | Intl.NumberFormatOptions } = {},
): string {
  return i18n.localize(value, options);
}
