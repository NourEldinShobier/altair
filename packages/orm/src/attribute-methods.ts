/**
 * Generating a method per column, and refusing to generate one that would
 * shadow something. Ported from `ActiveModel::AttributeMethods`.
 *
 * A model gets `title` and `title=` for a `title` column, and — because
 * suffixes are declared once rather than per column — `title_changed?`,
 * `title_was`, `title_before_type_cast` and the rest, for every column, from
 * one declaration each.
 *
 * The part that earns its keep is what it refuses. A column named `save`,
 * `class`, `errors` or `destroy` would otherwise generate a reader that
 * replaces the method of that name, and the symptom is not an error: `save`
 * returns the column's value, the record never persists, and the request
 * succeeds. Rails raises rather than defining, and so does this — a migration
 * that adds such a column should fail at boot, not at 3am.
 *
 * The distinction that matters is between a method the *framework* defines,
 * which must never be shadowed, and one the *application* defined on the model
 * itself, which is a deliberate override and has to keep working. Getting that
 * backwards makes either every custom accessor an error, or every dangerous
 * column silently allowed.
 */

/** Where a method came from, which decides whether shadowing it is a mistake. */
export type MethodOrigin = "framework" | "application" | "none";

/**
 * A prefix, a suffix, or both, applied to every attribute.
 *
 * Declared once and expanded per column, which is why adding a column adds
 * eleven methods rather than one, and why adding a suffix adds one per column.
 */
export class AttributeMethodPattern {
  readonly prefix: string;
  readonly suffix: string;
  /** The method the generated one delegates to — `attribute`, `attribute=`, `attribute_was`. */
  readonly proxyTarget: string;

  readonly #unaffixed: boolean;

  constructor(prefix = "", suffix = "") {
    this.prefix = prefix;
    this.suffix = suffix;
    this.#unaffixed = prefix === "" && suffix === "";
    this.proxyTarget = `${prefix}attribute${suffix}`;
  }

  /** What the generated method is called for one attribute. */
  methodName(attribute: string): string {
    return `${this.prefix}${attribute}${this.suffix}`;
  }

  /**
   * Which attribute a method name refers to, or nothing. Rails'
   * `matched_attribute_name`.
   *
   * The length check is not an optimisation. Without it, the suffix `_was`
   * matches the method `_was` itself and yields an attribute named the empty
   * string — which then generates methods called `_was` and `=`.
   */
  matchedAttributeName(methodName: string): string | undefined {
    if (this.#unaffixed) return methodName;

    const affixLength = this.prefix.length + this.suffix.length;

    if (methodName.length <= affixLength) return undefined;
    if (!methodName.startsWith(this.prefix)) return undefined;
    if (!methodName.endsWith(this.suffix)) return undefined;

    return methodName.slice(this.prefix.length, methodName.length - this.suffix.length);
  }

  /** What a generated method delegates to. Rails' `method_for_attr`. */
  methodForAttr(attribute: string): { proxyTarget: string; attribute: string } {
    return { proxyTarget: this.proxyTarget, attribute };
  }

  /** Whether this pattern adds anything at all. */
  get isAffixed(): boolean {
    return !this.#unaffixed;
  }
}

/** The plain reader, which every model has. */
export const BASE_PATTERN = new AttributeMethodPattern();

/**
 * Every pattern a model has declared, and the lookup over them.
 *
 * A set rather than a list because the question asked on every missing method
 * is "does any pattern match this name", and asking each in turn on every
 * miss is the cost that made Rails add the prefix/suffix short-circuit.
 */
export class AttributeMethodPatternSet {
  readonly patterns: readonly AttributeMethodPattern[];

  readonly #affixed: AttributeMethodPattern[];
  readonly #prefixes: string[];
  readonly #suffixes: string[];

  constructor(patterns: readonly AttributeMethodPattern[] = [BASE_PATTERN]) {
    this.patterns = patterns;
    this.#affixed = patterns.filter((each) => each.isAffixed);
    this.#prefixes = Array.from(
      new Set(this.#affixed.map((each) => each.prefix).filter((each) => each !== "")),
    );
    this.#suffixes = Array.from(
      new Set(this.#affixed.map((each) => each.suffix).filter((each) => each !== "")),
    );
  }

  /** A new set with one more pattern. Patterns are never mutated in place. */
  with(pattern: AttributeMethodPattern): AttributeMethodPatternSet {
    return new AttributeMethodPatternSet([...this.patterns, pattern]);
  }

  /**
   * The patterns that could match a name, or nothing. Rails' `matching`.
   *
   * Checks the affixes before trying any pattern, because a name matching no
   * prefix and no suffix cannot match an affixed pattern — and this runs on
   * every method call that misses.
   */
  matching(methodName: string): AttributeMethodPattern[] | undefined {
    if (this.#affixed.length === 0) return undefined;

    const plausible =
      this.#suffixes.some((suffix) => methodName.endsWith(suffix)) ||
      this.#prefixes.some((prefix) => methodName.startsWith(prefix));

    return plausible ? this.#affixed : undefined;
  }

  /** The attribute a method name refers to, under whichever pattern matches. */
  matchedAttributeName(methodName: string, attributes: ReadonlySet<string>): string | undefined {
    for (const pattern of this.matching(methodName) ?? []) {
      const attribute = pattern.matchedAttributeName(methodName);

      if (attribute !== undefined && attributes.has(attribute)) return attribute;
    }

    return undefined;
  }
}

/** Raised when a column would replace a method that already means something. */
export class DangerousAttributeError extends Error {
  constructor(
    readonly methodName: string,
    readonly attribute: string,
  ) {
    super(
      `"${methodName}" is defined by the framework, so a "${attribute}" attribute cannot ` +
        `generate it — the generated method would replace the real one, and the symptom is ` +
        `not an error but a save that quietly does nothing. Rename the column, or use ` +
        `\`alias_attribute\` to reach it under another name.`,
    );
    this.name = "DangerousAttributeError";
  }
}

/**
 * Methods the framework defines and a column must never replace.
 *
 * Not an exhaustive list of everything on the prototype — that would refuse a
 * column called `name` or `id`, which are ordinary. These are the ones whose
 * replacement is silent: the record still works, and the thing it stops doing
 * is the thing nobody checks.
 */
export const FRAMEWORK_METHODS: ReadonlySet<string> = new Set([
  "save",
  "save!",
  "destroy",
  "delete",
  "update",
  "reload",
  "valid",
  "validate",
  "errors",
  "attributes",
  "toJSON",
  "isNewRecord",
  "isPersisted",
  "connection",
  "constructor",
  "hasOwnProperty",
  "toString",
  "valueOf",
]);

/** Rails' `dangerous_attribute_method?`. */
export function dangerousAttributeMethod(
  methodName: string,
  definedBy: MethodOrigin = originOf(methodName),
): boolean {
  return definedBy === "framework";
}

/**
 * Where a method name comes from.
 *
 * An application's own method on the model is a deliberate override and has to
 * keep working; only the framework's are dangerous to replace.
 */
export function originOf(
  methodName: string,
  applicationMethods: ReadonlySet<string> = new Set(),
): MethodOrigin {
  if (applicationMethods.has(methodName)) return "application";
  if (FRAMEWORK_METHODS.has(methodName)) return "framework";

  return "none";
}

/** Every name a set of attributes and patterns would generate that is dangerous. */
export function dangerousAttributeMethods(
  attributes: Iterable<string>,
  patterns: AttributeMethodPatternSet,
  applicationMethods: ReadonlySet<string> = new Set(),
): string[] {
  const dangerous: string[] = [];

  for (const attribute of attributes) {
    for (const pattern of patterns.patterns) {
      const name = pattern.methodName(attribute);

      if (dangerousAttributeMethod(name, originOf(name, applicationMethods))) dangerous.push(name);
    }
  }

  return dangerous;
}

/** Rails' `dangerous_class_method?`, for a generated class method rather than an instance one. */
export function dangerousClassMethod(methodName: string): boolean {
  return new Set(["find", "create", "all", "where", "table", "primaryKey", "new"]).has(methodName);
}

/** What a model has generated so far. */
export interface GeneratedMethods {
  /** Method name to the attribute and proxy target it stands for. */
  readonly methods: Map<string, { proxyTarget: string; attribute: string }>;
  readonly attributes: Set<string>;
  readonly aliases: Map<string, string>;
  generated: boolean;
}

/** Rails' `initialize_generated_modules`. */
export function initializeGeneratedModules(): GeneratedMethods {
  return { methods: new Map(), attributes: new Set(), aliases: new Map(), generated: false };
}

export function attributeMethodsGenerated(generated: GeneratedMethods): boolean {
  return generated.generated;
}

/**
 * Generates the methods for one attribute. Rails' `define_attribute_method`.
 *
 * `as` lets the generated names differ from the attribute they read, which is
 * what an alias needs: `title` and `name` both reaching the `title` column.
 */
export function defineAttributeMethod(
  generated: GeneratedMethods,
  attribute: string,
  patterns: AttributeMethodPatternSet,
  options: { as?: string; applicationMethods?: ReadonlySet<string>; override?: boolean } = {},
): void {
  const named = options.as ?? attribute;

  for (const pattern of patterns.patterns) {
    defineAttributeMethodPattern(generated, pattern, attribute, {
      as: named,
      ...(options.applicationMethods ? { applicationMethods: options.applicationMethods } : {}),
      ...(options.override === undefined ? {} : { override: options.override }),
    });
  }

  generated.attributes.add(attribute);
}

/** One pattern for one attribute. Rails' `define_attribute_method_pattern`. */
export function defineAttributeMethodPattern(
  generated: GeneratedMethods,
  pattern: AttributeMethodPattern,
  attribute: string,
  options: { as?: string; applicationMethods?: ReadonlySet<string>; override?: boolean } = {},
): void {
  const named = options.as ?? attribute;
  const methodName = pattern.methodName(named);
  const origin = originOf(methodName, options.applicationMethods);

  // An override is asked for explicitly — `alias_attribute` uses it — and even
  // then the framework's own methods are not up for replacement.
  if (dangerousAttributeMethod(methodName, origin)) {
    throw new DangerousAttributeError(methodName, attribute);
  }

  if (origin === "application" && options.override !== true) return;

  generated.methods.set(methodName, pattern.methodForAttr(attribute));
}

/** Rails' `define_attribute_methods`. */
export function defineAttributeMethods(
  generated: GeneratedMethods,
  attributes: Iterable<string>,
  patterns: AttributeMethodPatternSet,
  applicationMethods: ReadonlySet<string> = new Set(),
): GeneratedMethods {
  for (const attribute of attributes) {
    defineAttributeMethod(generated, attribute, patterns, { applicationMethods });
  }

  generated.generated = true;

  return generated;
}

/**
 * Forgets them. Rails' `undefine_attribute_methods`.
 *
 * After a migration in a running process: the columns changed, so the methods
 * generated from the old ones now read attributes that are not there.
 */
export function undefineAttributeMethods(generated: GeneratedMethods): void {
  generated.methods.clear();
  generated.attributes.clear();
  generated.generated = false;
}

/** Just the readers. Rails' `define_readers`. */
export function defineReaders(
  generated: GeneratedMethods,
  attributes: Iterable<string>,
  applicationMethods: ReadonlySet<string> = new Set(),
): void {
  for (const attribute of attributes) {
    defineAttributeMethodPattern(generated, BASE_PATTERN, attribute, { applicationMethods });
  }
}

/** Just the writers. Rails' `define_writers`. */
export function defineWriters(
  generated: GeneratedMethods,
  attributes: Iterable<string>,
  applicationMethods: ReadonlySet<string> = new Set(),
): void {
  const writer = new AttributeMethodPattern("", "=");

  for (const attribute of attributes) {
    defineAttributeMethodPattern(generated, writer, attribute, { applicationMethods });
  }
}

/** Both. Rails' `define_accessors`. */
export function defineAccessors(
  generated: GeneratedMethods,
  attributes: Iterable<string>,
  applicationMethods: ReadonlySet<string> = new Set(),
): void {
  defineReaders(generated, attributes, applicationMethods);
  defineWriters(generated, attributes, applicationMethods);
}

/**
 * A second name for an attribute. Rails' `alias_attribute`.
 *
 * Every pattern, not only the reader: an alias that gives you `name` but not
 * `name=` or `name_changed?` is worse than no alias, because the gap is found
 * one method at a time.
 */
export function generateAliasAttributeMethods(
  generated: GeneratedMethods,
  alias: string,
  attribute: string,
  patterns: AttributeMethodPatternSet,
  applicationMethods: ReadonlySet<string> = new Set(),
): void {
  defineAttributeMethod(generated, attribute, patterns, { as: alias, applicationMethods });
  generated.aliases.set(alias, attribute);
}

/** What an alias resolves to. Rails' `attribute_alias`. */
export function attributeAlias(generated: GeneratedMethods, alias: string): string | undefined {
  return generated.aliases.get(alias);
}

/** Rails' `alias_attribute_method_definition`. */
export function aliasAttributeMethodDefinition(
  pattern: AttributeMethodPattern,
  alias: string,
  attribute: string,
): { methodName: string; proxyTarget: string; attribute: string } {
  return {
    methodName: pattern.methodName(alias),
    ...pattern.methodForAttr(attribute),
  };
}

/** Every alias a model has declared. Rails' `generate_alias_attributes`. */
export function generateAliasAttributes(
  generated: GeneratedMethods,
  aliases: Readonly<Record<string, string>>,
  patterns: AttributeMethodPatternSet,
  applicationMethods: ReadonlySet<string> = new Set(),
): void {
  for (const [alias, attribute] of Object.entries(aliases)) {
    generateAliasAttributeMethods(generated, alias, attribute, patterns, applicationMethods);
  }
}

/**
 * Whether aliases are generated at boot or on first use. Rails'
 * `eagerly_generate_alias_attribute_methods`.
 *
 * Eagerly in production, so a bad alias is a boot failure rather than a
 * failure on the one request that used it.
 */
let eagerAliases = true;

export function eagerlyGenerateAliasAttributeMethods(): boolean {
  return eagerAliases;
}

export function setEagerlyGenerateAliasAttributeMethods(eager: boolean): void {
  eagerAliases = eager;
}

/**
 * What a missing method resolves to, if anything. Rails'
 * `attribute_method?` plus the `method_missing` path.
 */
export function attributeMethod(
  generated: GeneratedMethods,
  methodName: string,
): { proxyTarget: string; attribute: string } | undefined {
  return generated.methods.get(methodName);
}

/**
 * What happens when a writer is called for something that is not an attribute.
 * Rails' `attribute_writer_missing`.
 *
 * Named rather than silently ignored: assigning to a misspelled attribute is
 * the single most common way a form ends up saving nothing, and it is
 * invisible unless something says so.
 */
export function attributeWriterMissing(attribute: string, known: Iterable<string>): never {
  const names = Array.from(known).sort();
  const near = names.filter(
    (each) => each.startsWith(attribute.slice(0, 3)) || attribute.startsWith(each.slice(0, 3)),
  );

  throw new Error(
    `There is no "${attribute}" attribute to write to.` +
      (near.length > 0 ? ` Did you mean ${near.join(", ")}?` : ` Known: ${names.join(", ")}.`),
  );
}
