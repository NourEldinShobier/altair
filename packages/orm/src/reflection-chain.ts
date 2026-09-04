/**
 * The hops a `through` association traverses, ported from
 * `ActiveRecord::Reflection`'s `chain`, `collect_join_reflections` and the
 * `add_as_*` methods.
 *
 * `reflection.ts` resolves one association: which class it reaches, which
 * association on the intermediate carries the second hop. That is enough to
 * answer "what is at the end". It is not enough to build a query, because a
 * join needs every step in order — and the steps are not two.
 *
 *     Author.hasMany("posts", () => Post)
 *     Post.hasMany("comments", () => Comment)
 *     Author.hasMany("comments", { through: "posts" })
 *
 * That is a three-table join, and either half of a `through` can itself be a
 * `through`: an author's *commenters* go through comments, which go through
 * posts. The chain is the flattened list, and flattening it is the only way a
 * join, a preload and a `merge` agree about the same association — computed
 * separately in three places, they eventually do not, and the symptom is a
 * query that returns rows from the wrong table rather than an error.
 *
 * The order is outermost first, because that is the order a query builds its
 * joins in: each entry joins to the one before it, and reversed the first join
 * has nothing to attach to.
 */

import type { Reflection } from "./reflection.js";

/**
 * One hop, with what is known about how it was reached.
 *
 * `sourceType` is set when the hop is reached through a polymorphic
 * association, and it is not decoration: without it the join has no condition
 * on the type column, so an author's comments would include every commentable
 * row whose id happens to match a post's — a wrong answer with the right shape.
 */
export interface ChainEntry {
  reflection: Reflection;
  sourceType?: string;
}

const entry = (reflection: Reflection, sourceType?: string): ChainEntry =>
  sourceType === undefined ? { reflection } : { reflection, sourceType };

/**
 * Rails' `add_as_source` — this reflection's contribution as somebody's source.
 *
 * A plain association contributes *nothing*: it is already the last hop, and
 * the seed it was given ends at it. A `through` contributes its own chain,
 * because reaching its target means traversing it.
 */
export function addAsSource(reflection: Reflection, seed: readonly ChainEntry[]): ChainEntry[] {
  if (!reflection.isThrough()) return [...seed];

  return collectJoinReflections(reflection, seed);
}

/**
 * Rails' `add_as_through` — this reflection's contribution as an intermediate.
 *
 * Appended rather than prepended: the intermediate is further from the owner
 * than whatever is already in the seed, and the seed's first entry is the
 * association being resolved.
 */
export function addAsThrough(reflection: Reflection, seed: readonly ChainEntry[]): ChainEntry[] {
  if (!reflection.isThrough()) return [...seed, entry(reflection)];

  return collectJoinReflections(reflection, [...seed, entry(reflection)]);
}

/**
 * Rails' `add_as_polymorphic_through` — an intermediate reached by type.
 *
 * The same as `addAsThrough` except that the hop carries the source type, which
 * becomes a condition on the join. `has_many :comments, through: :posts,
 * source_type: "Post"` is meaningless without it: the join would match on id
 * alone, across every kind of commentable thing.
 */
export function addAsPolymorphicThrough(
  reflection: Reflection,
  sourceType: string,
  seed: readonly ChainEntry[],
): ChainEntry[] {
  const added = [...seed, entry(reflection, sourceType)];

  if (!reflection.isThrough()) return added;

  return collectJoinReflections(reflection, added);
}

/**
 * Rails' `collect_join_reflections` — the source first, then the intermediate.
 *
 * Source before through, because the source is the *closer* hop: the chain
 * reads from the association outwards to the table the owner actually holds a
 * key into, and a join built the other way round joins the owner to the far
 * table directly, which either fails or matches on the wrong column.
 */
export function collectJoinReflections(
  reflection: Reflection,
  seed: readonly ChainEntry[],
): ChainEntry[] {
  const withSource = addAsSource(reflection.sourceReflection(), seed);
  const through = reflection.throughReflection();
  const sourceType = reflection.sourceType();

  return sourceType === undefined
    ? addAsThrough(through, withSource)
    : addAsPolymorphicThrough(through, sourceType, withSource);
}

/**
 * Every hop, in join order. Rails' `chain`.
 *
 * A plain association is a chain of one. That is not a special case worth
 * removing: it is what lets a join builder take any association and not ask
 * whether it is a `through`.
 */
export function associationChain(reflection: Reflection): ChainEntry[] {
  if (!reflection.isThrough()) return [entry(reflection)];

  return collectJoinReflections(reflection, [entry(reflection)]);
}

/**
 * Rails' `deprecated_nested_reflections`.
 *
 * A deprecated association reached *through* another one is the case a
 * deprecation warning otherwise misses entirely: nothing names it, so nothing
 * warns, and it is removed on the strength of a search that found no callers —
 * taking the `through` association above it with it.
 *
 * Both halves are searched, and both can be `through` themselves, so this
 * recurses to whatever depth the declaration has.
 */
export function deprecatedNestedReflections(reflection: Reflection): Reflection[] {
  if (!reflection.isThrough()) return [];

  const found: Reflection[] = [];

  for (const hop of [reflection.throughReflection(), reflection.sourceReflection()]) {
    if (hop.isDeprecated()) found.push(hop);

    found.push(...deprecatedNestedReflections(hop));
  }

  return found;
}
