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
  /**
   * Reaches the target through another association.
   *
   * Rails' `has_many :comments, through: :posts` — the name of an association
   * on this model whose records own the target.
   */
  through?: string;
  /**
   * The association on the intermediate model to follow.
   *
   * Defaults to the target's own name, as Rails' `source:` does.
   */
  source?: string;
  /**
   * Marks a belongsTo as polymorphic: the target class is named by a
   * companion `<name>_type` column rather than fixed at declaration.
   */
  /**
   * Keeps a count of the children on the parent row.
   *
   * `true` uses Rails' name for the column, which is the child's table plus
   * `_count`. A string names it explicitly.
   */
  counterCache?: true | string;

  /**
   * What happens to the children when the owner is destroyed.
   *
   * Rails' `dependent:`. Without one, destroying a post leaves its comments
   * behind pointing at a row that is gone — rows nothing will ever read and
   * nothing will ever delete, and a foreign key constraint will refuse the
   * delete outright.
   */
  dependent?: "destroy" | "nullify" | "restrict";

  /**
   * The polymorphic association on the other side. Rails' `has_many :comments,
   * as: :commentable`.
   *
   * The children are keyed by a pair of columns rather than one: an id and the
   * owner's class name, which is what lets the same table point at several.
   */
  as?: string;

  /**
   * Moves the parent's `updated_at` whenever a child changes. Rails'
   * `belongs_to :post, touch: true`.
   *
   * What makes caching a parent by its `cacheKey` safe: without it a page
   * cached under `posts/1-…` keeps showing yesterday's comment count, because
   * adding a comment does not change the post's own timestamp. A string names
   * a second column to move alongside `updated_at`.
   */
  touch?: true | string;

  polymorphic?: boolean;
  /** Resolves a polymorphic type name to a model class. */
  types?: Record<string, () => ModelLike>;

  /**
   * Narrows the association. Rails' `has_many :comments, -> { approved }`.
   *
   *     this.hasMany("approvedComments", () => Comment, {
   *       scope: (comments) => comments.where({ approved: true }).order("created_at"),
   *     })
   *
   * Applied on both paths, which is the only thing about this worth being
   * careful over: if reading `post.comments()` narrowed and preloading did
   * not, `includes("comments")` would quietly return a different set of
   * records than the same call without it — the two disagreeing about what
   * the association means, with only performance appearing to change.
   */
  scope?: (relation: Relation<InstanceLike>) => Relation<InstanceLike>;

  /**
   * Saves loaded records of this association when the owner is saved.
   *
   * Rails' `autosave: true`. Only what is already in memory: an association
   * nobody read is not fetched in order to be saved, which would turn every
   * save into a query per association.
   */
  autosave?: boolean;

  /**
   * Lets a `belongsTo` have no parent. Rails' `optional: true`.
   *
   * A `belongsTo` is required by default, as Rails has had it since 5.0: a
   * comment with no post is almost always a row that was saved before its
   * parent existed, or after the parent was deleted, and it is found much
   * later by whatever tries to read `comment.post().title`.
   */
  optional?: boolean;
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
  resolve?: (owner: InstanceLike, name: string) => AssociationDefinition,
): Promise<void> {
  if (owners.length === 0) return;

  // A through association is two hops: load the intermediate records, then
  // load the target from those. Both are still one query each, which is the
  // whole point of preloading.
  if (definition.through) {
    if (!resolve) throw new Error("A through association needs the owner's association table");

    const middle = resolve(owners[0]!, definition.through);
    await preloadAssociation(owners, middle, resolve);

    const intermediates = owners.flatMap((owner) => {
      const loaded = owner[cacheKey(definition.through!)];
      if (Array.isArray(loaded)) return loaded as InstanceLike[];
      return loaded ? [loaded as InstanceLike] : [];
    });

    // Nothing in the middle means nothing at the end, and what "nothing" looks
    // like depends on the shape: an empty list, or no record.
    const empty = definition.kind === "hasOne" ? null : [];

    if (intermediates.length === 0) {
      for (const owner of owners) owner[cacheKey(definition.name)] = empty;
      return;
    }

    const sourceName = definition.source ?? definition.name;
    const sourceDefinition = resolve(intermediates[0]!, sourceName);
    await preloadAssociation(intermediates, sourceDefinition, resolve);

    for (const owner of owners) {
      const loaded = owner[cacheKey(definition.through)];
      const rows = Array.isArray(loaded)
        ? (loaded as InstanceLike[])
        : loaded
          ? [loaded as InstanceLike]
          : [];

      const reached = rows.flatMap((row) => {
        const value = row[cacheKey(sourceName)];
        if (Array.isArray(value)) return value as InstanceLike[];
        return value ? [value as InstanceLike] : [];
      });

      // The hops are the same either way; only what is kept at the end differs.
      owner[cacheKey(definition.name)] =
        definition.kind === "hasOne" ? (reached[0] ?? null) : reached;
    }
    return;
  }

  if (definition.polymorphic) {
    await preloadPolymorphic(owners, definition);
    return;
  }

  const target = definition.target();

  if (definition.kind === "belongsTo") {
    const foreignKey = definition.foreignKey ?? defaultForeignKey(target.name);
    const primaryKey = definition.primaryKey ?? target.primaryKey;

    const ids = [...new Set(owners.map((owner) => owner[foreignKey]).filter((id) => id != null))];
    if (ids.length === 0) {
      for (const owner of owners) owner[cacheKey(definition.name)] = null;
      return;
    }

    const found = await scoped(definition, target.where({ [primaryKey]: ids }));
    const byId = new Map(found.map((record) => [String(record[primaryKey]), record]));

    for (const owner of owners) {
      owner[cacheKey(definition.name)] = byId.get(String(owner[foreignKey])) ?? null;
    }
    return;
  }

  // hasMany and hasOne both key the target by a column pointing back at us.
  const ownerClass = (owners[0] as { constructor: ModelLike }).constructor;
  const primaryKey = definition.primaryKey ?? ownerClass.primaryKey;
  const foreignKey = definition.as
    ? `${definition.as}_id`
    : (definition.foreignKey ?? defaultForeignKey(ownerClass.name));

  const ids = [...new Set(owners.map((owner) => owner[primaryKey]).filter((id) => id != null))];
  if (ids.length === 0) return;

  const found = await scoped(
    definition,
    target.where(
      definition.as
        ? { [foreignKey]: ids, [`${definition.as}_type`]: ownerClass.name }
        : { [foreignKey]: ids },
    ),
  );

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

/**
 * Loads a polymorphic belongsTo.
 *
 * The owners point at several different tables, so they are grouped by their
 * type column and each group loaded from its own model — one query per type
 * rather than one per record.
 */
async function preloadPolymorphic(
  owners: InstanceLike[],
  definition: AssociationDefinition,
): Promise<void> {
  const foreignKey = definition.foreignKey ?? `${definition.name}_id`;
  const typeKey = `${definition.name}_type`;

  const byType = new Map<string, InstanceLike[]>();
  for (const owner of owners) {
    const type = owner[typeKey];
    if (typeof type !== "string" || owner[foreignKey] == null) {
      owner[cacheKey(definition.name)] = null;
      continue;
    }
    const bucket = byType.get(type);
    if (bucket) bucket.push(owner);
    else byType.set(type, [owner]);
  }

  for (const [type, group] of byType) {
    const resolver = definition.types?.[type];
    if (!resolver) {
      throw new Error(
        `Polymorphic association "${definition.name}" has no class registered for type "${type}".`,
      );
    }

    const target = resolver();
    const ids = [...new Set(group.map((owner) => owner[foreignKey]))];
    const found = await target.where({ [target.primaryKey]: ids });
    const byId = new Map(found.map((record) => [String(record[target.primaryKey]), record]));

    for (const owner of group) {
      owner[cacheKey(definition.name)] = byId.get(String(owner[foreignKey])) ?? null;
    }
  }
}

/** Where a preloaded association is stashed on the record. */
/**
 * Marks a property as the record's own bookkeeping rather than a column.
 *
 * The model proxy keys off this: anything it does not recognise becomes an
 * attribute, and without a way to tell these apart the preload cache was
 * stored among the columns and written to the database.
 */
export const PRELOAD_PREFIX = "__preloaded_";

export function cacheKey(name: string): string {
  return `${PRELOAD_PREFIX}${name}`;
}

/** Builds the relation a to-many association reads through. */
/**
 * Applies an association's scope, if it has one.
 *
 * A single function used by both the lazy and the preloading path, so the two
 * cannot drift apart.
 */
function scoped(
  definition: AssociationDefinition,
  relation: Relation<InstanceLike>,
): Relation<InstanceLike> {
  return definition.scope ? definition.scope(relation) : relation;
}

export function relationFor(
  owner: InstanceLike,
  definition: AssociationDefinition,
): Relation<InstanceLike> {
  if (definition.polymorphic) {
    const typeKey = `${definition.name}_type`;
    const type = owner[typeKey];
    const resolver = typeof type === "string" ? definition.types?.[type] : undefined;

    if (!resolver) {
      throw new Error(
        `Polymorphic association "${definition.name}" has no class registered for type "${String(type)}".`,
      );
    }

    const polymorphicTarget = resolver();
    const foreignKey = definition.foreignKey ?? `${definition.name}_id`;
    return scoped(
      definition,
      polymorphicTarget.where({ [polymorphicTarget.primaryKey]: owner[foreignKey] }),
    );
  }

  const target = definition.target();

  if (definition.kind === "belongsTo") {
    const foreignKey = definition.foreignKey ?? defaultForeignKey(target.name);
    const primaryKey = definition.primaryKey ?? target.primaryKey;
    return scoped(definition, target.where({ [primaryKey]: owner[foreignKey] }));
  }

  const ownerClass = (owner as { constructor: ModelLike }).constructor;
  const primaryKey = definition.primaryKey ?? ownerClass.primaryKey;

  if (definition.as) {
    // Both columns, always: matching only the id would hand back another
    // table's children whenever the ids happened to collide.
    return scoped(
      definition,
      target.where({
        [`${definition.as}_id`]: owner[primaryKey],
        [`${definition.as}_type`]: ownerClass.name,
      }),
    );
  }

  const foreignKey = definition.foreignKey ?? defaultForeignKey(ownerClass.name);
  return scoped(definition, target.where({ [foreignKey]: owner[primaryKey] }));
}
