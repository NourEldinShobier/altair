/**
 * String inflections, ported from `ActiveSupport::Inflector`.
 *
 * Every transformation here has a Rails counterpart with the same name and the
 * same edge-case behaviour, including the odd ones (`"safe".pluralize` really
 * does give `"saves"` in Rails, and it does here too). Where Rails is quirky we
 * match the quirk — parity is the contract, and the ported fixtures enforce it.
 */

import { inflections, type Rule } from "./inflections.js";

/** Ruby's `String#capitalize`: upcase the first character, downcase the rest. */
function rubyCapitalize(s: string): string {
  if (s.length === 0) return s;
  return s[0]!.toUpperCase() + s.slice(1).toLowerCase();
}

/**
 * Rails' `apply_inflections`: try each rule newest-first and stop at the first
 * one that changes the word. Uncountable words are returned untouched.
 */
function applyInflections(word: string, rules: Rule[], locale: string): string {
  const result = word ?? "";
  if (result.length === 0) return result;
  if (inflections(locale).uncountables.uncountable(result)) return result;

  for (const [rule, replacement] of rules) {
    if (rule.test(result)) return result.replace(rule, replacement);
  }
  return result;
}

/**
 * Returns the plural form of the word.
 *
 *     pluralize("post")     // "posts"
 *     pluralize("person")   // "people"
 *     pluralize("fish")     // "fish"
 */
export function pluralize(word: string, locale = "en"): string {
  return applyInflections(word, inflections(locale).plurals, locale);
}

/**
 * Returns the singular form of the word.
 *
 *     singularize("posts")   // "post"
 *     singularize("people")  // "person"
 */
export function singularize(word: string, locale = "en"): string {
  return applyInflections(word, inflections(locale).singulars, locale);
}

/**
 * Converts an underscored string to UpperCamelCase (or lowerCamelCase).
 *
 *     camelize("active_record")          // "ActiveRecord"
 *     camelize("active_record", false)   // "activeRecord"
 *     camelize("active_record/errors")   // "ActiveRecord::Errors"
 */
export function camelize(term: string, uppercaseFirstLetter = true): string {
  const inflect = inflections();
  let string = String(term);

  if (!uppercaseFirstLetter) {
    const camelizeRe = new RegExp(`^(?:${inflect.acronymRegex.source}(?=\\b|[A-Z_])|\\w)`);
    string = string.replace(camelizeRe, (m) => m.toLowerCase());
  } else if (/^[a-z\d]*$/.test(string)) {
    return inflect.acronyms[string] ?? rubyCapitalize(string);
  } else {
    string = string.replace(/^[a-z\d]*/, (m) => inflect.acronyms[m] ?? rubyCapitalize(m));
  }

  string = string.replace(
    /(?:_|(\/))([a-z\d]*)/gi,
    (_m, slash: string | undefined, rest: string) =>
      `${slash ?? ""}${inflect.acronyms[rest] ?? rubyCapitalize(rest)}`,
  );

  return string.replaceAll("/", "::");
}

/**
 * Converts a CamelCased string to snake_case, and `::` to `/`.
 *
 *     underscore("ActiveRecord")          // "active_record"
 *     underscore("ActiveRecord::Errors")  // "active_record/errors"
 */
export function underscore(camelCasedWord: string): string {
  let word = String(camelCasedWord);
  if (!/[A-Z-]|::/.test(word)) return word;

  const inflect = inflections();
  word = word.replaceAll("::", "/");

  const acronymUnderscoreRe = new RegExp(
    `(?:(?<=([A-Za-z\\d]))|\\b)(${inflect.acronymRegex.source})(?=\\b|[^a-z])`,
    "g",
  );
  word = word.replace(
    acronymUnderscoreRe,
    (_m, prev: string | undefined, acr: string) => `${prev ? "_" : ""}${acr.toLowerCase()}`,
  );

  word = word.replace(/(?<=[A-Z])(?=[A-Z][a-z])|(?<=[a-z\d])(?=[A-Z])/g, "_");
  return word.replaceAll("-", "_").toLowerCase();
}

export interface HumanizeOptions {
  capitalize?: boolean;
  keepIdSuffix?: boolean;
}

/**
 * Makes an attribute name readable.
 *
 *     humanize("employee_salary")  // "Employee salary"
 *     humanize("author_id")        // "Author"
 */
export function humanize(
  lowerCaseAndUnderscoredWord: string,
  { capitalize = true, keepIdSuffix = false }: HumanizeOptions = {},
): string {
  const word = String(lowerCaseAndUnderscoredWord);
  let result = word;

  for (const [rule, replacement] of inflections().humans) {
    if (rule.test(result)) {
      result = result.replace(rule, replacement);
      break;
    }
  }

  result = result.replaceAll("_", " ").replace(/^\s+/, "");

  if (!keepIdSuffix && word.endsWith("_id") && result.endsWith(" id")) {
    result = result.slice(0, -3);
  }

  const inflect = inflections();
  return result.replace(/^\p{Ll}/u, (m) =>
    capitalize ? (inflect.acronyms[m] ?? m.toUpperCase()) : m,
  );
}

export interface TitleizeOptions {
  keepIdSuffix?: boolean;
}

/**
 * Capitalizes every word for use in a title.
 *
 *     titleize("active_record")  // "Active Record"
 *     titleize("david's code")   // "David's Code"
 */
export function titleize(word: string, { keepIdSuffix = false }: TitleizeOptions = {}): string {
  // Rails writes this as /\b(?<!\w['’`()])\p{Lower}/. Two things do not survive a
  // literal translation: Ruby's \w and \b are Unicode-aware against UTF-8 input
  // (so "ñoño" titleizes), while JavaScript's are ASCII-only. The first
  // lookbehind is the word boundary, spelled out over Unicode letters; the
  // second is Rails' own guard that keeps "david's" from becoming "David'S"
  // while still capitalizing "'fake" in "this was 'fake news'".
  return humanize(underscore(word), { keepIdSuffix }).replace(
    /(?<![\p{L}\p{N}_])(?<![\p{L}\p{N}_]['’`()])\p{Ll}/gu,
    (m) => m.toUpperCase(),
  );
}

/**
 * Class name to table name: pluralized and underscored.
 *
 *     tableize("Post")        // "posts"
 *     tableize("NodeChild")   // "node_children"
 */
export function tableize(className: string): string {
  return pluralize(underscore(className));
}

/**
 * Table name to class name. Singular names are not handled correctly, which is
 * Rails' documented behaviour: `classify("calculus")` gives `"Calculu"`.
 */
export function classify(tableName: string): string {
  return camelize(singularize(String(tableName).replace(/.*\./, "")));
}

/** Replaces underscores with dashes. */
export function dasherize(underscoredWord: string): string {
  return String(underscoredWord).replaceAll("_", "-");
}

/** Removes the module part of a constant path. */
export function demodulize(path: string): string {
  const s = String(path);
  const i = s.lastIndexOf("::");
  return i === -1 ? s : s.slice(i + 2);
}

/** Removes the rightmost segment of a constant path. */
export function deconstantize(path: string): string {
  const s = String(path);
  const i = s.lastIndexOf("::");
  return i === -1 ? "" : s.slice(0, i);
}

/**
 * Class name to foreign key.
 *
 *     foreignKey("Person")         // "person_id"
 *     foreignKey("Person", false)  // "personid"
 */
export function foreignKey(className: string, separateWithUnderscore = true): string {
  return underscore(demodulize(className)) + (separateWithUnderscore ? "_id" : "id");
}

export interface ParameterizeOptions {
  separator?: string | null;
  preserveCase?: boolean;
}

/**
 * Makes a string safe for use in a URL.
 *
 *     parameterize("Donald E. Knuth")  // "donald-e-knuth"
 *
 * ponytail: transliteration uses Unicode NFD decomposition rather than Rails'
 * hand-maintained i18n table, so most Latin accents fold correctly but
 * language-specific rules (German ä -> ae) do not. Swap in a real
 * transliteration table if an app needs those.
 */
export function parameterize(
  string: string,
  { separator = "-", preserveCase = false }: ParameterizeOptions = {},
): string {
  let result = String(string)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");

  const sep = separator ?? "";
  result = result.replace(/[^a-z0-9\-_]+/gi, sep);

  if (sep.length > 0) {
    const escaped = sep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(`${escaped}{2,}`, "g"), sep);
    result = result.replace(new RegExp(`^${escaped}|${escaped}$`, "gi"), "");
  }

  return preserveCase ? result : result.toLowerCase();
}

/**
 * The ordinal suffix for a number.
 *
 *     ordinal(1)   // "st"
 *     ordinal(11)  // "th"
 */
export function ordinal(number: number | string): string {
  const abs = Math.abs(Number(number));
  const hundredth = abs % 100;
  if (hundredth >= 11 && hundredth <= 13) return "th";
  switch (abs % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

/**
 * A number with its ordinal suffix attached.
 *
 *     ordinalize(1)     // "1st"
 *     ordinalize(-1021) // "-1021st"
 */
export function ordinalize(number: number | string): string {
  return `${number}${ordinal(number)}`;
}

/** Upcases the first letter, leaving the rest alone. */
export function upcaseFirst(string: string): string {
  const s = String(string);
  return s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : "";
}

/** Downcases the first letter, leaving the rest alone. */
export function downcaseFirst(string: string): string {
  const s = String(string);
  return s.length > 0 ? s[0]!.toLowerCase() + s.slice(1) : "";
}
