/**
 * The loaded side of an association, ported from
 * `ActiveRecord::Associations::Association` and `CollectionAssociation` — the
 * target, when it is stale, and the inverse instances that keep it consistent.
 *
 * `associations.ts` fetches records. This is what happens to them afterwards:
 * `post.comments` has to remember what it loaded, notice when that is no longer
 * the right answer, and point each comment back at the post it came from.
 *
 * The two rules worth stating, because both fail silently:
 *
 * **Staleness is decided by the key, not by time.** A target loaded for
 * `post_id = 7` is wrong the moment the owner's id changes — reassigning a
 * record to another parent and then reading its children without this returns
 * the *old* parent's children, with no query and no error.
 *
 * **The inverse is set on the way in, not looked up later.** Loading
 * `post.comments` and then reading `comment.post` should not be a second query
 * for a record already in memory — and worse than the query is what happens
 * without it: two objects for one row, where writing through one leaves the
 * other holding stale attributes that a later save can put back.
 */

/** The minimum a record has to expose for this to manage it. */
export interface TargetRecord {
  id?: unknown;
  [attribute: string]: unknown;
}

/** What an association was loaded for. Rails' `stale_state`. */
export type StaleState = string | undefined;

/**
 * The key a loaded target belongs to. Rails' `stale_state`.
 *
 * A string of the owner's foreign-key values, because that is what the query
 * was built from: if those change, the answer changes. Comparing whole records
 * would compare things the query never looked at, and reload on an edit to an
 * unrelated column.
 */
export function staleState(owner: TargetRecord, keys: readonly string[]): StaleState {
  const values = keys.map((key) => owner[key]);

  return values.some((value) => value === undefined) ? undefined : JSON.stringify(values);
}

/**
 * Whether a loaded target is still the right answer. Rails' `stale_target?`.
 *
 * Never stale before it has loaded — an association that has never run has
 * nothing to invalidate, and saying otherwise would make the first read look
 * like a reload.
 */
export function staleTarget(loaded: boolean, loadedFor: StaleState, now: StaleState): boolean {
  if (!loaded) return false;

  return loadedFor !== now;
}

/** One side of an association, once it has been read. */
export class AssociationTarget<T extends TargetRecord = TargetRecord> {
  #target: T[] = [];
  #loaded = false;
  #loadedFor: StaleState;
  /** Records added but not yet saved. Rails' unsaved target entries. */
  #added: T[] = [];

  constructor(
    readonly owner: TargetRecord,
    readonly foreignKeys: readonly string[] = ["id"],
  ) {}

  get loaded(): boolean {
    return this.#loaded;
  }

  /** Rails' `target`. */
  get target(): T[] {
    return [...this.#target, ...this.#added];
  }

  get size(): number {
    return this.#target.length + this.#added.length;
  }

  /** Rails' `stale_target?`. */
  stale(): boolean {
    return staleTarget(this.#loaded, this.#loadedFor, staleState(this.owner, this.foreignKeys));
  }

  /** Rails' `target=` / `loaded!`. */
  load(records: readonly T[]): T[] {
    this.#target = [...records];
    this.#loaded = true;
    this.#loadedFor = staleState(this.owner, this.foreignKeys);

    // Records added before the load are still pending — they are not in the
    // database yet, so a load cannot have returned them, and dropping them
    // here would silently discard a `post.comments.build` that happened first.
    return this.target;
  }

  /**
   * Rails' `add_to_target`.
   *
   * Appended to the unsaved set rather than the loaded one, so a later reload
   * replaces what the database returned without discarding what the caller
   * built.
   */
  addToTarget(record: T): T {
    this.#added.push(record);

    return record;
  }

  /** Rails' `target_previously_changed?` — anything added since the load. */
  targetChanged(): boolean {
    return this.#added.length > 0;
  }

  /** Records the caller built that the database has not seen. */
  get pending(): T[] {
    return [...this.#added];
  }

  /**
   * Rails' `reset`.
   *
   * Drops the loaded records *and* the flag. Keeping the flag with an empty
   * target is the bug this avoids: the association then reports itself loaded
   * with nothing in it, and every read afterwards answers "none" without ever
   * querying.
   */
  reset(): void {
    this.#target = [];
    this.#added = [];
    this.#loaded = false;
    this.#loadedFor = undefined;
  }

  /** Rails' `reset_scope` — forget the load, keep what was built. */
  resetScope(): void {
    this.#target = [];
    this.#loaded = false;
    this.#loadedFor = undefined;
  }

  /** Rails' `reload` — reset, then load again. */
  reload(records: readonly T[]): T[] {
    this.resetScope();

    return this.load(records);
  }

  /**
   * Whether a read has to hit the database. Rails' `find_target?`.
   *
   * Not loaded, or loaded for a key that has since changed.
   */
  needsLoad(): boolean {
    return !this.#loaded || this.stale();
  }
}

// --- inverses --------------------------------------------------------------

/**
 * Points a loaded record back at its owner. Rails' `set_inverse_instance`.
 *
 * Two objects for one row is the failure this prevents. Without it,
 * `post.comments.first.post` is a second query returning a *different* object
 * for the same row — and writing through one leaves the other holding stale
 * attributes that a later save can put back.
 */
export function setInverseInstance<T extends TargetRecord>(
  record: T,
  owner: TargetRecord,
  inverseName: string | undefined,
): T {
  if (inverseName === undefined) return record;

  (record as TargetRecord)[inverseName] = owner;

  return record;
}

/** Rails' `set_inverse_instance_from_queries` — the same, across a whole load. */
export function setInverseInstances<T extends TargetRecord>(
  records: readonly T[],
  owner: TargetRecord,
  inverseName: string | undefined,
): T[] {
  return records.map((record) => setInverseInstance(record, owner, inverseName));
}

/**
 * Rails' `remove_inverse_instance`.
 *
 * Cleared when a record leaves the association, or it goes on pointing at a
 * parent it no longer belongs to — which reads perfectly and is wrong.
 */
export function removeInverseInstance<T extends TargetRecord>(
  record: T,
  inverseName: string | undefined,
): T {
  if (inverseName !== undefined) (record as TargetRecord)[inverseName] = undefined;

  return record;
}

/** Rails' `inversed_from` — whether a record already has its inverse set. */
export function inversedFrom(record: TargetRecord, inverseName: string | undefined): unknown {
  return inverseName === undefined ? undefined : record[inverseName];
}

// --- what a belongs_to points at -------------------------------------------

/**
 * Rails' `null_scope?` / a target that is deliberately nothing.
 *
 * Distinct from "not loaded". A `belongsTo` whose foreign key is null has a
 * known answer — nothing — and querying for it would be a query guaranteed to
 * return no rows, run once per record in a list.
 */
export function nilTarget(owner: TargetRecord, foreignKey: string): boolean {
  return owner[foreignKey] === null || owner[foreignKey] === undefined;
}

/** Rails' `skip_preloading!` — this association is already answered. */
export function skipPreloading(owner: TargetRecord, foreignKey: string): boolean {
  return nilTarget(owner, foreignKey);
}

// --- through associations --------------------------------------------------

/**
 * The records a `through` association reaches. Rails' `source_records`.
 *
 * Flattened and de-duplicated by identity. Two taggings pointing at one tag
 * make `post.tags` return that tag twice, which is right for a count of
 * taggings and wrong for a list of tags — and the caller asked for tags.
 */
export function sourceRecords<T extends TargetRecord>(
  through: readonly TargetRecord[],
  sourceName: string,
): T[] {
  const found: T[] = [];
  const seen = new Set<unknown>();

  for (const record of through) {
    const value = record[sourceName];

    for (const each of Array.isArray(value) ? value : [value]) {
      if (each === null || each === undefined) continue;

      const key = (each as TargetRecord).id ?? each;

      if (seen.has(key)) continue;

      seen.add(key);
      found.push(each as T);
    }
  }

  return found;
}

/**
 * The join table two models share. Rails' `derive_join_table_name`.
 *
 * Both names, pluralised, in alphabetical order — the order is what makes the
 * name the same whichever model declares the association, and two models each
 * deriving a different name is two tables where one was meant.
 */
export function deriveJoinTableName(first: string, second: string): string {
  return [first, second].sort().join("_");
}

// --- counter caches --------------------------------------------------------

/**
 * Whether a counter should move. Rails' `inverse_updates_counter_cache?`.
 *
 * Only when the association actually changed sides. A save that touched
 * nothing else must not increment, or a counter drifts upward by one per save
 * and the number on the page is quietly wrong for the life of the record.
 */
export function inverseUpdatesCounterInMemory(
  previousOwnerId: unknown,
  currentOwnerId: unknown,
): { decrement: unknown; increment: unknown } | undefined {
  if (previousOwnerId === currentOwnerId) return undefined;

  return { decrement: previousOwnerId, increment: currentOwnerId };
}

/** Rails' `saved_change_to_target?`. */
export function savedChangeToTarget(previous: unknown, current: unknown): boolean {
  return previous !== current;
}

/** Rails' `target_previously_changed?`. */
export function targetPreviouslyChanged(previous: unknown, current: unknown): boolean {
  return savedChangeToTarget(previous, current);
}
