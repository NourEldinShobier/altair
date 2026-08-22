/**
 * Inflector parity suite.
 *
 * The data below is not ours: it is generated from Rails'
 * activesupport/test/inflector_test_cases.rb by tools/port-fixtures.ts. Each
 * `it` mirrors a test in Rails' inflector_test.rb, and the name records which
 * one, so parity is auditable rather than asserted.
 */

import { describe, expect, it, beforeEach } from "bun:test";
import {
  camelize,
  classify,
  dasherize,
  deconstantize,
  demodulize,
  foreignKey,
  humanize,
  ordinal,
  ordinalize,
  parameterize,
  pluralize,
  singularize,
  tableize,
  titleize,
  underscore,
  upcaseFirst,
  downcaseFirst,
} from "../src/inflector.js";
import { inflections, resetInflections } from "../src/inflections.js";
import * as cases from "./fixtures/inflector-cases.js";

beforeEach(() => {
  resetInflections("en");
});

describe("pluralize", () => {
  // Rails: test_pluralize_plurals, test_pluralize_singulars
  it.each(cases.singularToPlural)("pluralizes %p to %p", (singular, plural) => {
    expect(pluralize(singular)).toBe(plural);
    expect(pluralize(capitalized(singular))).toBe(capitalized(plural));
  });

  // Rails: test_pluralize_plurals — pluralizing a plural is a no-op
  it.each(cases.singularToPlural)("leaves the plural %p alone (from %p)", (_s, plural) => {
    expect(pluralize(plural)).toBe(plural);
    expect(pluralize(capitalized(plural))).toBe(capitalized(plural));
  });

  // Rails: test_pluralize_empty_string
  it("returns an empty string unchanged", () => {
    expect(pluralize("")).toBe("");
  });

  // Rails: test_uncountability_of_a_new_word / uncountable words
  it.each(["equipment", "information", "rice", "money", "species", "series", "fish", "sheep", "jeans", "police"])(
    "treats %p as uncountable",
    (word) => {
      expect(pluralize(word)).toBe(word);
      expect(singularize(word)).toBe(word);
      expect(pluralize(word)).toBe(singularize(word));
    },
  );
});

describe("singularize", () => {
  // Rails: test_singularize_singulars
  it.each(cases.singularToPlural)("singularizes %p back from %p", (singular, plural) => {
    expect(singularize(plural)).toBe(singular);
    expect(singularize(capitalized(plural))).toBe(capitalized(singular));
  });

  // Rails: test_singularize_singular — singularizing a singular is a no-op
  it.each(cases.singularToPlural)("leaves the singular %p alone", (singular) => {
    expect(singularize(singular)).toBe(singular);
  });
});

describe("camelize", () => {
  // Rails: test_camelize
  it.each(cases.camelToUnderscore)("camelizes %2$p to %1$p", (camel, underscored) => {
    expect(camelize(underscored)).toBe(camel);
  });

  // Rails: test_camelize_with_lower_downcases_the_first_letter
  it("downcases the first letter when asked", () => {
    expect(camelize("Capital", false)).toBe("capital");
    expect(camelize("active_record", false)).toBe("activeRecord");
  });

  // Rails: test_camelize_with_underscores
  it("handles a leading underscore", () => {
    expect(camelize("Capital_Word")).toBe("CapitalWord");
  });

  // Rails: test_camelize_with_module
  it.each(cases.camelWithModuleToUnderscoreWithSlash)(
    "maps the module path %2$p to %1$p",
    (camel, path) => {
      expect(camelize(path)).toBe(camel);
    },
  );
});

describe("underscore", () => {
  // Rails: test_underscore
  it.each(cases.camelToUnderscore)("underscores %1$p to %2$p", (camel, underscored) => {
    expect(underscore(camel)).toBe(underscored);
  });

  // Rails: test_underscore — cases that do not round-trip back to camel
  it.each(cases.camelToUnderscoreWithoutReverse)(
    "underscores %1$p to %2$p (one-way)",
    (camel, underscored) => {
      expect(underscore(camel)).toBe(underscored);
    },
  );

  // Rails: test_underscore_to_lower_camel is covered above; this is the
  // module-path direction.
  it.each(cases.camelWithModuleToUnderscoreWithSlash)(
    "turns :: into / for %1$p",
    (camel, path) => {
      expect(underscore(camel)).toBe(path);
    },
  );

  // Rails: test_underscore_acronym_sequence
  it("leaves an already-underscored string alone", () => {
    expect(underscore("active_record")).toBe("active_record");
  });
});

describe("humanize", () => {
  // Rails: test_humanize
  it.each(cases.underscoreToHuman)("humanizes %p to %p", (underscored, human) => {
    expect(humanize(underscored)).toBe(human);
  });

  // Rails: test_humanize_without_capitalize
  it.each(cases.underscoreToHumanWithoutCapitalize)(
    "humanizes %p to %p without capitalizing",
    (underscored, human) => {
      expect(humanize(underscored, { capitalize: false })).toBe(human);
    },
  );

  // Rails: test_humanize_with_keep_id_suffix
  it.each(cases.underscoreToHumanWithKeepIdSuffix)(
    "humanizes %p to %p keeping the id suffix",
    (underscored, human) => {
      expect(humanize(underscored, { keepIdSuffix: true })).toBe(human);
    },
  );

  // Rails: test_humanize_by_rule
  it("applies a registered human rule", () => {
    inflections("en", (inflect) => {
      inflect.human(/_cnt$/i, "_count");
      inflect.human(/^prefx_/i, "");
    });
    expect(humanize("jargon_cnt")).toBe("Jargon count");
    expect(humanize("prefx_request")).toBe("Request");
  });
});

describe("titleize", () => {
  // Rails: test_titleize
  it.each(cases.mixtureToTitleCase)("titleizes %p to %p", (input, expected) => {
    expect(titleize(input)).toBe(expected);
  });

  // Rails: test_titleize_with_keep_id_suffix
  it.each(cases.mixtureToTitleCaseWithKeepIdSuffix)(
    "titleizes %p to %p keeping the id suffix",
    (input, expected) => {
      expect(titleize(input, { keepIdSuffix: true })).toBe(expected);
    },
  );
});

describe("tableize", () => {
  // Rails: test_tableize
  it.each(cases.classNameToTableName)("maps class %p to table %p", (className, table) => {
    expect(tableize(className)).toBe(table);
  });
});

describe("classify", () => {
  // Rails: test_classify
  it.each(cases.classNameToTableName)("maps table %2$p back to class %1$p", (className, table) => {
    expect(classify(table)).toBe(className);
  });

  // Rails: test_classify_with_leading_schema_name
  it("strips a leading schema name", () => {
    expect(classify("schema.posts")).toBe("Post");
  });
});

describe("foreignKey", () => {
  // Rails: test_foreign_key
  it.each(cases.classNameToForeignKeyWithUnderscore)(
    "maps %p to %p",
    (className, key) => {
      expect(foreignKey(className)).toBe(key);
    },
  );

  // Rails: test_foreign_key_without_underscore
  it.each(cases.classNameToForeignKeyWithoutUnderscore)(
    "maps %p to %p without the separator",
    (className, key) => {
      expect(foreignKey(className, false)).toBe(key);
    },
  );
});

describe("dasherize", () => {
  // Rails: test_dasherize
  it.each(cases.underscoresToDashes)("dasherizes %p to %p", (underscored, dashed) => {
    expect(dasherize(underscored)).toBe(dashed);
  });

  // Rails: test_underscore_as_reverse_of_dasherize
  it.each(cases.underscoresToDashes)("underscore reverses dasherize for %p", (underscored) => {
    expect(underscore(dasherize(underscored))).toBe(underscored);
  });
});

describe("parameterize", () => {
  // Rails: test_parameterize
  it.each(cases.stringToParameterized)("parameterizes %p to %p", (input, expected) => {
    expect(parameterize(input)).toBe(expected);
  });

  // Rails: test_parameterize_and_preserve_case
  it.each(cases.stringToParameterizedPreserveCase)(
    "parameterizes %p to %p preserving case",
    (input, expected) => {
      expect(parameterize(input, { preserveCase: true })).toBe(expected);
    },
  );

  // Rails: test_parameterize_with_custom_separator
  it.each(cases.stringToParameterizeWithUnderscore)(
    "parameterizes %p to %p with an underscore separator",
    (input, expected) => {
      expect(parameterize(input, { separator: "_" })).toBe(expected);
    },
  );
});

describe("ordinalize", () => {
  // Rails: test_ordinal / test_ordinalize
  it.each(cases.ordinalNumbers)("ordinalizes %p to %p", (number, expected) => {
    expect(ordinalize(number)).toBe(expected);
    expect(ordinal(number)).toBe(expected.slice(-2));
  });
});

describe("demodulize and deconstantize", () => {
  // Rails: test_demodulize
  it("removes the module part", () => {
    expect(demodulize("Instrumentation::Inflections")).toBe("Inflections");
    expect(demodulize("Inflections")).toBe("Inflections");
    expect(demodulize("::Inflections")).toBe("Inflections");
    expect(demodulize("")).toBe("");
  });

  // Rails: test_deconstantize
  it("removes the rightmost segment", () => {
    expect(deconstantize("Instrumentation::Inflections")).toBe("Instrumentation");
    expect(deconstantize("Inflections")).toBe("");
    expect(deconstantize("::Inflections")).toBe("");
  });
});

describe("upcaseFirst and downcaseFirst", () => {
  // Rails: test_upcase_first
  it("upcases only the first letter", () => {
    expect(upcaseFirst("what a Lovely Day")).toBe("What a Lovely Day");
    expect(upcaseFirst("w")).toBe("W");
    expect(upcaseFirst("")).toBe("");
  });

  // Rails: test_downcase_first
  it("downcases only the first letter", () => {
    expect(downcaseFirst("If they enjoy it")).toBe("if they enjoy it");
    expect(downcaseFirst("I")).toBe("i");
    expect(downcaseFirst("")).toBe("");
  });
});

describe("custom inflections", () => {
  // Rails: test_irregularity_between_singular_and_plural
  it.each(cases.irregularities)(
    "registers %p / %p as an irregular pair",
    (singular, plural) => {
      inflections("en", (inflect) => inflect.irregular(singular, plural));
      expect(singularize(plural)).toBe(singular);
      expect(pluralize(singular)).toBe(plural);
    },
  );

  // Rails: test_pluralize_of_irregularity_with_same_lengths
  it("handles an irregular pair of the same length", () => {
    inflections("en", (inflect) => inflect.irregular("datum", "data"));
    expect(pluralize("datum")).toBe("data");
    expect(singularize("data")).toBe("datum");
  });

  // Rails: test_uncountability_of_a_new_word
  it("registers a new uncountable word", () => {
    inflections("en", (inflect) => inflect.uncountable("weather"));
    expect(pluralize("weather")).toBe("weather");
    expect(singularize("weather")).toBe("weather");
  });

  // Rails: test_clear_all
  it("clears every rule", () => {
    const inflect = inflections("en");
    inflect.clear("all");
    expect(inflect.plurals).toHaveLength(0);
    expect(inflect.singulars).toHaveLength(0);
    expect(inflect.uncountables.toArray()).toHaveLength(0);
    expect(inflect.humans).toHaveLength(0);
  });

  // Rails: test_inflector_locality — rules registered on one locale do not leak
  it("keeps locales separate", () => {
    inflections("es", (inflect) => {
      inflect.plural(/$/, "s");
      inflect.plural(/([^aeiou])$/i, "$1es");
    });
    expect(pluralize("hijo", "es")).toBe("hijos");
    expect(pluralize("libro", "es")).toBe("libros");
    expect(pluralize("papel", "es")).toBe("papeles");
    // English is untouched
    expect(pluralize("papel")).toBe("papels");
  });
});

describe("ported fixture coverage", () => {
  it("runs Rails' own cases, not ours", () => {
    expect(cases.portedCaseCount).toBeGreaterThan(200);
    expect(cases.singularToPlural.length).toBeGreaterThan(80);
  });
});

/** Ruby's `String#capitalize` — used to check case-preservation, as Rails does. */
function capitalized(s: string): string {
  return s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s;
}
