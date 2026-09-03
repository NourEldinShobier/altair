/**
 * Which class a row belongs to, and what happens to children when a parent
 * goes. Ported from `ActiveRecord::Inheritance` and the `dependent:` half of
 * `Associations::Builder`.
 *
 * Two features that share one property: both turn a value in a row into a
 * decision about code, and both are places where trusting the row is the bug.
 *
 * **Single-table inheritance** stores a class name in a column and
 * instantiates it on load. The column's contents came from the database, and a
 * database is a thing that gets restored from a backup, edited by a migration,
 * or written to by another service. Resolving an arbitrary string to a class
 * is how a `type` column becomes a way to instantiate anything the process has
 * loaded — so the classes have to be declared, not looked up.
 *
 * **Dependent destruction** decides whether removing a parent removes its
 * children. Getting it wrong is not a crash: `nullify` where `destroy` was
 * meant leaves orphans nobody queries, and `destroy` where `nullify` was meant
 * deletes records somebody needed. Both are discovered months later, and only
 * one is recoverable.
 */

/** Classes an inheritance column is allowed to name. */
const registered = new Map<string, unknown>();

export function registerStiClass(name: string, klass: unknown): void {
  registered.set(name, klass);
}

export function stiClassNames(): string[] {
  return Array.from(registered.keys()).sort();
}

export function clearStiClasses(): void {
  registered.clear();
}

export class UnknownStiClass extends Error {
  constructor(name: string, known: readonly string[]) {
    super(
      `The inheritance column holds "${name}", which is not a class this model can be. ` +
        `Declared: ${known.join(", ") || "none"}. A value in a column must never resolve to ` +
        `whatever class happens to share its name.`,
    );
    this.name = "UnknownStiClass";
  }
}

/**
 * The class a stored type name means. Rails' `sti_class_for`.
 *
 * Only a declared one. The alternative — looking the name up among everything
 * loaded — turns a writable column into a way to instantiate arbitrary code,
 * and the column is writable by every migration and every other service that
 * touches the table.
 */
export function stiClassFor(name: string): unknown {
  const found = registered.get(name);

  if (found === undefined) throw new UnknownStiClass(name, stiClassNames());

  return found;
}

/** What goes in the column for a class. Rails' `sti_name`. */
export function stiName(klass: { name: string }): string {
  return klass.name;
}

/** Rails' `compute_type` — the same lookup, tolerating an absent value. */
export function computeType(name: string | null | undefined, fallback: unknown): unknown {
  if (name === null || name === undefined || name === "") return fallback;

  return stiClassFor(name);
}

/**
 * A model with no table of its own. Rails' `abstract_class?`.
 *
 * `ApplicationRecord` is the example: it exists to hold shared behaviour and
 * querying it is always a mistake, so it is worth being able to say so rather
 * than letting the query fail on a missing table.
 */
export function abstractClass(klass: { abstract?: boolean }): boolean {
  return klass.abstract === true;
}

/**
 * The abstract class nearest the top. Rails' `primary_abstract_class`.
 *
 * Which is where a connection is established and where shared configuration
 * lives, so something has to be able to find it from any descendant.
 */
let primaryAbstract: unknown;

export function primaryAbstractClass(): unknown {
  return primaryAbstract;
}

export function setPrimaryAbstractClass(klass: unknown): void {
  primaryAbstract = klass;
}

/** Rails' `application_record_class?`. */
export function applicationRecordClass(klass: unknown): boolean {
  return klass === primaryAbstract;
}

export function resetInheritance(): void {
  registered.clear();
  primaryAbstract = undefined;
}

/**
 * Whether a class sits below the abstract root but above nothing. Rails'
 * `descends_from_active_record?`.
 *
 * True for a model with its own table and no STI parent. What it decides is
 * whether a query needs a type condition: a base class queries the whole
 * table, a subclass queries only its own rows.
 */
export function descendsFromActiveRecord(klass: {
  abstract?: boolean;
  superclassIsAbstract?: boolean;
}): boolean {
  return klass.abstract !== true && klass.superclassIsAbstract === true;
}

/**
 * Whether a finder has to narrow by type. Rails'
 * `finder_needs_type_condition?`.
 *
 * A subclass that queried without one would return every row in the table as
 * instances of itself — so `Admin.count` would count every user, and each one
 * would answer to admin methods.
 */
export function finderNeedsTypeCondition(klass: {
  abstract?: boolean;
  superclassIsAbstract?: boolean;
  hasInheritanceColumn?: boolean;
}): boolean {
  if (klass.hasInheritanceColumn !== true) return false;

  return !descendsFromActiveRecord(klass);
}

/** The column, unless the model says it has none. Rails' `real_inheritance_column`. */
export function realInheritanceColumn(klass: { inheritanceColumn?: string | null }): string | null {
  return klass.inheritanceColumn === null ? null : (klass.inheritanceColumn ?? "type");
}

/** A subclass made at runtime, for a type name with no class of its own. */
export function createSubclass(
  base: new (...args: never[]) => object,
  name: string,
): new (...args: never[]) => object {
  const subclass = class extends base {};

  Object.defineProperty(subclass, "name", { value: name });
  registerStiClass(name, subclass);

  return subclass;
}

// --- dependent destruction ------------------------------------------------

/** What happens to children when their parent is destroyed. */
export type DependentOption =
  | "destroy"
  | "destroy_async"
  | "delete"
  | "delete_all"
  | "nullify"
  | "restrict";

export const DEPENDENT_OPTIONS: readonly DependentOption[] = [
  "destroy",
  "destroy_async",
  // `delete` and `delete_all` are the same action on a different number of
  // rows, and both exist because the macro they belong to is different: a
  // `hasOne` has one child, so `delete_all` on it names a collection that is
  // not there.
  "delete",
  "delete_all",
  "nullify",
  "restrict",
];

/**
 * What each macro can do to its children. Rails' `valid_dependent_options`.
 *
 * Three lists rather than one and a rule, because the reason each option is
 * excluded is different: `delete_all` is a collection operation and `hasOne`
 * has no collection; `nullify` clears a column on the child, which a
 * `belongsTo` does not own; `delete` names one row, which a `hasMany` has many
 * of.
 */
export function validDependentOptions(
  macro: "belongsTo" | "hasOne" | "hasMany",
): readonly DependentOption[] {
  // Narrower than `DEPENDENT_OPTIONS`, and the gap is the point. That set is
  // what Rails has; this is what the destroy path here can actually do, which
  // is the only list worth validating against. Accepting an option nothing
  // acts on is the failure this function exists to prevent, and it used to
  // commit it: `delete_all` passed the check and then nullified.
  //
  // `destroy_async` needs a job to enqueue and the ORM has no job to reach
  // for, so it is refused where it is written rather than accepted and
  // quietly turned into something else. `belongsTo` takes nothing because
  // `handleDependents` skips it outright — destroying a parent from a child
  // is a feature this does not have yet, and saying so at the declaration is
  // better than saying nothing at the destroy.
  switch (macro) {
    case "belongsTo":
      return [];
    case "hasOne":
      return ["destroy", "delete", "nullify", "restrict"];
    case "hasMany":
      return ["destroy", "delete_all", "nullify", "restrict"];
  }
}

export class InvalidDependentOption extends Error {
  constructor(given: string, kind: string, allowed: readonly string[] = DEPENDENT_OPTIONS) {
    super(
      `"${given}" is not something a ${kind} association can do to its children. ` +
        // What *this* macro allows, not every option there is: half of them are
        // refused here precisely because they belong to another macro, and
        // listing those sends the reader to try one that will be refused too.
        `One of: ${allowed.join(", ")}.`,
    );
    this.name = "InvalidDependentOption";
  }
}

/**
 * Checks what a declaration asked for. Rails' `check_dependent_options`.
 *
 * Rails accepts an option a macro cannot honour and does nothing with it, which
 * reads as configured and is not — so this refuses it, against the list for
 * that macro rather than a list of everything.
 */
export function checkDependentOptions(
  option: string,
  kind: "hasMany" | "hasOne" | "belongsTo",
): DependentOption {
  const allowed = validDependentOptions(kind);

  if (!allowed.includes(option as DependentOption)) {
    throw new InvalidDependentOption(option, kind, allowed);
  }

  return option as DependentOption;
}

/** What destroying a parent should do about one association. */
export interface DependencyAction {
  action: "destroy" | "delete" | "nullify" | "refuse" | "enqueue";
  /** The column to clear, for a nullify. */
  foreignKey?: string;
}

/**
 * Rails' `handle_dependency`.
 *
 * `delete_all` skips the children's own callbacks, which is the point of it
 * and also its hazard: a child that owns an uploaded file, or children of its
 * own, leaves both behind. So the two are separate actions here rather than a
 * speed setting on one.
 */
export function handleDependency(option: DependentOption, foreignKey: string): DependencyAction {
  switch (option) {
    case "destroy":
      return { action: "destroy" };
    case "destroy_async":
      return { action: "enqueue" };
    case "delete":
    case "delete_all":
      return { action: "delete" };
    case "nullify":
      return { action: "nullify", foreignKey };
    case "restrict":
      return { action: "refuse" };
  }
}

/**
 * The associations a destroy has to deal with, in the order it must. Rails'
 * `destroy_associations`.
 *
 * Restrictions first. Checking them after some children have already been
 * destroyed means a refused destroy has already deleted things — and the
 * caller sees an exception and assumes nothing happened.
 */
export function destroyAssociations(
  associations: readonly { name: string; dependent?: DependentOption; foreignKey: string }[],
): { name: string; action: DependencyAction }[] {
  const declared = associations.filter((each) => each.dependent !== undefined);

  const ordered = [
    ...declared.filter((each) => each.dependent === "restrict"),
    ...declared.filter((each) => each.dependent !== "restrict"),
  ];

  return ordered.map((each) => ({
    name: each.name,
    action: handleDependency(each.dependent as DependentOption, each.foreignKey),
  }));
}

/** The job a `destroy_async` enqueues. Rails' `destroy_association_async_job`. */
export interface DestroyAssociationJob {
  owner: string;
  association: string;
  foreignKey: string;
  ownerId: unknown;
}

export function destroyAssociationAsyncJob(
  owner: string,
  association: string,
  foreignKey: string,
  ownerId: unknown,
): DestroyAssociationJob {
  return { owner, association, foreignKey, ownerId };
}

// --- touching -------------------------------------------------------------

/**
 * The columns a touch moves, and to what. Rails' `touch_attributes_with_time`.
 *
 * `updated_at` always, plus anything named. One timestamp for all of them
 * rather than `new Date()` per column, so a record touched across two columns
 * does not end up with two times a millisecond apart — which looks like two
 * edits to anything comparing them.
 */
export function touchAttributesWithTime(
  columns: readonly string[],
  at: Date = new Date(),
  timestampColumns: readonly string[] = ["updated_at"],
): Record<string, Date> {
  const moved: Record<string, Date> = {};

  for (const column of [...timestampColumns, ...columns]) moved[column] = at;

  return moved;
}

/**
 * Whether a save should move the timestamps. Rails'
 * `touch_model_timestamps_unless`.
 *
 * Skipped when the record already changed the column itself: an import that
 * sets `updated_at` deliberately means it, and overwriting it with the current
 * time throws away the only thing that said when the data was actually true.
 */
export function touchModelTimestampsUnless(
  recordTimestamps: boolean,
  changedColumns: readonly string[],
  timestampColumns: readonly string[] = ["updated_at"],
): boolean {
  if (!recordTimestamps) return false;

  return !timestampColumns.some((column) => changedColumns.includes(column));
}

/** Touches queued to run after the transaction commits. Rails' `touch_later`. */
const pending = new Map<string, { columns: Set<string>; at: Date }>();

/**
 * Queues a touch rather than issuing it. Rails' `touch_later`.
 *
 * Saving a hundred children each touching the same parent would otherwise
 * write that parent a hundred times inside one transaction — a hundred row
 * versions, a hundred index updates, and a lock held for the whole of it.
 * Queued, it is one write.
 */
export function touchLater(key: string, columns: readonly string[], at: Date = new Date()): void {
  const held = pending.get(key);

  if (held) {
    for (const column of columns) held.columns.add(column);

    // The latest time wins: the point is that the record changed, and the last
    // change is the one a cache key should reflect.
    held.at = at;

    return;
  }

  pending.set(key, { columns: new Set(columns), at });
}

/** Everything queued, and clears it. Rails' `touch_deferred_attributes`. */
export function touchRecord(): { key: string; columns: string[]; at: Date }[] {
  const queued = Array.from(pending, ([key, { columns, at }]) => ({
    key,
    columns: Array.from(columns),
    at,
  }));

  pending.clear();

  return queued;
}

export function pendingTouches(): number {
  return pending.size;
}

export function clearPendingTouches(): void {
  pending.clear();
}

/** The callbacks a `touch: true` association adds. Rails' `add_touch_callbacks`. */
export function addTouchCallbacks(column?: string): {
  afterSave: string[];
  afterDestroy: string[];
} {
  const columns = column === undefined ? [] : [column];

  return { afterSave: columns, afterDestroy: columns };
}

/** The callbacks a `dependent:` association adds. Rails' `add_destroy_callbacks`. */
export function addDestroyCallbacks(option: DependentOption): {
  before: boolean;
  after: boolean;
} {
  // A restriction has to run *before* the destroy, or it refuses something
  // that has already happened.
  return { before: option === "restrict", after: option !== "restrict" };
}
