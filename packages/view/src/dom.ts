/**
 * Stable DOM identifiers for records, and the cycling helper.
 *
 * `domId` is the convention the rest of Rails is built on — `dom_id(post)` is
 * `post_1`, and that is what a form's anchor, a Turbo Stream target and a
 * system test selector all independently agree on without being told. The
 * value is that nobody has to invent a scheme; the cost of inventing one per
 * template is that they stop matching.
 */

import { underscore } from "@altair/support";

/** Something with a table name and possibly a saved id. */
interface RecordLike {
  constructor: {
    tableName?: string;
    name?: string;
    /** Rails' `query_constraints_list` — the columns that name one row. */
    queryConstraintsList?: () => string[];
  };
  id?: unknown;
  [column: string]: unknown;
}

/**
 * The identifying part of a record's DOM id. Rails' `record_key_for_dom_id`.
 *
 * Every column of the key, not the `id` column. On a model that declares
 * `queryConstraints` — a tenanted table keyed `(account_id, id)` — the `id`
 * alone does not name a row, so two accounts' row 5 both became `shop_5`.
 * That is the collision `dom_id` exists to prevent, and on a page listing
 * across tenants it means a Turbo Stream update lands on the wrong row.
 *
 * Joined with `_`, as Rails joins it. `String([1, 5])` would give `1,5`, and a
 * comma in an id is legal HTML that reads as two selectors in CSS — so the
 * element would be unreachable by the very thing this exists to make
 * reachable.
 *
 * Undefined when any part is missing, which Rails spells `key.all?`. A half
 * known key names nothing, so the record is treated as new rather than given
 * an id that cannot be looked up.
 */
function recordKey(record: RecordLike): string | undefined {
  const columns = record.constructor?.queryConstraintsList?.();
  const parts = columns ? columns.map((column) => record[column]) : [record.id];

  if (parts.some((part) => part === null || part === undefined || part === "")) return undefined;

  return parts.map((part) => String(part)).join("_");
}

/**
 * The class part of a record's identifier. Rails' `dom_class`.
 *
 * Taken from the model's own name rather than its table, so a `BlogPost` is
 * `blog_post` and not `blog_posts` — singular, because it names one thing.
 */
export function domClass(record: object, prefix?: string): string {
  const name = (record as RecordLike).constructor?.name ?? "object";
  const singular = underscore(name);

  return prefix ? `${prefix}_${singular}` : singular;
}

/**
 * A record's DOM id. Rails' `dom_id`.
 *
 *     domId(post)          // "post_1"
 *     domId(post, "edit")  // "edit_post_1"
 *
 * An unsaved record has no id, and gets `new_post` rather than `post_` or
 * `post_undefined`. That matters more than it looks: a form for a new record
 * and a form for record 1 must not collide, and two unsaved records on one
 * page are genuinely indistinguishable — which is Rails' answer too.
 */
export function domId(record: object, prefix?: string): string {
  const key = recordKey(record as RecordLike);
  const base = domClass(record);

  if (key === undefined) return prefix ? `${prefix}_new_${base}` : `new_${base}`;

  return prefix ? `${prefix}_${base}_${key}` : `${base}_${key}`;
}

/**
 * A record's Turbo Stream target. Rails' `dom_target`.
 *
 * The same identifier, which is the point — a stream naming `post_1` reaches
 * the element `domId` wrote.
 */
export function domTarget(record: object, prefix?: string): string {
  return domId(record, prefix);
}

/**
 * Rotates through values on each call. Rails' `cycle`.
 *
 *     for (const row of rows) render(row, cycle("odd", "even"))
 *
 * Zebra striping without a counter in the template. Each distinct set of
 * values gets its own position, keyed by the values themselves, so two cycles
 * running in one template do not advance each other — which is the bug in
 * every hand-rolled version.
 */
const cycles = new Map<string, number>();

export function cycle(...values: string[]): string {
  if (values.length === 0) throw new Error("cycle() needs at least one value");

  const key = values.join("\0");
  const position = cycles.get(key) ?? 0;

  cycles.set(key, position + 1);

  return values[position % values.length] as string;
}

/** What the last `cycle` over these values returned, without advancing. */
export function currentCycle(...values: string[]): string | undefined {
  const position = cycles.get(values.join("\0"));

  return position === undefined || position === 0
    ? undefined
    : (values[(position - 1) % values.length] as string);
}

/**
 * Sends a cycle back to its first value. Rails' `reset_cycle`.
 *
 * For a table that starts a new section: without it the striping carries the
 * old parity across the break and the first row of the new section looks like
 * a continuation.
 */
export function resetCycle(...values: string[]): void {
  if (values.length === 0) cycles.clear();
  else cycles.delete(values.join("\0"));
}
