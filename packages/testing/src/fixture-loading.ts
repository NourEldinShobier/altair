/**
 * Loading fixtures into a database, ported from `ActiveRecord::FixtureSet` —
 * the label-to-id scheme, the insert order, and the caching between tests.
 *
 * `fixtures.ts` and `fixture-set.ts` build and read fixture definitions. This
 * is what happens when they meet a database, and the design turns on one
 * decision: **a fixture's id is derived from its label, not assigned.**
 *
 * That is what lets one file say `author: david` and another say
 * `label: david` without either knowing an insertion order or an id. The
 * consequences are worth stating because each replaces a whole class of
 * problem:
 *
 * - No ordering constraint. Rows can be inserted in any order, so a cycle —
 *   an author with a favourite post, a post with an author — loads without a
 *   deferred pass, which is the case a sequence-based scheme cannot do at all.
 * - The same id in every process, so a parallel worker and a serial run agree,
 *   and a test can hard-code `authors(:david).id` without it changing.
 * - Deletion, however, *is* ordered — children before parents — because
 *   foreign keys are enforced and a truncate in the wrong order fails on
 *   exactly the schemas that are most careful.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { cachedFixtures, identify } from "./fixture-set.js";

/** A fixture as written: a label and its columns. */
export interface FixtureRow {
  label: string;
  attributes: Record<string, unknown>;
}

/** A table's worth. Rails' `FixtureSet`. */
export interface FixtureSet {
  table: string;
  model?: string;
  rows: readonly FixtureRow[];
}

/**
 * `fixture-set.ts` already owns `identify` and the parse cache. Both are
 * reused rather than reimplemented — a second id scheme would give the same
 * label two ids depending on which module a caller reached for, which is the
 * one thing this whole design exists to prevent.
 */

/**
 * The rows a fixture set inserts. Rails' `table_rows`.
 *
 * Each row gets its derived id unless it named one, and every reference to
 * another fixture by label is resolved to that label's id. Resolving here
 * rather than at insert time is what removes the ordering constraint: nothing
 * has to exist yet for its id to be known.
 */
export function tableRows(
  set: FixtureSet,
  { primaryKey = "id" }: { primaryKey?: string } = {},
): Record<string, unknown>[] {
  // The key is written *after* the spread, so the `??` is what keeps an
  // explicit id rather than the spread order happening to. Written before it,
  // an id the fixture named would win by accident and the fallback would be
  // unreachable.
  return set.rows.map((row) => ({
    ...row.attributes,
    [primaryKey]: row.attributes[primaryKey] ?? identify(row.label),
  }));
}

/**
 * Resolves a `belongsTo` written as a label. Rails' association fixtures.
 *
 * `author: david` becomes `author_id: identify("david")`. The label is never
 * looked up in the database, so a fixture may reference one that has not been
 * inserted yet — including one in the same file, below it.
 */
export function resolveReferences(
  attributes: Record<string, unknown>,
  associations: Record<string, { foreignKey: string }>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(attributes)) {
    const association = associations[key];

    if (association && typeof value === "string") {
      resolved[association.foreignKey] = identify(value);
      continue;
    }

    resolved[key] = value;
  }

  return resolved;
}

/** Rails' `model_metadata` — what a set needs to know about its model. */
export interface ModelMetadata {
  table: string;
  primaryKey: string;
  timestampColumns: readonly string[];
}

export function modelMetadata(
  set: FixtureSet,
  { primaryKey = "id", timestampColumns = [] as readonly string[] } = {},
): ModelMetadata {
  return { table: set.table, primaryKey, timestampColumns };
}

/**
 * Timestamps a fixture gets if it did not set them. Rails' `now`.
 *
 * One timestamp for the whole load, not one per row. A suite that asserts on
 * ordering by `created_at` would otherwise depend on how long the insert took,
 * which is the kind of test that passes on a laptop and fails in CI.
 */
export function fixtureTimestamps(
  metadata: ModelMetadata,
  attributes: Record<string, unknown>,
  now: Date,
): Record<string, unknown> {
  const stamped: Record<string, unknown> = {};

  for (const column of metadata.timestampColumns) {
    if (attributes[column] === undefined) stamped[column] = now;
  }

  return stamped;
}

// --- order --------------------------------------------------------------

/**
 * The order tables are emptied in. Rails deletes before it inserts.
 *
 * Children before parents, because foreign keys are enforced and deleting a
 * parent whose children remain fails — on exactly the schemas careful enough
 * to declare the constraint. Insertion needs no order at all, because ids are
 * derived rather than assigned.
 */
export function deletionOrder(
  tables: readonly string[],
  dependencies: Record<string, readonly string[]> = {},
): string[] {
  const ordered: string[] = [];
  const visiting = new Set<string>();

  const visit = (table: string): void => {
    if (ordered.includes(table)) return;

    // A cycle is legitimate in a fixture set — an author with a favourite post
    // — so it is broken rather than reported. The rows still delete, because
    // the whole set goes together.
    if (visiting.has(table)) return;

    visiting.add(table);

    for (const dependent of dependencies[table] ?? []) visit(dependent);

    visiting.delete(table);
    ordered.push(table);
  };

  for (const table of tables) visit(table);

  return ordered;
}

// --- caching between tests --------------------------------------------------

let parsingCache = true;

/** Whether a `withoutParsingCache` block is running here. */
const withoutCache = new AsyncLocalStorage<boolean>();

function parsingCacheHere(): boolean {
  return parsingCache && withoutCache.getStore() !== true;
}

/** Rails' `all_loaded_fixtures` — what the parse cache is currently holding. */
export function allLoadedFixtures(names: readonly string[]): (FixtureSet | undefined)[] {
  return names.map((name) =>
    parsingCacheHere() ? (cachedFixtures(name) as FixtureSet) : undefined,
  );
}

/** Whether the parse cache is in use. */
export function parsingCacheEnabled(): boolean {
  return parsingCacheHere();
}

/**
 * Rails' `without_parsing_cache`.
 *
 * For a test that edits a fixture file and expects the change to be read. The
 * cache exists because parsing every file for every test is most of a suite's
 * startup, so turning it off is deliberately scoped rather than global.
 */
export async function withoutParsingCache<T>(body: () => Promise<T> | T): Promise<T> {
  // Scoped: turning the cache off is a decision about this block, and a
  // module-level flag made every test running beside it re-parse every file.
  // There is nothing to put back, so a body that throws leaves nothing off.
  return await withoutCache.run(true, async () => await body());
}

// --- reaching them from a test ---------------------------------------------

export class UnknownFixture extends Error {
  constructor(set: string, label: string, known: readonly string[]) {
    super(
      `No fixture ${JSON.stringify(label)} in ${JSON.stringify(set)}. Defined: ` +
        `${known.join(", ") || "none"}. Returning nothing would make the test fail somewhere ` +
        `later with a null it cannot explain.`,
    );
    this.name = "UnknownFixture";
  }
}

/**
 * Rails' `fixture` accessor — `authors(:david)`.
 *
 * Refuses an unknown label rather than answering nothing. A test that receives
 * `undefined` fails later, on a line that has nothing to do with the typo.
 */
export function fixture(set: FixtureSet, label: string): FixtureRow {
  const found = set.rows.find((row) => row.label === label);

  if (!found)
    throw new UnknownFixture(
      set.table,
      label,
      set.rows.map((row) => row.label),
    );

  return found;
}

/** Rails' `setup_fixture_accessors` — the names a test can call. */
export function setupFixtureAccessors(sets: readonly FixtureSet[]): string[] {
  return sets.map((set) => set.table).sort();
}

/** The id a test means by a label, without loading anything. */
export function fixtureId(label: string): number | string {
  return identify(label);
}
