/**
 * Configuration objects, ported from `ActiveSupport::OrderedOptions`,
 * `InheritableOptions` and `ArrayInquirer`.
 *
 * The value of all three is the same: a typo in configuration should not read
 * as a valid absence. `config.cache_timeout` when the setting is called
 * `cacheTimeout` returns undefined either way on a plain object, so the
 * feature is quietly off and nothing says why. These make the difference
 * visible where it matters and keep it quiet where it does not.
 */

/**
 * A settings bag that can be asked for a required value.
 *
 *     const config = new OrderedOptions({ host: "example.com" })
 *     config.get("host")        // "example.com"
 *     config.fetch("port")      // throws, naming what was set
 *
 * Rails' OrderedOptions returns nil for anything unset and raises only for the
 * bang form. The same split is here, because both are wanted: a `get` for
 * optional settings, and a `fetch` for the ones a misconfigured application
 * should fail loudly on rather than start without.
 */
export class OrderedOptions {
  #values: Record<string, unknown>;

  constructor(values: Record<string, unknown> = {}) {
    this.#values = { ...values };
  }

  get(key: string): unknown {
    return this.#values[key];
  }

  set(key: string, value: unknown): this {
    this.#values[key] = value;
    return this;
  }

  has(key: string): boolean {
    return Object.hasOwn(this.#values, key);
  }

  delete(key: string): boolean {
    if (!this.has(key)) return false;

    delete this.#values[key];
    return true;
  }

  /**
   * The value, or a throw naming the key. Rails' `[]!`.
   *
   * The message lists what *is* set, because the answer to "why is this
   * undefined" is almost always a nearby name spelled differently.
   */
  fetch(key: string): unknown {
    if (!this.has(key)) {
      throw new Error(`No configuration named "${key}". Set: ${this.keys.join(", ") || "nothing"}`);
    }

    return this.#values[key];
  }

  get keys(): string[] {
    return Object.keys(this.#values);
  }

  toObject(): Record<string, unknown> {
    return { ...this.#values };
  }

  merge(other: Record<string, unknown>): OrderedOptions {
    return new OrderedOptions({ ...this.#values, ...other });
  }
}

/**
 * Options that fall back to a parent. Rails' `InheritableOptions`.
 *
 * What an environment's configuration is: development sets three things and
 * inherits the rest, so the shared defaults live in one place and each
 * environment is a short list of differences rather than a full copy that
 * drifts.
 */
export class InheritableOptions extends OrderedOptions {
  constructor(
    values: Record<string, unknown> = {},
    private readonly parent?: OrderedOptions,
  ) {
    super(values);
  }

  override get(key: string): unknown {
    return super.has(key) ? super.get(key) : this.parent?.get(key);
  }

  override has(key: string): boolean {
    return super.has(key) || (this.parent?.has(key) ?? false);
  }

  override fetch(key: string): unknown {
    if (!this.has(key)) {
      throw new Error(`No configuration named "${key}". Set: ${this.keys.join(", ") || "nothing"}`);
    }

    return this.get(key);
  }

  /** Its own keys and everything it inherits. */
  override get keys(): string[] {
    return [...new Set([...(this.parent?.keys ?? []), ...super.keys])];
  }

  /** Only what this level sets, which is what a diff of environments wants. */
  get ownKeys(): string[] {
    return super.keys;
  }
}

/**
 * An array that answers membership questions by name. Rails' `ArrayInquirer`.
 *
 *     const formats = new ArrayInquirer(["html", "json"])
 *     formats.is("json")     // true
 *     formats.any("xml", "json")
 *
 * The gain over `includes` is at the call site with several checks:
 * `formats.any("html", "xhtml")` says what it means, where a chain of `||`
 * comparisons is where somebody eventually writes `=== "htlm"`.
 */
export class ArrayInquirer<T extends string = string> {
  constructor(readonly values: readonly T[]) {}

  is(value: string): boolean {
    return this.values.includes(value as T);
  }

  any(...candidates: string[]): boolean {
    return candidates.some((one) => this.is(one));
  }

  all(...candidates: string[]): boolean {
    return candidates.every((one) => this.is(one));
  }

  get length(): number {
    return this.values.length;
  }

  toArray(): T[] {
    return [...this.values];
  }

  *[Symbol.iterator](): Iterator<T> {
    yield* this.values;
  }
}

/** Rails' `Array#inquiry`. */
export function arrayInquiry<T extends string>(values: readonly T[]): ArrayInquirer<T> {
  return new ArrayInquirer(values);
}
