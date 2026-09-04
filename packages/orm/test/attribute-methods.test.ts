/**
 * Generating a method per column, ported from
 * `activemodel/test/cases/attribute_methods_test.rb` and the
 * `dangerous_attribute` cases in
 * `activerecord/test/cases/attribute_methods_test.rb`.
 *
 * The part worth testing hardest is what it refuses. A column named `save`
 * generates a reader that replaces the real one, and the symptom is not an
 * error: `save` returns the column's value, the record never persists, and the
 * request succeeds.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  AttributeMethodPattern,
  AttributeMethodPatternSet,
  BASE_PATTERN,
  DangerousAttributeError,
  FRAMEWORK_METHODS,
  aliasAttributeMethodDefinition,
  attributeAlias,
  attributeMethod,
  attributeMethodsGenerated,
  attributeWriterMissing,
  dangerousAttributeMethod,
  dangerousAttributeMethods,
  dangerousClassMethod,
  defineAccessors,
  defineAttributeMethod,
  defineAttributeMethodPattern,
  defineAttributeMethods,
  defineReaders,
  defineWriters,
  eagerlyGenerateAliasAttributeMethods,
  generateAliasAttributeMethods,
  generateAliasAttributes,
  initializeGeneratedModules,
  originOf,
  setEagerlyGenerateAliasAttributeMethods,
  undefineAttributeMethods,
} from "../src/attribute-methods.js";

afterEach(() => {
  setEagerlyGenerateAliasAttributeMethods(true);
});

const reader = BASE_PATTERN;
const writer = new AttributeMethodPattern("", "=");
const changed = new AttributeMethodPattern("", "_changed");
const prefixed = new AttributeMethodPattern("reset_", "");

describe("a pattern", () => {
  it("names the method it generates", () => {
    expect(reader.methodName("title")).toBe("title");
    expect(writer.methodName("title")).toBe("title=");
    expect(changed.methodName("title")).toBe("title_changed");
    expect(prefixed.methodName("title")).toBe("reset_title");
  });

  it("names what the generated method delegates to", () => {
    expect(changed.proxyTarget).toBe("attribute_changed");
    expect(writer.proxyTarget).toBe("attribute=");
  });

  it("finds the attribute in a method name", () => {
    expect(changed.matchedAttributeName("title_changed")).toBe("title");
    expect(prefixed.matchedAttributeName("reset_title")).toBe("title");
  });

  it("matches anything at all when it has no affix", () => {
    expect(reader.matchedAttributeName("title")).toBe("title");
  });

  it("finds nothing in a name that does not fit", () => {
    expect(changed.matchedAttributeName("title")).toBeUndefined();
    expect(prefixed.matchedAttributeName("title")).toBeUndefined();
  });

  /**
   * Without the length check the suffix `_changed` matches the method
   * `_changed` itself and yields an attribute named the empty string — which
   * then generates methods called `_changed` and `=`.
   */
  it("finds nothing in a name that is only the affix", () => {
    expect(changed.matchedAttributeName("_changed")).toBeUndefined();
    expect(prefixed.matchedAttributeName("reset_")).toBeUndefined();
  });

  /**
   * Long enough to pass the length check but starting with something else —
   * the only shape that tells "checked the prefix" apart from "was too short".
   */
  it("finds nothing in a long name with the wrong prefix", () => {
    expect(prefixed.matchedAttributeName("published_at_yesterday")).toBeUndefined();
  });

  it("finds nothing in a long name with the wrong suffix", () => {
    expect(changed.matchedAttributeName("title_was_updated")).toBeUndefined();
  });

  it("says whether it adds anything", () => {
    expect(reader.isAffixed).toBe(false);
    expect(changed.isAffixed).toBe(true);
  });

  it("carries both halves for an affix", () => {
    const both = new AttributeMethodPattern("reset_", "!");

    expect(both.methodName("title")).toBe("reset_title!");
    expect(both.matchedAttributeName("reset_title!")).toBe("title");
  });
});

describe("a set of patterns", () => {
  const patterns = new AttributeMethodPatternSet([reader, writer, changed]);
  const attributes = new Set(["title", "body"]);

  it("resolves a name to an attribute", () => {
    expect(patterns.matchedAttributeName("title_changed", attributes)).toBe("title");
  });

  it("resolves nothing for an attribute nobody declared", () => {
    expect(patterns.matchedAttributeName("nonsense_changed", attributes)).toBeUndefined();
  });

  /** This runs on every method call that misses, so it checks affixes first. */
  it("offers nothing for a name matching no affix", () => {
    expect(patterns.matching("something")).toBeUndefined();
  });

  it("offers the affixed patterns for a name that could match", () => {
    expect(patterns.matching("title_changed")).toHaveLength(2);
  });

  it("offers nothing when no pattern is affixed", () => {
    expect(new AttributeMethodPatternSet([reader]).matching("anything")).toBeUndefined();
  });

  it("grows without changing what it grew from", () => {
    const base = new AttributeMethodPatternSet([reader]);
    const grown = base.with(changed);

    expect(base.patterns).toHaveLength(1);
    expect(grown.patterns).toHaveLength(2);
  });

  it("has the plain reader by default", () => {
    expect(new AttributeMethodPatternSet().patterns).toEqual([BASE_PATTERN]);
  });
});

describe("what it refuses", () => {
  /**
   * The whole point. The generated reader replaces the real `save`, so the
   * record never persists and nothing reports a problem.
   */
  it("refuses a column that would replace a framework method", () => {
    const generated = initializeGeneratedModules();

    expect(() => defineAttributeMethod(generated, "save", new AttributeMethodPatternSet())).toThrow(
      DangerousAttributeError,
    );
  });

  it("says what the column was and what it would have replaced", () => {
    const generated = initializeGeneratedModules();

    expect(() => defineAttributeMethod(generated, "save", new AttributeMethodPatternSet())).toThrow(
      "save",
    );
  });

  it("suggests the way out", () => {
    const generated = initializeGeneratedModules();

    expect(() =>
      defineAttributeMethod(generated, "errors", new AttributeMethodPatternSet()),
    ).toThrow("alias_attribute");
  });

  it("refuses one generated through a suffix too", () => {
    const generated = initializeGeneratedModules();
    const patterns = new AttributeMethodPatternSet([new AttributeMethodPattern("", "s")]);

    expect(() => defineAttributeMethod(generated, "error", patterns)).toThrow(
      DangerousAttributeError,
    );
  });

  /**
   * The distinction that matters: the application's own method on the model is
   * a deliberate override and has to keep working.
   */
  it("leaves a method the application defined alone", () => {
    const generated = initializeGeneratedModules();
    const own = new Set(["title"]);

    defineAttributeMethod(generated, "title", new AttributeMethodPatternSet(), {
      applicationMethods: own,
    });

    expect(attributeMethod(generated, "title")).toBeUndefined();
  });

  it("replaces the application's own when told to explicitly", () => {
    const generated = initializeGeneratedModules();

    defineAttributeMethodPattern(generated, reader, "title", {
      applicationMethods: new Set(["title"]),
      override: true,
    });

    expect(attributeMethod(generated, "title")).toBeDefined();
  });

  /** Even an explicit override does not get to replace the framework's. */
  it("still refuses the framework's under an override", () => {
    const generated = initializeGeneratedModules();

    expect(() =>
      defineAttributeMethodPattern(generated, reader, "save", { override: true }),
    ).toThrow(DangerousAttributeError);
  });

  it("allows an ordinary column", () => {
    const generated = initializeGeneratedModules();

    defineAttributeMethod(generated, "title", new AttributeMethodPatternSet());

    expect(attributeMethod(generated, "title")).toEqual({
      proxyTarget: "attribute",
      attribute: "title",
    });
  });

  /** Not everything on the prototype: `name` and `id` are ordinary columns. */
  it("does not refuse a name that merely exists somewhere", () => {
    expect(FRAMEWORK_METHODS.has("name")).toBe(false);
    expect(FRAMEWORK_METHODS.has("id")).toBe(false);
  });

  it("says where a method comes from", () => {
    expect(originOf("save")).toBe("framework");
    expect(originOf("title", new Set(["title"]))).toBe("application");
    expect(originOf("title")).toBe("none");
  });

  it("lists every dangerous name a model would generate", () => {
    const patterns = new AttributeMethodPatternSet([reader, writer]);

    expect(dangerousAttributeMethods(["save", "title"], patterns)).toEqual(["save"]);
  });

  it("reports a dangerous method directly", () => {
    expect(dangerousAttributeMethod("save")).toBe(true);
    expect(dangerousAttributeMethod("title")).toBe(false);
  });

  it("knows the dangerous class methods too", () => {
    expect(dangerousClassMethod("find")).toBe(true);
    expect(dangerousClassMethod("published")).toBe(false);
  });
});

describe("generating", () => {
  it("starts with nothing generated", () => {
    const generated = initializeGeneratedModules();

    expect(attributeMethodsGenerated(generated)).toBe(false);
    expect(generated.methods.size).toBe(0);
  });

  it("generates every pattern for every attribute", () => {
    const generated = initializeGeneratedModules();
    const patterns = new AttributeMethodPatternSet([reader, writer, changed]);

    defineAttributeMethods(generated, ["title", "body"], patterns);

    expect(generated.methods.size).toBe(6);
    expect(attributeMethodsGenerated(generated)).toBe(true);
  });

  it("records which attributes it generated for", () => {
    const generated = initializeGeneratedModules();

    defineAttributeMethods(generated, ["title"], new AttributeMethodPatternSet());

    expect(generated.attributes.has("title")).toBe(true);
  });

  it("generates readers alone", () => {
    const generated = initializeGeneratedModules();

    defineReaders(generated, ["title"]);

    expect(attributeMethod(generated, "title")).toBeDefined();
    expect(attributeMethod(generated, "title=")).toBeUndefined();
  });

  it("generates writers alone", () => {
    const generated = initializeGeneratedModules();

    defineWriters(generated, ["title"]);

    expect(attributeMethod(generated, "title=")).toBeDefined();
    expect(attributeMethod(generated, "title")).toBeUndefined();
  });

  it("generates both", () => {
    const generated = initializeGeneratedModules();

    defineAccessors(generated, ["title"]);

    expect(attributeMethod(generated, "title")).toBeDefined();
    expect(attributeMethod(generated, "title=")).toBeDefined();
  });

  /**
   * After a migration in a running process: the columns changed, so methods
   * generated from the old ones read attributes that are not there.
   */
  it("forgets them", () => {
    const generated = initializeGeneratedModules();
    defineAttributeMethods(generated, ["title"], new AttributeMethodPatternSet());

    undefineAttributeMethods(generated);

    expect(generated.methods.size).toBe(0);
    expect(generated.attributes.size).toBe(0);
    expect(attributeMethodsGenerated(generated)).toBe(false);
  });
});

describe("aliases", () => {
  /**
   * Every pattern, not only the reader: an alias giving you `name` but not
   * `name=` is worse than none, because the gap is found one method at a time.
   */
  it("generates every pattern under the new name", () => {
    const generated = initializeGeneratedModules();
    const patterns = new AttributeMethodPatternSet([reader, writer, changed]);

    generateAliasAttributeMethods(generated, "name", "title", patterns);

    expect(attributeMethod(generated, "name")?.attribute).toBe("title");
    expect(attributeMethod(generated, "name=")?.attribute).toBe("title");
    expect(attributeMethod(generated, "name_changed")?.attribute).toBe("title");
  });

  it("records what the alias points at", () => {
    const generated = initializeGeneratedModules();
    generateAliasAttributeMethods(generated, "name", "title", new AttributeMethodPatternSet());

    expect(attributeAlias(generated, "name")).toBe("title");
  });

  it("reports nothing for a name that is not an alias", () => {
    expect(attributeAlias(initializeGeneratedModules(), "nope")).toBeUndefined();
  });

  it("generates several at once", () => {
    const generated = initializeGeneratedModules();

    generateAliasAttributes(
      generated,
      { name: "title", content: "body" },
      new AttributeMethodPatternSet(),
    );

    expect(attributeAlias(generated, "name")).toBe("title");
    expect(attributeAlias(generated, "content")).toBe("body");
  });

  it("describes one definition", () => {
    expect(aliasAttributeMethodDefinition(changed, "name", "title")).toEqual({
      methodName: "name_changed",
      proxyTarget: "attribute_changed",
      attribute: "title",
    });
  });

  /** A bad alias should be a boot failure, not a failure on the one request that used it. */
  it("is generated eagerly by default", () => {
    expect(eagerlyGenerateAliasAttributeMethods()).toBe(true);

    setEagerlyGenerateAliasAttributeMethods(false);

    expect(eagerlyGenerateAliasAttributeMethods()).toBe(false);
  });
});

describe("writing to something that is not an attribute", () => {
  /**
   * Assigning to a misspelled attribute is the most common way a form ends up
   * saving nothing, and it is invisible unless something says so.
   */
  it("says so rather than ignoring it", () => {
    expect(() => attributeWriterMissing("titel", ["title", "body"])).toThrow("titel");
  });

  it("suggests the near miss", () => {
    expect(() => attributeWriterMissing("titel", ["title", "body"])).toThrow("Did you mean title");
  });

  it("lists what there is when nothing is close", () => {
    expect(() => attributeWriterMissing("zzz", ["title", "body"])).toThrow("body, title");
  });
});
