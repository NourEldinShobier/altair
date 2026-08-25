/**
 * Attribute normalization, ported from Rails 7.1's `normalizes`.
 *
 *     static {
 *       this.normalizes("email", (value) => value.trim().toLowerCase())
 *     }
 *
 *     User.create({ email: "  Ada@Example.COM " })   // stores ada@example.com
 *     User.where({ email: "ADA@EXAMPLE.COM " })      // finds it
 *
 * The second line is the half people forget when they write this by hand as a
 * `before_save`. Normalizing on the way in and not in the lookup gives a table
 * of tidy values that a signup form can still create a duplicate in, because
 * the uniqueness check went looking for the untidy version and found nothing.
 * Doing both in one declaration is the whole point of it being a declaration.
 *
 * `null` is left alone unless asked for. A column that is empty is not a value
 * that needs tidying, and calling `.trim()` on nothing is a crash rather than
 * a normalization.
 */

export type Normalizer = (value: never) => unknown;

export interface NormalizeOptions {
  /** Rails' `apply_to_nil`. Off by default, and rarely what anybody wants. */
  applyToNil?: boolean;
}

export interface NormalizeDefinition {
  attribute: string;
  normalize: Normalizer;
  options: NormalizeOptions;
}

export function defineNormalizer(
  attribute: string,
  normalize: Normalizer,
  options: NormalizeOptions = {},
): NormalizeDefinition {
  return { attribute, normalize, options };
}

/** Applies one normalizer, honouring the null rule. */
export function normalizeValue(definition: NormalizeDefinition, value: unknown): unknown {
  if ((value === null || value === undefined) && !definition.options.applyToNil) return value;

  return (definition.normalize as (input: unknown) => unknown)(value);
}

/**
 * Applies the normalizers a set of conditions touches.
 *
 * An array is an IN, so every member is normalized: `where({ email: [a, b] })`
 * has the same problem as a single value, one entry at a time.
 */
export function normalizeConditions(
  definitions: Record<string, NormalizeDefinition>,
  conditions: Record<string, unknown>,
): Record<string, unknown> {
  if (Object.keys(definitions).length === 0) return conditions;

  const prepared: Record<string, unknown> = {};

  for (const [column, value] of Object.entries(conditions)) {
    const definition = definitions[column];

    if (!definition) {
      prepared[column] = value;
      continue;
    }

    prepared[column] = Array.isArray(value)
      ? value.map((one) => normalizeValue(definition, one))
      : normalizeValue(definition, value);
  }

  return prepared;
}
