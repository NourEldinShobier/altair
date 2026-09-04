/**
 * How many queries a preload actually costs, ported from
 * `ActiveRecord::Associations::Preloader::Batch`, `LoaderQuery` and
 * `Relation#preload_associations`.
 *
 * `preloader.ts` turns "load this association for these records" into one
 * query instead of one per record. This is the layer above it, and it answers
 * the question that decides whether `includes` is worth writing:
 *
 *     Post.includes("author", "editor")
 *
 * Both load from `users`, on the same key. Loaded separately that is two
 * queries for one table, and the second one is very often for keys the first
 * already fetched. Rails groups loaders by the class *and* the key they load
 * on, unions their keys, and sends one query — which is why `includes` of five
 * associations is not five queries when three of them are users.
 *
 * The other half is knowing when *not* to preload. An `includes` that the
 * query planner turned into a join has already loaded the association; run as
 * a preload as well, it is loaded twice — the same rows fetched again, with
 * the second copy silently replacing the first.
 */

/** One association waiting to be loaded, reduced to what decides its query. */
export interface Loader {
  /** The class the rows come from. Two loaders only share a query if this matches. */
  klass: string;
  /** The column(s) matched against — an array for a composite key. */
  keyName: string | readonly string[];
  /** The values to look for. */
  keys: readonly unknown[];
}

/**
 * What makes two loaders shareable. Rails' `LoaderQuery#hash`.
 *
 * The class *and* the key name. Sharing on the class alone would union the
 * keys of a loader matching `id` with one matching `author_id` and hand both
 * the wrong rows — a preload that silently attaches somebody else's records.
 */
export function loaderQueryKey(loader: Loader): string {
  const key = Array.isArray(loader.keyName)
    ? [...loader.keyName].join(",")
    : String(loader.keyName);

  // Joined with a NUL, as `query-cache.ts` joins its own key parts: a
  // separator that cannot occur in a class or column name is the difference
  // between two loaders sharing a query and one loader answering for both.
  return `${loader.klass}\u0000${key}`;
}

/**
 * The conditions one query needs. Rails' `load_records_for_keys`.
 *
 * Nothing at all for no keys — not an empty condition. `WHERE id IN ()` is a
 * syntax error on most servers and matches everything on one, and either way
 * the query is a round trip for an answer that is known to be empty.
 *
 * A composite key becomes one set per column rather than a list of tuples,
 * because that is what every adapter can express. It is wider than the tuple
 * form — it matches combinations nobody asked for — which is why the caller
 * still has to match each row back to its owner, and why `recordsByOwner` in
 * `preloader.ts` is not an optimisation but a correctness step.
 */
export function loadRecordsForKeys(
  keyName: string | readonly string[],
  keys: readonly unknown[],
): Record<string, unknown[]> | undefined {
  if (keys.length === 0) return undefined;

  if (!Array.isArray(keyName)) return { [keyName as string]: [...keys] };

  const conditions: Record<string, unknown[]> = {};

  for (const [index, column] of keyName.entries()) {
    const values = new Set<unknown>();

    for (const composite of keys) {
      values.add(Array.isArray(composite) ? composite[index] : composite);
    }

    conditions[column] = [...values];
  }

  return conditions;
}

/** A group of loaders that one query can serve. */
export interface LoaderGroup {
  klass: string;
  keyName: string | readonly string[];
  loaders: Loader[];
  /** Every key any loader in the group is waiting for, without duplicates. */
  keys: unknown[];
}

/**
 * Rails' `Batch` — the loaders that can share a query, grouped.
 *
 * Keys are unioned and deduplicated across the group: two associations asking
 * for the same author ask for it once. Order is preserved so the queries a
 * preload sends are the order the associations were written in, which is what
 * makes a query log readable.
 */
export function groupLoaders(loaders: readonly Loader[]): LoaderGroup[] {
  const groups = new Map<string, LoaderGroup>();

  for (const loader of loaders) {
    const key = loaderQueryKey(loader);
    const existing = groups.get(key);

    if (existing) {
      existing.loaders.push(loader);
      existing.keys.push(...loader.keys);
      continue;
    }

    groups.set(key, {
      klass: loader.klass,
      keyName: loader.keyName,
      loaders: [loader],
      keys: [...loader.keys],
    });
  }

  return [...groups.values()].map((group) => ({ ...group, keys: [...new Set(group.keys)] }));
}

/**
 * Runs one query per group and gives each loader its own rows. Rails'
 * `load_records_in_batch`.
 *
 * Each loader is handed only the rows matching *its* keys, not the group's:
 * the query fetched a union, and handing the union to every loader would
 * attach another association's records to this one — which reads as a
 * correctly preloaded association containing rows that were never asked for.
 */
export async function loadRecordsInBatch<R>(
  loaders: readonly Loader[],
  run: (group: LoaderGroup, conditions: Record<string, unknown[]>) => Promise<R[]> | R[],
  keyOf: (record: R, group: LoaderGroup) => unknown,
): Promise<Map<Loader, R[]>> {
  const results = new Map<Loader, R[]>();

  for (const group of groupLoaders(loaders)) {
    const conditions = loadRecordsForKeys(group.keyName, group.keys);

    if (conditions === undefined) {
      for (const loader of group.loaders) results.set(loader, []);
      continue;
    }

    const rows = await run(group, conditions);

    for (const loader of group.loaders) {
      const wanted = new Set(loader.keys.map((key) => String(key)));

      results.set(
        loader,
        rows.filter((row) => wanted.has(String(keyOf(row, group)))),
      );
    }
  }

  return results;
}

/**
 * Which associations a relation preloads. Rails' `preload_associations`.
 *
 * `preload` always. `includes` only when the relation is *not* eager loading:
 * an `includes` the planner turned into a join has already loaded the
 * association, and preloading it as well fetches the same rows a second time
 * and replaces the first copy with them — which is invisible except in the
 * query log and in how long the page takes.
 *
 * Duplicates are dropped, because `includes("author").preload("author")` is
 * one association named twice, not two.
 */
export function preloadAssociations({
  preload = [],
  includes = [],
  eagerLoading = false,
}: {
  preload?: readonly string[];
  includes?: readonly string[];
  eagerLoading?: boolean;
} = {}): string[] {
  return [...new Set(eagerLoading ? preload : [...preload, ...includes])];
}
