/**
 * Associations, ported from `ActiveRecord::Associations`.
 *
 * Declared on the class, as in Rails:
 *
 *     class Post extends Model<PostAttributes>("posts") {
 *       static {
 *         this.belongsTo("author", () => User)
 *         this.hasMany("comments", () => Comment)
 *       }
 *     }
 *
 *     await post.author()                       // User | null
 *     await post.comments().where({ ok: 1 })    // a chainable relation
 *
 * Rails exposes these as properties, which works because Ruby has no promises.
 * Here a to-many association returns a relation so it stays composable, and a
 * to-one returns a promise. The parentheses are the cost of not hiding I/O
 * behind a property access.
 *
 * `includes()` preloads in one query per association, which is the entire
 * reason Rails' eager loading exists: without it a list view issues one query
 * per row.
 */

import { singularize, underscore } from "@altair/support";
import type { Relation } from "./relation.js";

export type AssociationKind = "belongsTo" | "hasMany" | "hasOne";

export interface AssociationOptions {
  /** Defaults to `<singular>_id` on the owning side, or the target's own key. */
  foreignKey?: string;
  /** Defaults to the target's primary key. */
  primaryKey?: string;
}

export interface AssociationDefinition extends AssociationOptions {
  name: string;
  kind: AssociationKind;
  target: () => ModelLike;
}

/** The slice of a model class the association machinery needs. */
export interface ModelLike {
  readonly table: string;
  primaryKey: string;
  name: string;
  all(): Relation<InstanceLike>;
  where(conditions: Record<string, unknown>): Relation<InstanceLike>;
  instantiate(row: Record<string, unknown>): InstanceLike;
}

export interface InstanceLike {
  [key: string]: unknown;
}

/** Rails' default foreign key: the singular, underscored model name plus `_id`. */
export function defaultForeignKey(modelName: string): string {
  return `${underscore(singularize(modelName))}_id`;
}

/**
 * Loads an association for many owners at once.
 *
 * One query per association rather than one per record — the difference
 * between a list page that scales and one that does not.
 */
export async function preloadAssociation(
  owners: InstanceLike[],
  definition: AssociationDefinition,
): Promise<void> {
  if (owners.length === 0) return;

  const target = definition.target();

  if (definition.kind === "belongsTo") {
    const foreignKey = definition.foreignKey ?? defaultForeignKey(target.name);
    const primaryKey = definition.primaryKey ?? target.primaryKey;

    const ids = [...new Set(owners.map((owner) => owner[foreignKey]).filter((id) => id != null))];
    if (ids.length === 0) {
      for (const owner of owners) owner[cacheKey(definition.name)] = null;
      return;
    }

    const found = await target.where({ [primaryKey]: ids });
    const byId = new Map(found.map((record) => [String(record[primaryKey]), record]));

    for (const owner of owners) {
      owner[cacheKey(definition.name)] = byId.get(String(owner[foreignKey])) ?? null;
    }
    return;
  }

  // hasMany and hasOne both key the target by a column pointing back at us.
  const ownerClass = (owners[0] as { constructor: ModelLike }).constructor;
  const foreignKey = definition.foreignKey ?? defaultForeignKey(ownerClass.name);
  const primaryKey = definition.primaryKey ?? ownerClass.primaryKey;

  const ids = [...new Set(owners.map((owner) => owner[primaryKey]).filter((id) => id != null))];
  if (ids.length === 0) return;

  const found = await target.where({ [foreignKey]: ids });

  const grouped = new Map<string, InstanceLike[]>();
  for (const record of found) {
    const key = String(record[foreignKey]);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(record);
    else grouped.set(key, [record]);
  }

  for (const owner of owners) {
    const matches = grouped.get(String(owner[primaryKey])) ?? [];
    owner[cacheKey(definition.name)] =
      definition.kind === "hasOne" ? (matches[0] ?? null) : matches;
  }
}

/** Where a preloaded association is stashed on the record. */
export function cacheKey(name: string): string {
  return `__preloaded_${name}`;
}

/** Builds the relation a to-many association reads through. */
export function relationFor(
  owner: InstanceLike,
  definition: AssociationDefinition,
): Relation<InstanceLike> {
  const target = definition.target();

  if (definition.kind === "belongsTo") {
    const foreignKey = definition.foreignKey ?? defaultForeignKey(target.name);
    const primaryKey = definition.primaryKey ?? target.primaryKey;
    return target.where({ [primaryKey]: owner[foreignKey] });
  }

  const ownerClass = (owner as { constructor: ModelLike }).constructor;
  const foreignKey = definition.foreignKey ?? defaultForeignKey(ownerClass.name);
  const primaryKey = definition.primaryKey ?? ownerClass.primaryKey;

  return target.where({ [foreignKey]: owner[primaryKey] });
}
