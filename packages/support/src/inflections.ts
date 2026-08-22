/**
 * Inflection rule registry.
 *
 * A direct port of `ActiveSupport::Inflector::Inflections`. The ordering
 * semantics matter and are easy to get wrong: Rails *prepends* every rule, so
 * the most recently declared rule is the first one tried. That is why the
 * catch-all `/$/ -> "s"` is declared first and consulted last.
 */

export type Rule = readonly [RegExp, string];

/**
 * Words that are the same in singular and plural.
 *
 * Rails matches these with `/\b(word1|word2|...)\Z/i`, which is why
 * "funky jeans" is uncountable but "miniseries" is not — a word boundary is
 * required before the match.
 */
export class Uncountables {
  #members: string[] = [];
  #pattern: RegExp | null = null;

  add(words: string[]): this {
    this.#members.push(...words.map((w) => w.toLowerCase()));
    this.#pattern = null;
    return this;
  }

  delete(word: string): void {
    const i = this.#members.indexOf(word);
    if (i !== -1) this.#members.splice(i, 1);
    this.#pattern = null;
  }

  toArray(): string[] {
    return [...this.#members];
  }

  uncountable(str: string): boolean {
    if (this.#members.length === 0) return false;
    this.#pattern ??= new RegExp(
      `\\b(?:${this.#members.map(escapeRegExp).join("|")})$`,
      "i",
    );
    return this.#pattern.test(str);
  }
}

export class Inflections {
  plurals: Rule[] = [];
  singulars: Rule[] = [];
  humans: Rule[] = [];
  uncountables = new Uncountables();
  acronyms: Record<string, string> = {};

  #acronymRegex: RegExp | null = null;

  /** `/(?=a)b/` — a pattern that never matches, Rails' empty-acronym sentinel. */
  get acronymRegex(): RegExp {
    if (this.#acronymRegex) return this.#acronymRegex;
    const keys = Object.keys(this.acronyms);
    this.#acronymRegex = keys.length
      ? new RegExp(keys.map(escapeRegExp).join("|"))
      : /(?=a)b/;
    return this.#acronymRegex;
  }

  acronym(word: string): void {
    this.acronyms[word.toLowerCase()] = word;
    this.#acronymRegex = null;
  }

  plural(rule: RegExp, replacement: string): void {
    this.uncountables.delete(rule.source);
    this.uncountables.delete(replacement);
    this.plurals.unshift([rule, replacement]);
  }

  singular(rule: RegExp, replacement: string): void {
    this.uncountables.delete(rule.source);
    this.uncountables.delete(replacement);
    this.singulars.unshift([rule, replacement]);
  }

  human(rule: RegExp, replacement: string): void {
    this.humans.unshift([rule, replacement]);
  }

  uncountable(...words: string[]): void {
    this.uncountables.add(words.flat());
  }

  /**
   * Declares an irregular pair such as person/people.
   *
   * Rails branches on whether the two words share a first letter, because the
   * generated rules have to preserve the casing of that letter. The shared
   * branch is the common one — every Rails default takes it.
   */
  irregular(singular: string, plural: string): void {
    this.uncountables.delete(singular);
    this.uncountables.delete(plural);

    const s0 = singular[0]!;
    const srest = singular.slice(1);
    const p0 = plural[0]!;
    const prest = plural.slice(1);

    if (s0.toUpperCase() === p0.toUpperCase()) {
      this.plural(new RegExp(`(${s0})${srest}$`, "i"), `$1${prest}`);
      this.plural(new RegExp(`(${p0})${prest}$`, "i"), `$1${prest}`);
      this.singular(new RegExp(`(${s0})${srest}$`, "i"), `$1${srest}`);
      this.singular(new RegExp(`(${p0})${prest}$`, "i"), `$1${srest}`);
    } else {
      // Ruby uses an inline `(?i)` flag to make only the tail case-insensitive.
      // JavaScript has no inline flags, so the tail is expanded letter by letter.
      const ci = (s: string) =>
        s.replace(/[a-zA-Z]/g, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);

      this.plural(new RegExp(`${s0.toUpperCase()}${ci(srest)}$`), p0.toUpperCase() + prest);
      this.plural(new RegExp(`${s0.toLowerCase()}${ci(srest)}$`), p0.toLowerCase() + prest);
      this.plural(new RegExp(`${p0.toUpperCase()}${ci(prest)}$`), p0.toUpperCase() + prest);
      this.plural(new RegExp(`${p0.toLowerCase()}${ci(prest)}$`), p0.toLowerCase() + prest);

      this.singular(new RegExp(`${s0.toUpperCase()}${ci(srest)}$`), s0.toUpperCase() + srest);
      this.singular(new RegExp(`${s0.toLowerCase()}${ci(srest)}$`), s0.toLowerCase() + srest);
      this.singular(new RegExp(`${p0.toUpperCase()}${ci(prest)}$`), s0.toUpperCase() + srest);
      this.singular(new RegExp(`${p0.toLowerCase()}${ci(prest)}$`), s0.toLowerCase() + srest);
    }
  }

  /** Drops rules so a test (or an app) can start from a clean slate. */
  clear(scope: "all" | "plurals" | "singulars" | "humans" | "uncountables" = "all"): void {
    if (scope === "all" || scope === "plurals") this.plurals = [];
    if (scope === "all" || scope === "singulars") this.singulars = [];
    if (scope === "all" || scope === "humans") this.humans = [];
    if (scope === "all" || scope === "uncountables") this.uncountables = new Uncountables();
  }
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Locale-keyed registries, mirroring `Inflector.inflections(:en)`. */
const registry = new Map<string, Inflections>();

export function inflections(locale = "en"): Inflections;
export function inflections(locale: string, configure: (i: Inflections) => void): Inflections;
export function inflections(
  locale = "en",
  configure?: (i: Inflections) => void,
): Inflections {
  let entry = registry.get(locale);
  if (!entry) {
    entry = new Inflections();
    registry.set(locale, entry);
    if (locale === "en") defaults(entry);
  }
  if (configure) configure(entry);
  return entry;
}

/** Resets a locale to Rails' stock rules. Used by tests. */
export function resetInflections(locale = "en"): Inflections {
  const fresh = new Inflections();
  if (locale === "en") defaults(fresh);
  registry.set(locale, fresh);
  return fresh;
}

/**
 * Rails' standard English inflections, in declaration order.
 *
 * Ported verbatim from activesupport/lib/active_support/inflections.rb. Rails
 * describes this rule set as frozen — it is deliberately incomplete, and is not
 * changed, so that existing applications keep working. We inherit that promise.
 */
function defaults(inflect: Inflections): void {
  inflect.plural(/$/, "s");
  inflect.plural(/s$/i, "s");
  inflect.plural(/^(ax|test)is$/i, "$1es");
  inflect.plural(/(octop|vir)us$/i, "$1i");
  inflect.plural(/(octop|vir)i$/i, "$1i");
  inflect.plural(/(alias|status)$/i, "$1es");
  inflect.plural(/(bu)s$/i, "$1ses");
  inflect.plural(/(buffal|tomat)o$/i, "$1oes");
  inflect.plural(/([ti])um$/i, "$1a");
  inflect.plural(/([ti])a$/i, "$1a");
  inflect.plural(/sis$/i, "ses");
  inflect.plural(/(?:([^f])fe|([lr])f)$/i, "$1$2ves");
  inflect.plural(/(hive)$/i, "$1s");
  inflect.plural(/([^aeiouy]|qu)y$/i, "$1ies");
  inflect.plural(/(x|ch|ss|sh)$/i, "$1es");
  inflect.plural(/(matr|vert|ind)(?:ix|ex)$/i, "$1ices");
  inflect.plural(/^(m|l)ouse$/i, "$1ice");
  inflect.plural(/^(m|l)ice$/i, "$1ice");
  inflect.plural(/^(ox)$/i, "$1en");
  inflect.plural(/^(oxen)$/i, "$1");
  inflect.plural(/(quiz)$/i, "$1zes");

  inflect.singular(/s$/i, "");
  inflect.singular(/(ss)$/i, "$1");
  inflect.singular(/(n)ews$/i, "$1ews");
  inflect.singular(/([ti])a$/i, "$1um");
  inflect.singular(
    /((a)naly|(b)a|(d)iagno|(p)arenthe|(p)rogno|(s)ynop|(t)he)(sis|ses)$/i,
    "$1sis",
  );
  inflect.singular(/(^analy)(sis|ses)$/i, "$1sis");
  inflect.singular(/([^f])ves$/i, "$1fe");
  inflect.singular(/(hive)s$/i, "$1");
  inflect.singular(/(tive)s$/i, "$1");
  inflect.singular(/([lr])ves$/i, "$1f");
  inflect.singular(/([^aeiouy]|qu)ies$/i, "$1y");
  inflect.singular(/(s)eries$/i, "$1eries");
  inflect.singular(/(m)ovies$/i, "$1ovie");
  inflect.singular(/(x|ch|ss|sh)es$/i, "$1");
  inflect.singular(/^(m|l)ice$/i, "$1ouse");
  inflect.singular(/(bus)(es)?$/i, "$1");
  inflect.singular(/(o)es$/i, "$1");
  inflect.singular(/(shoe)s$/i, "$1");
  inflect.singular(/(cris|test)(is|es)$/i, "$1is");
  inflect.singular(/^(a)x[ie]s$/i, "$1xis");
  inflect.singular(/(octop|vir)(us|i)$/i, "$1us");
  inflect.singular(/(alias|status)(es)?$/i, "$1");
  inflect.singular(/^(ox)en/i, "$1");
  inflect.singular(/(vert|ind)ices$/i, "$1ex");
  inflect.singular(/(matr)ices$/i, "$1ix");
  inflect.singular(/(quiz)zes$/i, "$1");
  inflect.singular(/(database)s$/i, "$1");

  inflect.irregular("person", "people");
  inflect.irregular("man", "men");
  inflect.irregular("child", "children");
  inflect.irregular("sex", "sexes");
  inflect.irregular("move", "moves");
  inflect.irregular("zombie", "zombies");

  inflect.uncountable(
    "equipment",
    "information",
    "rice",
    "money",
    "species",
    "series",
    "fish",
    "sheep",
    "jeans",
    "police",
  );
}
