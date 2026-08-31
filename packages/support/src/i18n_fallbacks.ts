/**
 * What to show when a translation is missing, ported from
 * `ActiveSupport`'s i18n railtie — the fallback chain, the missing-translation
 * behaviour, and the rule about which keys may contain markup.
 *
 * `i18n.ts` looks a key up in one locale. This is what happens when it is not
 * there, which is the normal state of a translation file: a new string is added
 * in one language and appears in the others weeks later, so *every* application
 * with more than one locale spends most of its life partially translated.
 *
 * The decisions:
 *
 * - **A chain, not a single fallback.** `pt-BR` falls back to `pt`, then to the
 *   default. Falling straight to the default skips the language the reader
 *   actually speaks, which is worse than the regional variant being slightly
 *   off.
 * - **A missing translation is loud in development and soft in production.**
 *   Raising in production turns a missing string into a 500 for a page that is
 *   otherwise fine; showing a humanised key in development hides the omission
 *   from the person who can fix it.
 * - **Only keys that say so may contain markup.** A translation is content
 *   somebody edits in a spreadsheet, and treating all of it as HTML is an
 *   injection with a translator in the loop. Rails uses a `_html` suffix; the
 *   suffix is the declaration.
 */

import { MissingTranslation, missingTranslation } from "./i18n.js";

/** Rails' `I18n.fallbacks` chain for one locale. */
export function fallBackTo(locale: string, defaultLocale = "en"): string[] {
  const chain: string[] = [locale];

  // `pt-BR` before `pt` before the default. Going straight to the default
  // skips the language the reader actually speaks.
  const parts = locale.split("-");

  for (let index = parts.length - 1; index > 0; index -= 1) {
    chain.push(parts.slice(0, index).join("-"));
  }

  if (!chain.includes(defaultLocale)) chain.push(defaultLocale);

  return chain;
}

/**
 * Rails' `init_fallbacks` — the chains for every configured locale.
 *
 * A derived chain is trimmed to the locales that were actually loaded: `pt-BR`
 * names `pt` on the way to the default whether or not anybody wrote a `pt`
 * file, and a chain step with no translations behind it is just a lookup that
 * always misses. The default locale is trimmed on the same rule — being the
 * default does not put translations behind it.
 */
export function initFallbacks(
  locales: readonly string[],
  defaultLocale = "en",
): Record<string, string[]> {
  const loaded = new Set(locales);

  return Object.fromEntries(
    locales.map((locale) => [
      locale,
      fallBackTo(locale, defaultLocale).filter((each) => loaded.has(each)),
    ]),
  );
}

/**
 * Rails' `validate_fallbacks`.
 *
 * Every locale a chain names has to be one that was loaded. A fallback to a
 * locale with no translations behind it does nothing at all — the lookup walks
 * past it and the reader still gets whatever was next — so a typo in
 * `config.i18n.fallbacks` produces no error and no fallback, which is the
 * worst of the two. Raising at boot is the right time: the alternative is
 * finding out from a page rendered in the wrong language.
 */
export function validateFallbacks(
  chains: Record<string, readonly string[]>,
  available: readonly string[],
): void {
  for (const [locale, chain] of Object.entries(chains)) {
    const unloaded = chain.filter((each) => !available.includes(each));

    if (unloaded.length > 0) {
      throw new Error(
        `The fallback chain for ${JSON.stringify(locale)} (${chain.join(" → ")}) names ` +
          `${unloaded.join(", ")}, which no translations were loaded for. A fallback to a locale ` +
          `that is not there does nothing and says nothing, so boot is a better time to find ` +
          `that out than a page is.`,
      );
    }
  }
}

/**
 * Rails' `include_fallbacks_module` — whether fallbacks are on at all.
 *
 * `config.i18n.fallbacks` is `true`, `false`, or a map of locale to the
 * locales it falls back to. Anything that is not `false` turns them on; a map
 * both turns them on and says what they are.
 */
export function includeFallbacksModule(configured: unknown): boolean {
  // Off is a real choice: an application that wants a missing translation to be
  // *visible* rather than quietly answered in another language turns them off.
  return configured !== false;
}

/**
 * Looks a key up across a chain. Rails' fallback lookup.
 *
 * Returns which locale answered as well as the value, because a page silently
 * rendered in the wrong language is the failure fallbacks introduce — and the
 * only way to notice is for something to be able to say which one it used.
 */
export function lookupWithFallback(
  key: string,
  chain: readonly string[],
  translations: Record<string, Record<string, string>>,
): { value: string; locale: string } | undefined {
  for (const locale of chain) {
    const value = translations[locale]?.[key];

    if (value !== undefined) return { value, locale };
  }

  return undefined;
}

// --- when there is nothing to show -----------------------------------------

export type MissingBehaviour = "raise" | "humanize" | "message";

/**
 * Rails' `raise_on_missing_translations`.
 *
 * Raising in development and in test, where a missing string is a bug somebody
 * can fix now; humanising in production, where turning it into a 500 breaks a
 * page that is otherwise fine.
 */
export function setupRaiseOnMissingTranslationsConfig(env: string): MissingBehaviour {
  return env === "development" || env === "test" ? "raise" : "humanize";
}

/**
 * Rails' `missing_name` — the last segment of a key, humanised.
 *
 * The last segment rather than the whole key: `posts.index.title` shown to a
 * reader as "Posts index title" is noise, and "Title" is at least a plausible
 * heading.
 */
export function missingName(key: string): string {
  const last = key.split(".").at(-1) ?? key;

  return heading(last);
}

/** Rails' `humanize` for a key segment. */
export function heading(segment: string): string {
  const words = segment.replaceAll("_", " ").trim();

  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * What to render for a key nothing in the chain answered.
 *
 * Reuses `i18n.ts`'s `MissingTranslation` and its message rather than
 * declaring rivals — an error a caller catches has to be one class, not two
 * that happen to share a name.
 */
export function missingTranslationFor(
  key: string,
  chain: readonly string[],
  behaviour: MissingBehaviour,
): string {
  if (behaviour === "raise") throw new MissingTranslation(chain[0] ?? "", key);

  if (behaviour === "message") return missingTranslation(chain[0] ?? "", key);

  return missingName(key);
}

// --- markup in a translation ------------------------------------------------

/**
 * Whether a key's value may contain markup. Rails' `html_safe_translation_key?`.
 *
 * A `_html` suffix, or an `.html` segment. The suffix *is* the declaration:
 * translations are content somebody edits in a spreadsheet, and treating all
 * of it as HTML makes every translator an author of markup that renders
 * unescaped — an injection with a person in the loop, which is harder to spot
 * than one with a request in it.
 */
export function htmlSafeTranslationKey(key: string): boolean {
  return /(^|[._])html$/.test(key) || key.includes(".html.");
}

/**
 * The value of a translation, escaped unless the key said otherwise.
 *
 * Interpolated values are escaped even for an `_html` key, because the *key*
 * declares that the translator's text is markup — it says nothing about the
 * values an application substitutes into it, which are usually user data.
 */
export function renderTranslation(
  key: string,
  value: string,
  interpolations: Record<string, unknown> = {},
  escape: (text: string) => string = escapeHtml,
): string {
  const markup = htmlSafeTranslationKey(key);

  return value.replaceAll(/%\{(\w+)\}/g, (whole, name: string) => {
    const substitution = interpolations[name];

    if (substitution === undefined) return whole;

    const text = String(substitution);

    return markup ? escape(text) : text;
  });
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Rails' `initialize_i18n` — what an application configures at boot. */
export interface I18nSetup {
  defaultLocale: string;
  availableLocales: string[];
  fallbacks: Record<string, string[]>;
  onMissing: MissingBehaviour;
}

/**
 * Rails' `initialize_i18n`.
 *
 * Validates the chains at boot, which is the whole point of doing this once
 * rather than per lookup: a chain that leads nowhere is a configuration
 * mistake, and configuration mistakes should be found by starting the
 * application rather than by a reader.
 */
export function initializeI18n({
  defaultLocale = "en",
  availableLocales = [defaultLocale],
  env = "production",
  fallbacksEnabled,
}: {
  defaultLocale?: string;
  availableLocales?: string[];
  env?: string;
  /** `true`, `false`, or Rails' explicit `{ locale: [...] }` map. */
  fallbacksEnabled?: boolean | Record<string, readonly string[]>;
} = {}): I18nSetup {
  const fallbacks = !includeFallbacksModule(fallbacksEnabled)
    ? Object.fromEntries(availableLocales.map((locale) => [locale, [locale]]))
    : typeof fallbacksEnabled === "object"
      ? // An explicit map is the reason validation exists: a derived chain always
        // begins at the locale itself and so can never lead nowhere, but a map
        // somebody wrote by hand can name a locale that was never loaded.
        Object.fromEntries(
          availableLocales.map((locale) => [locale, [locale, ...(fallbacksEnabled[locale] ?? [])]]),
        )
      : initFallbacks(availableLocales, defaultLocale);

  validateFallbacks(fallbacks, availableLocales);

  return {
    defaultLocale,
    availableLocales: [...availableLocales],
    fallbacks,
    onMissing: setupRaiseOnMissingTranslationsConfig(env),
  };
}
