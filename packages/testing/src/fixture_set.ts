/**
 * Naming, identifying and caching fixture sets, ported from
 * `ActiveRecord::FixtureSet`.
 *
 * [fixtures.ts](./fixtures.ts) loads records. This is the part around it: how
 * a fixture gets its id, which model a set belongs to, and why a set is loaded
 * once rather than per test.
 */

import { createHash } from "node:crypto";
import { UUID_NAMESPACES, uuidV5 } from "@altair/support";

/**
 * A stable id derived from a fixture's name. Rails' `identify`.
 *
 * This is what makes fixtures able to reference each other. Without it, a post
 * fixture naming its author has to know the author's id, which means assigning
 * ids by hand across every file and renumbering them whenever one is inserted.
 * With it, `author: ada` resolves because both files derive the same number
 * from the same name.
 *
 * The number is the low 30 bits of an MD5 of the label. Rails uses the same
 * construction, and the width is the point: a signed 32-bit integer column has
 * to hold it, so the top bit stays clear. Collisions are possible in principle
 * and vanishingly rare in a fixture set of any realistic size — a thousand
 * labels give roughly a one-in-two-thousand chance, and a collision shows up
 * immediately as a duplicate key rather than as wrong data.
 */
export function identify(label: string, keyType: "integer" | "uuid" = "integer"): number | string {
  if (keyType === "uuid") return uuidFor(label);

  const digest = createHash("md5").update(label).digest();

  return digest.readUInt32BE(0) % 0x3fff_ffff;
}

/**
 * The same, as a UUID, for a table whose key is one.
 *
 * Version 5 under the OID namespace, which is what Rails derives — and the
 * only thing that makes a fixture id portable. Derived any other way it is
 * still stable and still the right shape, so a suite passes and the ids simply
 * are not the ones Rails would have written, which is discovered when a
 * fixture file is shared with a Rails application or a dump is loaded into one.
 */
function uuidFor(label: string): string {
  return uuidV5(UUID_NAMESPACES.oid, label);
}

/** Where fixture files live. Rails' `fixture_paths`. */
let fixturesPathValue = "test/fixtures";

export function setFixturesPath(path: string): void {
  fixturesPathValue = path;
}

export function fixturesPath(): string {
  return fixturesPathValue;
}

/**
 * Fixture sets that are not loaded. Rails' `ignored_fixtures`.
 *
 * For a file that exists as a fragment other files reference through YAML
 * anchors, and would fail on its own. Naming them is better than the
 * alternative people reach for, which is a leading underscore in the filename
 * and a comment nobody reads.
 */
const ignored = new Set<string>();

export function ignoreFixtures(...names: string[]): void {
  for (const name of names) ignored.add(name);
}

export function ignoredFixtures(): string[] {
  return [...ignored];
}

export function isIgnoredFixture(name: string): boolean {
  return ignored.has(name);
}

/**
 * Which model a fixture set belongs to, when the name does not say. Rails'
 * `set_fixture_class`.
 *
 * The convention is that `admin_users.yml` is `AdminUser`, and it holds until
 * a table is named for something the model is not — a legacy table, a table
 * shared with another system, a single-table hierarchy whose file is named for
 * the base class.
 */
const fixtureClasses = new Map<string, unknown>();

export function setFixtureClass(mapping: Record<string, unknown>): void {
  for (const [name, model] of Object.entries(mapping)) fixtureClasses.set(name, model);
}

export function fixtureClassFor(name: string): unknown {
  return fixtureClasses.get(name);
}

/** The model name a fixture set implies. Rails' `default_fixture_model_name`. */
export function defaultFixtureModelName(setName: string): string {
  return setName
    .replace(/s$/, "")
    .split(/[_/]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/** The table a fixture set implies. Rails' `default_fixture_table_name`. */
export function defaultFixtureTableName(setName: string): string {
  return setName.replace(/\//g, "_");
}

/**
 * Fixture sets already loaded in this process. Rails' `cached_fixtures`.
 *
 * The reason for the cache is the cost: a suite of two hundred tests that each
 * reload every fixture spends most of its time inserting rows it already had.
 * Rails loads once and wraps each test in a transaction it rolls back, and the
 * cache is what makes the first half of that possible.
 */
const cache = new Map<string, unknown>();

export function cacheFixtures(name: string, fixtures: unknown): void {
  cache.set(name, fixtures);
}

export function cachedFixtures(name: string): unknown {
  return cache.get(name);
}

export function fixtureIsCached(name: string): boolean {
  return cache.has(name);
}

/**
 * Forgets the cache. Rails' `reset_cache`.
 *
 * Wanted between suites that use different fixture sets for the same names —
 * without it the second suite silently gets the first's rows, and the failures
 * point at the tests rather than at the loading.
 */
export function resetFixtureCache(): void {
  cache.clear();
}

/** Everything cached, for a report on what a suite loaded. */
export function cachedFixtureNames(): string[] {
  return [...cache.keys()];
}
