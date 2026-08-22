/**
 * Request parameters, ported from `ActionController::Parameters`.
 *
 * Strong parameters exist because Ruby cannot describe the shape of a payload,
 * so mass assignment needs a runtime allowlist. TypeScript can describe the
 * shape, so this keeps Rails' `require`/`permit` for parity and adds
 * {@link Parameters.validate}, which hands the payload to any validator
 * implementing the Standard Schema interface — Zod, Valibot and ArkType all do
 * — and returns typed data.
 */

/**
 * The Standard Schema v1 interface, inlined.
 *
 * Declaring the shape rather than depending on a validator keeps this package
 * dependency-free while working with every library that implements the spec.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
}

export type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: readonly StandardIssue[] };

export interface StandardIssue {
  readonly message: string;
  readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined;
}

/** Rails raises `ActionController::ParameterMissing` for a required key. */
export class ParameterMissing extends Error {
  constructor(
    readonly param: string,
    readonly available: string[] = [],
  ) {
    super(
      `param is missing or the value is empty: ${param}` +
        (available.length > 0 ? ` (available: ${available.join(", ")})` : ""),
    );
    this.name = "ParameterMissing";
  }
}

/** Raised by {@link Parameters.validate} when the payload fails its schema. */
export class ParameterValidationError extends Error {
  constructor(readonly issues: readonly StandardIssue[]) {
    super(`Parameters failed validation: ${issues.map((i) => i.message).join("; ")}`);
    this.name = "ParameterValidationError";
  }
}

/** Raised when mass assignment is attempted on parameters that were never permitted. */
export class UnpermittedParameters extends Error {
  constructor(readonly keys: string[]) {
    super(`Unpermitted parameters: ${keys.join(", ")}`);
    this.name = "UnpermittedParameters";
  }
}

/**
 * A nested permit filter.
 *
 * `permit("title", { tags: [], author: ["name"] })` mirrors Rails'
 * `permit(:title, tags: [], author: [:name])`.
 */
export type PermitFilter = string | Record<string, readonly string[]>;

type Raw = Record<string, unknown>;

function isObject(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Rails' `present?`: nil and empty values are missing, but `false` is a value.
 */
function isPresent(value: unknown): boolean {
  if (value === false) return true;
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) return Object.keys(value).length > 0;
  return true;
}

export class Parameters {
  readonly #raw: Raw;
  #permitted: boolean;

  constructor(raw: Raw = {}, permitted = false) {
    this.#raw = raw;
    this.#permitted = permitted;
  }

  /** Whether `permit` has marked these parameters safe for mass assignment. */
  get permitted(): boolean {
    return this.#permitted;
  }

  get keys(): string[] {
    return Object.keys(this.#raw);
  }

  has(key: string): boolean {
    return Object.hasOwn(this.#raw, key);
  }

  /** The raw value for a key, with no permit check. */
  get(key: string): unknown {
    return this.#raw[key];
  }

  /** A nested Parameters for a key, or undefined when it is not an object. */
  nested(key: string): Parameters | undefined {
    const value = this.#raw[key];
    return isObject(value) ? new Parameters(value, this.#permitted) : undefined;
  }

  /**
   * Rails' `require`: the value for a key, or a thrown ParameterMissing.
   *
   * An object value comes back as nested Parameters so `require("post")` can be
   * chained into `permit`.
   */
  require(key: string): Parameters | unknown {
    const value = this.#raw[key];
    if (!isPresent(value)) throw new ParameterMissing(key, this.keys);
    return isObject(value) ? new Parameters(value, this.#permitted) : value;
  }

  /**
   * Rails' `permit`: a new Parameters containing only the listed keys, marked
   * safe for mass assignment. Anything not listed is dropped.
   */
  permit(...filters: PermitFilter[]): Parameters {
    const out: Raw = {};

    for (const filter of filters) {
      if (typeof filter === "string") {
        const value = this.#raw[filter];
        // Rails permits scalars and arrays of scalars, but a bare key never
        // permits a nested hash — that needs the explicit nested form.
        if (value === undefined) continue;
        if (isObject(value)) continue;
        out[filter] = value;
        continue;
      }

      for (const [key, nestedKeys] of Object.entries(filter)) {
        const value = this.#raw[key];
        if (value === undefined) continue;

        if (Array.isArray(value)) {
          out[key] =
            nestedKeys.length === 0
              ? value.filter((item) => !isObject(item))
              : value
                  .filter(isObject)
                  .map((item) => new Parameters(item).permit(...nestedKeys).toObject());
          continue;
        }

        if (isObject(value)) {
          out[key] = new Parameters(value).permit(...nestedKeys).toObject();
        }
      }
    }

    return new Parameters(out, true);
  }

  /** The plain object. Throws unless the parameters were permitted. */
  toObject(): Raw {
    if (!this.#permitted) throw new UnpermittedParameters(this.keys);
    return { ...this.#raw };
  }

  /** The plain object with no permit check, for reading rather than assigning. */
  toUnsafeObject(): Raw {
    return { ...this.#raw };
  }

  /**
   * Validates against any Standard Schema validator and returns typed data.
   *
   *     const data = await params.require("post").validate(
   *       z.object({ title: z.string().min(1), body: z.string() }),
   *     )
   *     data.title // string
   *
   * This is what strong parameters were reaching for. A schema states the shape
   * once, and the result is both checked at run time and typed at compile time,
   * so `permit` no longer has to stand in for a type.
   */
  async validate<Output>(schema: StandardSchemaV1<unknown, Output>): Promise<Output> {
    const result = await schema["~standard"].validate(this.toUnsafeObject());
    if (result.issues) throw new ParameterValidationError(result.issues);
    this.#permitted = true;
    return result.value;
  }

  /** Merges in more values, as Rails' `merge` does. Used for route params. */
  merge(other: Raw): Parameters {
    return new Parameters({ ...this.#raw, ...other }, this.#permitted);
  }

  /** Builds Parameters from a URL query string, a body object and route params. */
  static from(...sources: (Raw | undefined)[]): Parameters {
    return new Parameters(Object.assign({}, ...sources.filter(Boolean)) as Raw);
  }
}
