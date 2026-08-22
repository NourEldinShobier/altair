/**
 * Nested attributes, ported from `ActiveRecord::NestedAttributes`.
 *
 * A form that edits a post and its comments in one submit posts one hash. This
 * is what turns that hash into saved records:
 *
 *     Post.acceptsNestedAttributesFor("comments", { allowDestroy: true })
 *
 *     const post = Post.build({
 *       title: "Hello",
 *       comments_attributes: [{ body: "First" }, { id: 3, _destroy: true }],
 *     })
 *     await post.save()
 *
 * The whole thing is one transaction, so a form that half-saves is not a state
 * an application can reach.
 */

export const NESTED_SUFFIX = "_attributes";

/** The key Rails uses to mark a nested record for deletion. */
export const DESTROY_KEY = "_destroy";

export interface NestedAttributesOptions {
  /** Without this, a `_destroy` flag is ignored rather than obeyed. */
  allowDestroy?: boolean;
  /** Rejects a nested record before it is built. Rails' `reject_if`. */
  rejectIf?: (attributes: Record<string, unknown>) => boolean;
  /** Refuses more than this many nested records, rather than saving them. */
  limit?: number;
}

/** Raised when a submission carries more nested records than `limit` allows. */
export class NestedAttributesLimitExceeded extends Error {
  constructor(association: string, limit: number, given: number) {
    super(`Maximum ${limit} records are allowed for ${association}. Got ${given}.`);
    this.name = "NestedAttributesLimitExceeded";
  }
}

/**
 * Raised when nested attributes name a record that is not the owner's.
 *
 * This is a security boundary, not a convenience: without it, an id typed into
 * a form would let one person edit another's record through an association
 * they do not own.
 */
export class NestedRecordNotFound extends Error {
  constructor(association: string, id: unknown) {
    super(`Could not find a ${association} with id ${String(id)} for this record.`);
    this.name = "NestedRecordNotFound";
  }
}

/** The association a `*_attributes` key refers to, or null. */
export function associationForKey(
  key: string,
  declared: Record<string, NestedAttributesOptions>,
): string | null {
  if (!key.endsWith(NESTED_SUFFIX)) return null;
  const name = key.slice(0, -NESTED_SUFFIX.length);
  return name in declared ? name : null;
}

/**
 * Splits nested payloads out of a values hash.
 *
 * They have to come out: `comments_attributes` is not a column, and leaving it
 * in would put it in the INSERT.
 */
export function extractNested(
  values: Record<string, unknown>,
  declared: Record<string, NestedAttributesOptions>,
): { attributes: Record<string, unknown>; nested: Record<string, unknown> } {
  const attributes: Record<string, unknown> = {};
  const nested: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(values)) {
    const association = associationForKey(key, declared);
    if (association) nested[association] = value;
    else attributes[key] = value;
  }

  return { attributes, nested };
}

/**
 * Turns a nested payload into a list of records.
 *
 * A form encoder sends a collection as an object keyed by index rather than an
 * array, so both spellings arrive in practice and both mean the same thing.
 */
export function normalizeCollection(value: unknown): Record<string, unknown>[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value as Record<string, unknown>[];

  if (typeof value === "object") {
    return (
      Object.keys(value as Record<string, unknown>)
        // Numeric keys, in numeric order — "10" must not sort before "2".
        .sort((a, b) => Number(a) - Number(b))
        .map((key) => (value as Record<string, unknown>)[key] as Record<string, unknown>)
    );
  }

  return [];
}

/** Whether a nested record asked to be deleted. */
export function marksForDestruction(attributes: Record<string, unknown>): boolean {
  const flag = attributes[DESTROY_KEY];
  return flag === true || flag === 1 || flag === "1" || flag === "true";
}

/** The attributes to assign, with the framework's own keys removed. */
export function withoutControlKeys(
  attributes: Record<string, unknown>,
  primaryKey: string,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (key === DESTROY_KEY || key === primaryKey) continue;
    values[key] = value;
  }

  return values;
}

/** An id that names an existing record, as opposed to one that is absent. */
export function existingId(attributes: Record<string, unknown>, primaryKey: string): unknown {
  const id = attributes[primaryKey];
  if (id === undefined || id === null || id === "") return undefined;
  return id;
}
