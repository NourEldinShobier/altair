/**
 * Loading an association for many records at once, ported from
 * `ActiveRecord::Associations::Preloader` and its `Branch`, `Batch` and
 * `ThroughAssociation` pieces.
 *
 * This is the machinery behind `includes`, and it exists for one problem: a
 * loop that reads `post.author` for a hundred posts sends a hundred and one
 * queries. The fix is to collect the keys first and send one query — obvious
 * in the small, and everything here is a consequence of the cases where it is
 * not:
 *
 * - **Records are grouped by which class they load from, not by association
 *   name.** A polymorphic `commentable` on a hundred comments points at posts
 *   and photos; one query per class is two queries, and one query per record
 *   is a hundred. Grouping by name would produce neither.
 * - **A `through` association is loaded a hop at a time.** An author's
 *   comments go through posts, so the posts have to be loaded before their ids
 *   are known — and the first hop's records are usually needed anyway, which
 *   is why the intermediate result is kept rather than discarded.
 * - **What is already loaded is not loaded again.** A record whose association
 *   was assigned rather than read has a target the preloader must not
 *   overwrite: doing so silently discards an unsaved change.
 * - **The owners of each loaded record have to be found again afterwards.** A
 *   single query returns a flat list, and putting each row on the right record
 *   means indexing by key — which is where a type mismatch between a string
 *   id and an integer id turns into an association that is quietly empty.
 */

import type { Reflection } from "./reflection.js";

export interface Owner {
  [key: string]: unknown;
}

/**
 * Rails' `records_by_owner` — which loaded records belong to which owner.
 *
 * Keyed by the join value, coerced to a string. The coercion is the point: a
 * `belongs_to` whose foreign key came back from the driver as a string and
 * whose target's id came back as a number would match nothing, and an
 * association that is quietly empty is the failure this whole file exists to
 * avoid producing.
 */
export function recordsByOwner<O extends Owner, R extends Owner>(
  owners: readonly O[],
  records: readonly R[],
  ownerKey: string,
  recordKey: string,
): Map<O, R[]> {
  const byKey = new Map<string, R[]>();

  for (const record of records) {
    const key = joinKey(record[recordKey]);

    // Both sides check for a missing key, and at runtime either check alone
    // would do. They are kept separate so neither side relies on the other's
    // invariant — and because the alternative, a stand-in string for "no key",
    // is a value an application could legitimately hold, which would put one
    // record's rows on another.
    if (key === undefined) continue;

    const bucket = byKey.get(key);

    if (bucket === undefined) byKey.set(key, [record]);
    else bucket.push(record);
  }

  return new Map(
    owners.map((owner) => {
      const key = joinKey(owner[ownerKey]);

      return [owner, key === undefined ? [] : (byKey.get(key) ?? [])];
    }),
  );
}

/**
 * The string a join value is matched on.
 *
 * `null` and `undefined` produce nothing rather than a shared key: a hundred
 * comments with no `post_id` are not a hundred comments belonging to the same
 * post, and grouping them together is how one record's association ends up
 * holding another's rows.
 */
export function joinKey(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;

  return String(value);
}

/**
 * Rails' `grouped_records` — owners split by the class they load from.
 *
 * A polymorphic association points at more than one table, so the grouping is
 * by target class rather than by association name. One query per class is two
 * queries for a `commentable` over posts and photos; grouping by name would
 * have to fall back to one query per record.
 */
export function groupedRecordsByClass<O extends Owner>(
  owners: readonly O[],
  classOf: (owner: O) => unknown,
): Map<unknown, O[]> {
  const groups = new Map<unknown, O[]>();

  for (const owner of owners) {
    const target = classOf(owner);

    // An owner whose polymorphic type is null has nothing to load from. Left in
    // a group keyed `null` it would produce a query against no table.
    if (target === null || target === undefined) continue;

    const bucket = groups.get(target);

    if (bucket === undefined) groups.set(target, [owner]);
    else bucket.push(owner);
  }

  return groups;
}

/**
 * Rails' `target_classes` — every class this association can load from.
 *
 * More than one only for a polymorphic association, which is why the ordinary
 * case does not pay for the grouping.
 */
export function targetClasses<O extends Owner>(
  owners: readonly O[],
  classOf: (owner: O) => unknown,
): unknown[] {
  return [...groupedRecordsByClass(owners, classOf).keys()];
}

// --- what is already there ------------------------------------------------------

export interface LoadedAssociations {
  [name: string]: { loaded: boolean; target: unknown } | undefined;
}

/**
 * Rails' `already_loaded?` — the records that still need this association.
 *
 * A record whose association was *assigned* rather than read has a target the
 * preloader must not overwrite; doing so silently discards an unsaved change,
 * and the record then saves what the database already had.
 */
export function ownersNeedingLoad<O extends Owner & { associations?: LoadedAssociations }>(
  owners: readonly O[],
  name: string,
): O[] {
  return owners.filter((owner) => owner.associations?.[name]?.loaded !== true);
}

/**
 * Rails' `resolve_cached_associations` — reuse what is already in memory.
 *
 * Returns both halves, because the caller needs the loaded ones as much as the
 * unloaded: a `through` association's next hop starts from every record,
 * cached or not.
 */
export function resolveCachedAssociations<O extends Owner & { associations?: LoadedAssociations }>(
  owners: readonly O[],
  name: string,
): { cached: O[]; toLoad: O[] } {
  const cached: O[] = [];
  const toLoad: O[] = [];

  for (const owner of owners) {
    (owner.associations?.[name]?.loaded === true ? cached : toLoad).push(owner);
  }

  return { cached, toLoad };
}

/** Rails' `add_cached_associations` — the targets already in memory. */
export function addCachedAssociations<O extends Owner & { associations?: LoadedAssociations }>(
  owners: readonly O[],
  name: string,
): unknown[] {
  return owners.flatMap((owner) => {
    const target = owner.associations?.[name];

    if (target?.loaded !== true) return [];

    return Array.isArray(target.target) ? target.target : [target.target];
  });
}

/** Rails' `preloaded_records` — everything a preload produced, flat. */
export function preloadedRecords<R>(byOwner: ReadonlyMap<unknown, R[]>): R[] {
  const seen = new Set<R>();

  // Deduplicated: two owners pointing at one record is the normal case for a
  // `belongs_to`, and the next hop of a `through` would otherwise query for
  // the same id as many times as it was referenced.
  for (const records of byOwner.values()) {
    for (const record of records) seen.add(record);
  }

  return [...seen];
}

// --- through associations ---------------------------------------------------------

/**
 * Rails' `get_chain` — the hops a `through` association walks.
 *
 * Outermost first: an author's comments go through posts, so the chain is
 * `[through: posts, source: comments]` and the preloader walks it in that
 * order because the second hop's keys are not known until the first has run.
 */
export function getChain(reflection: Reflection): Reflection[] {
  if (!reflection.isThrough()) return [reflection];

  const chain: Reflection[] = [reflection.throughReflection()];
  let source = reflection.sourceReflection();

  // A source that is itself a `through` keeps walking. Bounded by the number of
  // reflections rather than by a `while (true)`: a `through` that names itself
  // is a declaration mistake, and hanging at boot is a worse way to report one
  // than raising is.
  for (let hop = 0; source.isThrough() && hop < MAX_THROUGH_DEPTH; hop += 1) {
    chain.push(source.throughReflection());
    source = source.sourceReflection();
  }

  if (source.isThrough()) {
    throw new Error(
      `The through chain for ${JSON.stringify(reflection.name)} is more than ` +
        `${MAX_THROUGH_DEPTH} hops deep, which means it loops back on itself. Walking it would ` +
        `hang at boot, which is a worse way to report a declaration mistake than this is.`,
    );
  }

  chain.push(source);

  return chain;
}

/** Deep enough for any real declaration; short enough to catch a cycle. */
export const MAX_THROUGH_DEPTH = 16;

/**
 * Rails' `collect_join_chain` — the same chain, as the join it describes.
 *
 * Separate from `getChain` because a preload walks the hops as separate
 * queries and a join walks them as one statement; the sequence is the same and
 * what is done with it is not.
 */
export function collectJoinChain(reflection: Reflection): { name: string; through: boolean }[] {
  return getChain(reflection).map((hop) => ({ name: hop.name, through: hop.isThrough() }));
}

/**
 * Rails' `preloaders_for_reflection` — one loader per hop, in order.
 *
 * A list rather than a single loader because each hop is a separate query, and
 * the second cannot be built until the first has returned its ids.
 */
export function preloadersForReflection(reflection: Reflection): {
  reflection: Reflection;
  hop: number;
}[] {
  return getChain(reflection).map((hop, index) => ({ reflection: hop, hop: index }));
}

/**
 * Rails' `find_from_target` — the records one hop produced, for the next.
 *
 * Flattened and deduplicated. A hundred posts by ten authors reach the second
 * hop as ten authors, not a hundred, and querying for the same author ten
 * times is the N+1 this exists to prevent reappearing one level down.
 */
export function findFromTarget<R>(targets: readonly (R | R[] | undefined)[]): R[] {
  const seen = new Set<R>();

  for (const target of targets) {
    if (target === undefined) continue;

    for (const record of Array.isArray(target) ? target : [target]) seen.add(record);
  }

  return [...seen];
}

/**
 * Rails' `extract_associated` — one association's value off each record.
 *
 * Used by `pluck`-style reads and by the next hop. Records with nothing there
 * are dropped rather than contributing `undefined`, which would otherwise
 * reach a query as a bind and match every row with a null key.
 */
export function extractAssociated<R>(records: readonly Owner[], name: string): R[] {
  return findFromTarget(records.map((record) => record[name] as R | R[] | undefined));
}

// --- putting the results back --------------------------------------------------

/**
 * Rails' `set_inverse_instance_from_queries`.
 *
 * Points each loaded record back at the owner it came from, so reading
 * `comment.post` after preloading posts' comments does not send a query for
 * the record that is already in hand. Without it, `includes(:comments)`
 * followed by a loop touching `comment.post` is the N+1 the include was
 * written to remove.
 */
export function setInverseInstanceFromQueries<O extends Owner>(
  byOwner: ReadonlyMap<O, Owner[]>,
  inverseName: string | undefined,
): number {
  if (inverseName === undefined) return 0;

  let set = 0;

  for (const [owner, records] of byOwner) {
    for (const record of records) {
      record[inverseName] = owner;
      set += 1;
    }
  }

  return set;
}

/**
 * Rails' `inversed_from_queries` — whether a record's owner was set this way.
 *
 * Tracked separately from an ordinary assignment because an inverse set by the
 * preloader is a fact about the query, not a change to the record: a record
 * marked dirty by it would be written back on the next save.
 */
export function inversedFromQueries(record: Owner, marker = "__inversed"): boolean {
  return record[marker] === true;
}

export function markInversedFromQueries(record: Owner, marker = "__inversed"): void {
  record[marker] = true;
}

/**
 * Rails' `inverse_which_updates_counter_cache`.
 *
 * The one association whose writes maintain a counter column. At most one:
 * two associations both incrementing the same counter would double-count every
 * create, and the count would be wrong in a way nothing recomputes.
 */
export function inverseWhichUpdatesCounterCache(
  reflections: readonly Reflection[],
  counterColumn: string,
  counterFor: (reflection: Reflection) => string | undefined,
): Reflection | undefined {
  const matching = reflections.filter((each) => counterFor(each) === counterColumn);

  if (matching.length > 1) {
    throw new Error(
      `More than one association maintains ${JSON.stringify(counterColumn)}: ` +
        `${matching.map((each) => each.name).join(", ")}. Each create would increment it once ` +
        `per association, and nothing recomputes a counter cache, so the wrong number stays ` +
        `wrong.`,
    );
  }

  return matching[0];
}

/**
 * Rails' `nullified_owner_attributes` — what a `nullify` dependent writes.
 *
 * The foreign key, and the type column too when the association is
 * polymorphic. Clearing only the id leaves a `*_type` naming a class the row
 * no longer points at, which reads as a record belonging to something that
 * does not exist rather than to nothing.
 */
export function nullifiedOwnerAttributes(
  foreignKey: string,
  foreignType?: string,
): Record<string, null> {
  return foreignType === undefined
    ? { [foreignKey]: null }
    : { [foreignKey]: null, [foreignType]: null };
}

/**
 * Rails' `source_attribute_from_preserved_attribute`.
 *
 * A destroyed record's association still has to be readable — `after_destroy`
 * callbacks and `dependent: :destroy` cascades both run after the row is gone
 * — so the key is read from what was preserved rather than from the record,
 * whose attributes may already have been cleared.
 */
export function sourceAttributeFromPreservedAttribute(
  record: Owner,
  attribute: string,
  preserved: Record<string, unknown> | undefined,
): unknown {
  if (preserved !== undefined && attribute in preserved) return preserved[attribute];

  return record[attribute];
}
