/**
 * Enums, ported from `ActiveRecord::Enum`.
 *
 *     class Post extends Model<PostRow>("posts") {
 *       static { this.enum("status", { draft: 0, published: 1, archived: 2 }) }
 *     }
 *
 *     post.status           // "published", not 1
 *     post.status = "draft" // writes 0
 *     post.isPublished      // true / false
 *     await post.published() // sets it and saves
 *     await Post.published() // the rows that are
 *     await Post.where({ status: "draft" })   // works too
 *
 * The column holds an integer and the application says a word. That is the
 * whole feature: a `status` column full of 0s and 1s is unreadable in a
 * console, a log, a dashboard and a bug report, and every place that reads it
 * has to keep its own copy of what 1 meant. Storing the integer keeps the
 * index small; mapping on the way in and out means nothing else has to know.
 *
 * Conditions are mapped too, because `where({ status: "draft" })` failing
 * silently — matching nothing, since no row holds the string — is a worse
 * outcome than not supporting it at all.
 */

import { camelize } from "@altair/support";

export type EnumMapping = Record<string, number | string>;

export interface EnumOptions {
  /** Rails' `prefix:`. `status_` gives `isStatusDraft`. */
  prefix?: string;
  /** Rails' `suffix:`. */
  suffix?: string;
}

export interface EnumDefinition {
  attribute: string;
  mapping: EnumMapping;
  /** The reverse, for turning a stored value back into its label. */
  labels: Map<number | string, string>;
  options: EnumOptions;
}

/** Raised when a value is not one of the ones declared. */
export class UnknownEnumValue extends Error {
  constructor(attribute: string, value: unknown, mapping: EnumMapping) {
    super(
      `"${String(value)}" is not a valid ${attribute}. It has to be one of: ${Object.keys(mapping).join(", ")}.`,
    );
    this.name = "UnknownEnumValue";
  }
}

export function defineEnum(
  attribute: string,
  mapping: EnumMapping,
  options: EnumOptions = {},
): EnumDefinition {
  const labels = new Map<number | string, string>();

  for (const [label, stored] of Object.entries(mapping)) {
    if (labels.has(stored)) {
      throw new Error(
        `${attribute} maps both "${labels.get(stored) as string}" and "${label}" to ${String(stored)}.`,
      );
    }
    labels.set(stored, label);
  }

  return { attribute, mapping, labels, options };
}

/** The name a predicate or a mutator gets, honouring prefix and suffix. */
export function memberName(definition: EnumDefinition, label: string): string {
  const { prefix, suffix } = definition.options;
  return camelize([prefix, label, suffix].filter(Boolean).join("_"), false);
}

/**
 * Turns whatever was assigned into what the column stores.
 *
 * Accepts the label or the stored value, since a record read back from the
 * database arrives holding the number and assigning it again should not be an
 * error. Null passes through: a nullable enum column is ordinary.
 */
export function storedValueFor(definition: EnumDefinition, value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string" && value in definition.mapping) {
    return definition.mapping[value];
  }

  if (definition.labels.has(value as number | string)) return value;

  throw new UnknownEnumValue(definition.attribute, value, definition.mapping);
}

/** Turns what the column stores back into the word the application uses. */
export function labelFor(definition: EnumDefinition, stored: unknown): unknown {
  if (stored === null || stored === undefined) return stored;
  return definition.labels.get(stored as number | string) ?? stored;
}
