/**
 * The scope in force right now, and the counters kept on a parent row. Ported
 * from `ActiveRecord::Scoping`, `Scoping::Named`, `Scoping::Default` and
 * `CounterCache`.
 *
 * `model.ts` has `defaultScope` and `unscoped`. What is missing is the
 * *current* scope — the one a block installs so that everything inside it
 * inherits a narrowing without being handed it:
 *
 *     await Post.published().scoping(async () => {
 *       await Post.count()      // counts published posts
 *       await post.comments()   // built on a published post
 *     })
 *
 * The reason it is a stack held in async-local storage rather than a field is
 * concurrency. One process serves many requests at once, and a scope set by
 * one must not be visible to another — a tenant scope leaking across requests
 * is the whole tenancy model failing, silently, under load and not under test.
 *
 * The counter half is here because it has the same shape: a count kept on the
 * parent so that `post.comments_count` does not become `SELECT COUNT(*)` on
 * every render of every row. What makes it subtle is that the count and the
 * rows are two facts that can disagree, and every operation that changes one
 * has to change the other in the same transaction.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { RecordNotFound } from "./relation.js";
import type { Relation } from "./relation.js";

type AnyRelation = Relation<unknown>;

interface ScopeFrame {
  /** Keyed by model name, so two models can each hold a scope at once. */
  scopes: Map<string, AnyRelation>;
  /** Models whose default scope is suspended for the duration. */
  ignoring: Set<string>;
  /** A scope applied to every model, not just one. */
  allQueries?: AnyRelation;
}

const storage = new AsyncLocalStorage<ScopeFrame>();

/** A frame that exists outside any block, so reads never have to be conditional. */
const empty: ScopeFrame = { scopes: new Map(), ignoring: new Set() };

/** Rails' `ScopeRegistry`. */
export function scopeRegistry(): ScopeFrame {
  return storage.getStore() ?? empty;
}

/** The scope in force for a model, if any. Rails' `current_scope`. */
export function currentScopeFor(model: string): AnyRelation | undefined {
  return scopeRegistry().scopes.get(model);
}

/**
 * Runs something with a scope in force. Rails' `set_current_scope` /
 * `scoping`.
 *
 * Through async-local storage rather than a field, so a scope set while
 * serving one request is invisible to every other — which is the difference
 * between a tenancy model and a data leak that only appears under load.
 */
export function setCurrentScope<T>(
  model: string,
  scope: AnyRelation,
  body: () => Promise<T>,
): Promise<T> {
  const frame = scopeRegistry();
  const next: ScopeFrame = {
    scopes: new Map(frame.scopes),
    ignoring: new Set(frame.ignoring),
    ...(frame.allQueries ? { allQueries: frame.allQueries } : {}),
  };

  next.scopes.set(model, scope);

  return storage.run(next, body);
}

/**
 * A scope applied to every model. Rails' `all_queries` scoping.
 *
 * For something that is true of the whole request rather than of one model —
 * a read-only replica, a tenant. Kept separate from the per-model scopes
 * because it must survive a model installing its own.
 */
export function globalCurrentScope(): AnyRelation | undefined {
  return scopeRegistry().allQueries;
}

export function setGlobalCurrentScope<T>(scope: AnyRelation, body: () => Promise<T>): Promise<T> {
  const frame = scopeRegistry();

  return storage.run(
    { scopes: new Map(frame.scopes), ignoring: new Set(frame.ignoring), allQueries: scope },
    body,
  );
}

/** Rails' `all_queries_scope`. */
export function allQueriesScope(): AnyRelation | undefined {
  return globalCurrentScope();
}

/** Whether a model's default scope is suspended. Rails' `ignore_default_scope`. */
export function ignoreDefaultScope(model: string): boolean {
  return scopeRegistry().ignoring.has(model);
}

/**
 * Suspends a model's default scope for a block. Rails' `ignore_default_scope=`.
 *
 * Scoped to a block rather than set and unset, because the failure of the
 * flag version is that an exception leaves it on — and a default scope that
 * silently stops applying is how deleted records come back.
 */
export function setIgnoreDefaultScope<T>(model: string, body: () => Promise<T>): Promise<T> {
  const frame = scopeRegistry();
  const ignoring = new Set(frame.ignoring);
  ignoring.add(model);

  return storage.run(
    {
      scopes: new Map(frame.scopes),
      ignoring,
      ...(frame.allQueries ? { allQueries: frame.allQueries } : {}),
    },
    body,
  );
}

/** A scope that narrows nothing, for a caller that needs one anyway. Rails' `null_scope?`. */
export function nullScope(relation: AnyRelation): boolean {
  return relation === undefined;
}

/**
 * The attributes a scope implies for a record built inside it. Rails'
 * `scope_attributes`.
 *
 * `Post.where({ status: "draft" }).build()` should produce a draft. Only
 * equality conditions: a record cannot be built to satisfy `status != x` or
 * `views > 10`, and guessing a value that happens to satisfy one is worse than
 * leaving it unset.
 */
export function scopeAttributes(conditions: Record<string, unknown>): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};

  for (const [column, value] of Object.entries(conditions)) {
    if (value === null || typeof value !== "object") attributes[column] = value;
  }

  return attributes;
}

/** Applies them to a new record. Rails' `populate_with_current_scope_attributes`. */
export function populateWithCurrentScopeAttributes<T extends Record<string, unknown>>(
  record: T,
  conditions: Record<string, unknown>,
): T {
  for (const [column, value] of Object.entries(scopeAttributes(conditions))) {
    // Only where the caller said nothing. An explicit value beats the scope's,
    // which is what makes `Post.draft.build({ status: "published" })` mean
    // what it says.
    if (record[column] === undefined) (record as Record<string, unknown>)[column] = value;
  }

  return record;
}

/** Runs a function that narrows a relation. Rails' `eval_scope`. */
export function evalScope(
  relation: AnyRelation,
  scope: (relation: AnyRelation) => AnyRelation,
): AnyRelation {
  return scope(relation);
}

/** Applies a scope only when there is one. Rails' `apply_scope`. */
export function applyScope(
  relation: AnyRelation,
  scope: ((relation: AnyRelation) => AnyRelation) | undefined,
): AnyRelation {
  return scope === undefined ? relation : evalScope(relation, scope);
}

/** Builds one from several, in order. Rails' `build_scope`. */
export function buildScope(
  relation: AnyRelation,
  scopes: readonly ((relation: AnyRelation) => AnyRelation)[],
): AnyRelation {
  return scopes.reduce((carried, scope) => evalScope(carried, scope), relation);
}

/**
 * The scopes that apply when joining through an association. Rails'
 * `join_scopes`.
 *
 * The association's own scope and the target's default scope both apply to a
 * join, which is the thing most easily got wrong: a join that ignores the
 * target's default scope returns rows the same association would not return
 * when read directly.
 */
export function joinScopes(
  associationScope: ((relation: AnyRelation) => AnyRelation) | undefined,
  defaultScopes: readonly ((relation: AnyRelation) => AnyRelation)[],
): ((relation: AnyRelation) => AnyRelation)[] {
  return [...defaultScopes, ...(associationScope ? [associationScope] : [])];
}

/** The same for one association. Rails' `join_scope`. */
export function joinScope(
  relation: AnyRelation,
  associationScope: ((relation: AnyRelation) => AnyRelation) | undefined,
  defaultScopes: readonly ((relation: AnyRelation) => AnyRelation)[] = [],
): AnyRelation {
  return buildScope(relation, joinScopes(associationScope, defaultScopes));
}

/** The target model's contribution to a join. Rails' `klass_join_scope`. */
export function klassJoinScope(
  relation: AnyRelation,
  defaultScopes: readonly ((relation: AnyRelation) => AnyRelation)[],
  ignoring = false,
): AnyRelation {
  return ignoring ? relation : buildScope(relation, defaultScopes);
}

/**
 * Association scopes built once per association rather than per call. Rails'
 * `association_scope_cache`.
 */
const associationScopes = new Map<string, AnyRelation>();

export function associationScopeCache(): Map<string, AnyRelation> {
  return associationScopes;
}

export function clearAssociationScopeCache(): void {
  associationScopes.clear();
}

/**
 * Raised when a record that must exist does not. Rails'
 * `raise_record_not_found_exception!`.
 *
 * Names the model, the key and the value, because "not found" on its own sends
 * you looking through a stack for which lookup failed.
 */
export function raiseRecordNotFoundException(model: string, id: unknown, primaryKey = "id"): never {
  throw new RecordNotFound(`Could not find ${model} with ${primaryKey} ${String(id)}.`);
}

// --- counter caches -------------------------------------------------------

/**
 * Whether a counter column is kept for an association. Rails'
 * `has_cached_counter?`.
 */
export function hasCachedCounter(counterCache: true | string | undefined): boolean {
  return counterCache !== undefined;
}

/**
 * Whether it should be maintained right now. Rails' `has_active_cached_counter?`.
 *
 * Separate from whether one exists, because a bulk load turns maintenance off
 * — updating a parent row once per child inserted turns one INSERT into two
 * writes, and the count can be set once at the end instead.
 */
export function hasActiveCachedCounter(
  counterCache: true | string | undefined,
  maintaining = true,
): boolean {
  return hasCachedCounter(counterCache) && maintaining;
}

/**
 * Which side keeps the counter. Rails' `counter_must_be_updated_by_has_many?`.
 *
 * The `has_many` side does, not the `belongs_to` that declares it. Both doing
 * it means every child counted twice, and neither means the number is a lie
 * that only shows up on a page that displays it.
 */
export function counterMustBeUpdatedByHasMany(
  counterCache: true | string | undefined,
  savedByBelongsTo: boolean,
): boolean {
  return hasCachedCounter(counterCache) && !savedByBelongsTo;
}

/** The count a parent starts with. Rails' `initial_count_for`. */
export function initialCountFor(existing: unknown): number {
  const count = Number(existing);

  return Number.isFinite(count) && count >= 0 ? count : 0;
}

/** How much a counter moves, by column. */
export type CounterChange = Record<string, number>;

/** Rails' `increment_counters`. */
export function incrementCounters(columns: readonly string[], by = 1): CounterChange {
  return Object.fromEntries(columns.map((column) => [column, by]));
}

/** Rails' `decrement_counters`. */
export function decrementCounters(columns: readonly string[], by = 1): CounterChange {
  return Object.fromEntries(columns.map((column) => [column, -by]));
}

/**
 * The counters to move when a child's parent changed. Rails'
 * `decrement_counters_before_last_save`.
 *
 * A child moved from one parent to another has to decrement the old one as
 * well as increment the new. Doing only the increment is the bug that leaves
 * an empty post claiming it has comments, and it survives because nothing
 * reads the old parent again until much later.
 */
export function decrementCountersBeforeLastSave(
  column: string,
  previousParentId: unknown,
  currentParentId: unknown,
): { id: unknown; change: CounterChange } | undefined {
  if (previousParentId === undefined || previousParentId === null) return undefined;
  if (previousParentId === currentParentId) return undefined;

  return { id: previousParentId, change: decrementCounters([column]) };
}

/**
 * The callbacks a counter-cached association needs. Rails'
 * `add_counter_cache_callbacks`.
 *
 * After create and after destroy rather than before, so a child that fails to
 * save does not move a counter — the count would then be permanently one
 * ahead, with nothing to point at.
 */
export function addCounterCacheCallbacks(column: string): {
  afterCreate: CounterChange;
  afterDestroy: CounterChange;
} {
  return {
    afterCreate: incrementCounters([column]),
    afterDestroy: decrementCounters([column]),
  };
}
