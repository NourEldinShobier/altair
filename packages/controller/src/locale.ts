/**
 * Choosing a locale for a request, ported from the `set_locale` around-action
 * every Rails internationalization guide starts with.
 *
 *     app.use(setLocale({ available: ["en", "fr", "de"] }))
 *
 * The locale is set for the duration of the request rather than assigned to a
 * global, because a server answers a French request and an English one at the
 * same time and a global would give one of them the other's language.
 */

import { i18n } from "@altair/support";
import type { Middleware } from "./middleware.js";

export interface LocaleOptions {
  /**
   * Locales the application actually has translations for.
   *
   * Required in spirit: without it, a header naming a language nobody
   * translated would be honoured, and every string would come back as a
   * missing-translation marker. Defaults to what has been stored.
   */
  available?: readonly string[];
  /** Used when nothing else matches. Defaults to `i18n.defaultLocale`. */
  fallback?: string;
  /** A query parameter that wins over the header, as Rails' guides suggest. */
  parameter?: string | false;
  /** Where else to look — a cookie, a subdomain, the signed-in person. */
  from?: (request: Request) => string | undefined | Promise<string | undefined>;
}

/**
 * Parses `Accept-Language` and returns the locales in the order asked for.
 *
 * Quality values decide the order. A browser sends `fr-CA,fr;q=0.9,en;q=0.8`
 * and means it: the fallback order is the person's own preference, and
 * ignoring `q` is how a site ends up in someone's third language.
 */
export function preferredLocales(header: string | null): string[] {
  if (!header) return [];

  return (
    header
      .split(",")
      .map((part) => {
        const [tag, ...parameters] = part.trim().split(";");
        const quality = parameters
          .map((parameter) => /^\s*q=([\d.]+)\s*$/.exec(parameter)?.[1])
          .find(Boolean);

        return { tag: (tag ?? "").trim(), quality: quality === undefined ? 1 : Number(quality) };
      })
      .filter((entry) => entry.tag && entry.tag !== "*" && !Number.isNaN(entry.quality))
      // A stable sort, so two locales of equal quality keep the order they were
      // written in — which is the order the browser meant.
      .sort((a, b) => b.quality - a.quality)
      .map((entry) => entry.tag)
  );
}

/**
 * The best available locale for a wanted one.
 *
 * `fr-CA` matches `fr-CA` first and then `fr`, because a page in French is
 * much closer to what someone asked for than a page in English.
 */
export function negotiateLocale(
  wanted: readonly string[],
  available: readonly string[],
): string | undefined {
  const normalized = new Map(available.map((locale) => [locale.toLowerCase(), locale]));

  for (const tag of wanted) {
    for (
      let candidate = tag.toLowerCase();
      candidate;
      candidate = candidate.replace(/-[^-]+$/, "")
    ) {
      const match = normalized.get(candidate);
      if (match) return match;
      if (!candidate.includes("-")) break;
    }
  }

  return undefined;
}

/** Sets the locale for the request. */
export function setLocale(options: LocaleOptions = {}): Middleware {
  return async (request, next) => {
    const available = options.available ?? i18n.availableLocales;
    const fallback = options.fallback ?? i18n.defaultLocale;

    const parameter = options.parameter ?? "locale";
    const asked = [
      ...(parameter === false
        ? []
        : [new URL(request.url).searchParams.get(parameter)].filter(
            (value): value is string => value !== null,
          )),
      ...[await options.from?.(request)].filter((value): value is string => value !== undefined),
      ...preferredLocales(request.headers.get("accept-language")),
    ];

    const locale = negotiateLocale(asked, available) ?? fallback;

    const response = await i18n.withLocale(locale, async () => await next(request));

    // The response depends on the header, so it has to say so. Without this a
    // shared cache stores the English page and hands it to the next French
    // reader — the same failure the fragment cache has when the locale is left
    // out of its key, one layer further out and much harder to see, because
    // the application it happens in front of is behaving perfectly.
    return withVary(response, "Accept-Language");
  };
}

/** Adds to `Vary` without dropping what is already there. */
function withVary(response: Response, value: string): Response {
  const headers = new Headers(response.headers);
  const existing = headers
    .get("vary")
    ?.split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  const merged = new Set([...(existing ?? []), value]);
  headers.set("vary", [...merged].join(", "));

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
