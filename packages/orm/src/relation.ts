/**
 * Query building, ported from `ActiveRecord::Relation`.
 *
 * A relation is lazy and chainable, and only touches the database when it is
 * awaited or asked for a result — the property that makes `Post.where(...)`
 * composable in Rails. Making it a thenable is what gives us the same feel:
 *
 *     const posts = await Post.where({ published: true }).order("title").limit(10)
 *
 * Every value reaching SQL is bound, never interpolated. Column and table names
 * are quoted through the adapter, and anything used as an identifier is checked
 * against the model's known columns.
 */

import { arrayPredicateFor, isRangeCondition, rangePredicateFor } from "./predicate_builder.js";
import { createHash } from "node:crypto";
import type { Connection, Row } from "./connection.js";
import { checkWritable } from "./databases.js";
// Used inside a method, long after both modules have finished loading.
import { serialize } from "./model.js";

export type Direction = "asc" | "desc";

export type WhereValue = unknown;
export type Conditions = Record<string, WhereValue>;

/** One table joined to another, and the columns that connect them. */
export interface JoinSpec {
  /** The table being joined in. */
  table: string;
  /** The column on this side. */
  from: string;
  /** The column on the joined table. */
  to: string;
  /** Extra conditions, as a polymorphic association needs on its type column. */
  where?: { column: string; value: unknown }[];
}

interface JoinClause extends JoinSpec {
  kind: "inner" | "left";
}

interface WhereClause {
  sql: string;
  bindings: unknown[];
  /**
   * What the column was compared to, when it was a single value.
   *
   * Read by `build`, which seeds a new record from the equality conditions the
   * relation already carries — so `author.books.create(...)` sets the foreign
   * key without the caller doing it, and so does `where(published: 1).create()`.
   * A range, a list or raw SQL leaves this unset: there is no one value those
   * mean.
   */
  value?: unknown;
  /**
   * The column this came from, when it came from the object form.
   *
   * Only `merge` reads it, and only so it can do what Rails does: a merged
   * condition on a column replaces an earlier one rather than being ANDed with
   * it. A clause written as raw SQL has no single column and is always kept.
   */
  column?: string;
}

export interface RelationSource<T> {
  connection: Connection;
  tableName: string;
  primaryKey: string;
  /** Turns a database row into a model instance. */
  instantiate: (row: Row) => T;
  /**
   * Builds a new, unsaved record.
   *
   * Separate from `instantiate`, which is for a row that already exists and
   * marks the record persisted — building one from a relation's conditions is
   * the opposite case.
   */
  build?: (values: Record<string, unknown>) => T;
  /**
   * Work the source needs done before it can build records.
   *
   * A model has to know its column types to cast a row faithfully, and asking
   * the database for them is asynchronous while `instantiate` is not.
   */
  prepare?: () => Promise<void>;
  /**
   * Rewrites conditions before they become SQL.
   *
   * A deterministically encrypted column stores ciphertext, so matching it
   * means encrypting the value being looked for — wherever in a chain the
   * condition was added.
   */
  prepareConditions?: (conditions: Conditions) => Conditions;
  /**
   * The column a name means, following an attribute alias if there is one.
   *
   * Only for a bare identifier. `order("email")` on a model that aliases
   * `email` should sort by the aliased column rather than fail with "no such
   * column", and an expression is left alone because rewriting one means
   * parsing SQL.
   */
  resolveColumn?: (name: string) => string;
  /**
   * Casts a raw row the way `instantiate` would.
   *
   * For the reads that hand back values rather than records — `pluck` — so
   * they agree with the records. PostgreSQL returns a BIGINT as a string,
   * because one can be larger than a JavaScript number holds, so `post.id` was
   * a number and `pluck("id")` was a string for the same column.
   */
  castRow?: (row: Row) => Row;
  /**
   * How to reach an association's table from this one.
   *
   * Supplied by the model, because only it knows the associations. A relation
   * that had to guess would be inventing foreign keys.
   */
  joinFor?: (name: string) => JoinSpec;
  /** Loads named associations for a batch of records, one query each. */
  preload?: (records: T[], names: string[]) => Promise<void>;
}

/**
 * One batch of a walk.
 *
 * Not the relation itself: a relation is a thenable, and an async generator
 * awaits what it yields, so `yield relation` would deliver a loaded array.
 */
export interface Batch<T> {
  /** The primary keys this batch covers, in order. */
  keys: unknown[];
  /** A relation over exactly those rows, ready for `updateAll` or `includes`. */
  relation: Relation<T>;
}

export interface BatchOptions {
  /** How many rows a query reads at a time. Rails' 1000. */
  batchSize?: number;
  /** The primary key to begin at, inclusive. Rails' `start`. */
  start?: unknown;
  /** The primary key to stop at, inclusive. Rails' `finish`. */
  finish?: unknown;
  /** Which way to walk the key. */
  order?: Direction;
}

/**
 * Raised by `sole` when more than one record matches.
 *
 * Its own error rather than a generic one: "I expected exactly one" and "I
 * expected at least one" fail for different reasons and want different
 * handling. Finding two where one was expected usually means the data has a
 * duplicate nobody knew about, and answering with the first would hide it.
 */
export class SoleRecordExceeded extends Error {
  constructor(readonly table: string) {
    super(`Wanted one ${table} and found more than one.`);
    this.name = "SoleRecordExceeded";
  }
}

/** Raised by `find` and `first!` when nothing matches. Rails' RecordNotFound. */
export class RecordNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordNotFound";
  }
}

/**
 * ANDs a set of clauses into one fragment, or nothing when there are none.
 *
 * Each clause is bracketed: a clause may itself be an OR, and `a OR b AND c`
 * does not mean what the person who wrote it thought.
 */
/**
 * Brackets a clause only when it needs it.
 *
 * A clause containing OR has to keep its shape when ANDed with anything else,
 * since SQL binds AND tighter — `a OR b AND c` means `a OR (b AND c)`, so a
 * condition added after an `or` would silently attach to one side of it.
 * Everything else is left bare, because a WHERE clause wrapped in brackets it
 * does not need is one more thing to read past in a log.
 *
 * Values are always bound, never inlined, so no string literal can contain the
 * word this looks for.
 */
function bracketed(sql: string): string {
  return /\bor\b/i.test(sql) ? `(${sql})` : sql;
}

function joinClauses(clauses: WhereClause[]): { sql: string; bindings: unknown[] } | undefined {
  if (clauses.length === 0) return undefined;

  return {
    sql: clauses.map((clause) => `(${clause.sql})`).join(" AND "),
    bindings: clauses.flatMap((clause) => clause.bindings),
  };
}

/**
 * What a lock keeps out. Rails' `lock` and `lock("FOR SHARE")`.
 *
 * The two weaker Postgres modes are here too: `no key update` blocks writes
 * but lets another transaction take a foreign key against the row, which is
 * what stops a `belongs_to` insert queueing behind an unrelated edit to its
 * parent.
 */
export type LockMode = "update" | "share" | "no key update" | "key share";

/**
 * The clause each adapter wants, or none at all.
 *
 * SQLite has no row locking and needs none: a write transaction locks the
 * whole database, so the read-modify-write this protects is already
 * serialized. Emitting `FOR UPDATE` there would be a syntax error — so the
 * same application code is correct on all three, and only the SQL differs.
 *
 * MySQL spelled the shared lock `LOCK IN SHARE MODE` until 8.0 and accepts
 * `FOR SHARE` from 8.0 on; MariaDB accepts both. The older spelling is used
 * because it is the one every supported version understands.
 */
function lockClause(adapter: string, mode: LockMode): string {
  if (adapter === "sqlite") return "";

  if (mode === "share") {
    return adapter === "mysql" ? " LOCK IN SHARE MODE" : " FOR SHARE";
  }

  // The weaker modes are Postgres-only. MySQL is given the nearest thing it
  // has rather than a syntax error: a lock that is stronger than asked for is
  // correct and slower, which is the right way round to be wrong.
  if (mode === "no key update" || mode === "key share") {
    return adapter === "postgres" ? ` FOR ${mode.toUpperCase()}` : " FOR UPDATE";
  }

  return " FOR UPDATE";
}

/**
 * Checks a row count before it reaches the SQL.
 *
 * `LIMIT` and `OFFSET` cannot be bound as parameters, so the number is
 * interpolated — through `Number`, which is what stops a string being SQL. A
 * value that is not a number survives that as the text `NaN`:
 *
 *     Post.all().limit(Number(params.get("per_page")))
 *     -> SELECT ... LIMIT NaN
 *
 * With no `per_page` in the query string that is what a pagination call
 * produces, and the failure arrives from the database as a syntax error
 * pointing at generated SQL. Refusing it here means the message names the
 * call that was wrong.
 */
function countFor(what: string, count: number): number {
  if (!Number.isInteger(count) || count < 0) {
    throw new TypeError(
      `${what} needs a whole number of rows, and was given ${JSON.stringify(count)}.`,
    );
  }

  return count;
}

/** The parts of a relation `unscope`, `only` and `except` can name. */
export type RelationClause =
  | "where"
  | "order"
  | "limit"
  | "offset"
  | "select"
  | "includes"
  | "group"
  | "having"
  | "distinct"
  | "lock"
  | "joins";

const ALL_CLAUSES: readonly RelationClause[] = [
  "where",
  "order",
  "limit",
  "offset",
  "select",
  "includes",
  "group",
  "having",
  "distinct",
  "lock",
  "joins",
];

/**
 * What each adapter spells "no limit, but I still need a LIMIT clause".
 *
 * MySQL refuses a negative one, so it takes the largest value a BIGINT holds —
 * which is what its own documentation suggests for exactly this.
 */
const ALL_ROWS: Record<string, string> = {
  sqlite: "-1",
  mysql: "18446744073709551615",
};

/**
 * What `with` and `withRecursive` take: a name to a relation or to raw SQL.
 *
 * Anything that can produce SQL, rather than `Relation<unknown>`: a Relation is
 * invariant in its row type, so `Relation<Post>` is not a `Relation<unknown>`
 * and requiring one would mean every caller casting. Nothing here reads rows
 * out of the expression — it is a subquery in this statement — so the only
 * thing actually needed is the SQL.
 */
export type WithExpressions = Record<
  string,
  { toSql(): { sql: string; bindings: unknown[] } } | { sql: string; bindings?: unknown[] }
>;

/** One named subquery in a WITH clause. */
interface CommonTableExpression {
  name: string;
  sql: string;
  bindings: unknown[];
  recursive: boolean;
}

/** The aggregate functions `calculate` will dispatch to. */
export type CalculationName = "count" | "sum" | "average" | "minimum" | "maximum";

export class Relation<T> implements PromiseLike<T[]> {
  #source: RelationSource<T>;
  #wheres: WhereClause[] = [];
  #orders: { column: string; direction: Direction }[] = [];
  #limit: number | undefined;
  /** Set by `none`: this relation matches nothing and knows it. */
  #none = false;
  #offset: number | undefined;
  #selects: string[] | undefined;
  #includes: string[] = [];
  #groups: string[] = [];
  #havings: WhereClause[] = [];
  #distinct = false;
  #lock: LockMode | undefined;
  #annotations: string[] = [];
  #strictLoading = false;
  #joins: JoinClause[] = [];
  /** Named subqueries put in front of the SELECT. Rails' `with`. */
  #withs: CommonTableExpression[] = [];
  /** What to select from instead of the model's table. Rails' `from`. */
  #from: string | undefined;
  /**
   * Records handed over by `includes`. Chaining clears this — `#clone` does not
   * copy it — so adding a condition re-queries rather than filtering a stale
   * array, which is how Rails behaves too.
   */
  #preloaded: T[] | undefined;

  constructor(source: RelationSource<T>) {
    this.#source = source;
  }

  #clone(): Relation<T> {
    const next = new Relation<T>(this.#source);
    next.#wheres = [...this.#wheres];
    next.#orders = [...this.#orders];
    next.#limit = this.#limit;
    next.#none = this.#none;
    next.#offset = this.#offset;
    next.#selects = this.#selects ? [...this.#selects] : undefined;
    next.#includes = [...this.#includes];
    next.#groups = [...this.#groups];
    next.#havings = [...this.#havings];
    next.#distinct = this.#distinct;
    next.#lock = this.#lock;
    next.#annotations = [...this.#annotations];
    next.#joins = [...this.#joins];
    next.#withs = [...this.#withs];
    next.#from = this.#from;
    return next;
  }

  get connection(): Connection {
    return this.#source.connection;
  }

  /**
   * Adds a condition.
   *
   * An object is a set of equality checks, with null becoming IS NULL and an
   * array becoming IN, exactly as Rails does. A string form takes bindings so
   * values are never interpolated.
   */
  where(conditions: Conditions): Relation<T>;
  where(sql: string, ...bindings: unknown[]): Relation<T>;
  where(conditionsOrSql: Conditions | string, ...bindings: unknown[]): Relation<T> {
    const next = this.#clone();

    if (typeof conditionsOrSql === "string") {
      next.#wheres.push({ sql: conditionsOrSql, bindings: this.#bind(bindings) });
      return next;
    }

    const prepared = this.#source.prepareConditions?.(conditionsOrSql) ?? conditionsOrSql;

    for (const [column, value] of Object.entries(prepared)) {
      const quoted = this.#quoteColumn(column);

      if (value === null) {
        next.#wheres.push({ sql: `${quoted} IS NULL`, bindings: [], column });
      } else if (Array.isArray(value)) {
        // Through the predicate builder, which pulls a `null` out of the list
        // and asks for it separately. `IN (1, NULL)` never matches the null
        // rows — SQL's three-valued logic makes every comparison with null
        // unknown — so `where({ parent_id: [1, null] })` means "child of 1, or
        // a root" and this used to silently mean only the first half. An empty
        // list still matches nothing rather than erroring, which is Rails'
        // behaviour and the builder's.
        const predicate = arrayPredicateFor(column, value, (name) => this.#quoteColumn(name));

        next.#wheres.push({ sql: predicate.sql, bindings: this.#bind(predicate.binds), column });
      } else if (isRangeCondition(value)) {
        // Without this a range falls through to `=` and is bound as an
        // object, which the driver stringifies into a comparison nobody wrote:
        // it matches nothing, and nothing says so. `predicate_builder` has
        // known how to write one since it was added.
        const predicate = rangePredicateFor(column, value, (name) => this.#quoteColumn(name));

        next.#wheres.push({ sql: predicate.sql, bindings: this.#bind(predicate.binds), column });
      } else {
        // `value` stays as it was handed over. It is what `firstOrCreate`
        // builds a new record from, and that wants the Date rather than the
        // string the database is about to be given.
        next.#wheres.push({ sql: `${quoted} = ?`, bindings: this.#bind([value]), column, value });
      }
    }
    return next;
  }

  /**
   * The values a condition binds, in the form the driver takes.
   *
   * The same `serialize` a save uses, and the reason it has to be the same one
   * is that a write and a read of the same column have to agree. `create` has
   * always serialized; `where` did not, so `where({ at: aDate })` handed a Date
   * straight to the driver and bun's SQLite refused it outright — "Binding
   * expected string, TypedArray, boolean, number, bigint or null". Querying a
   * datetime column by a Date is the most ordinary thing there is, and it
   * threw.
   *
   * Idempotent for everything it touches, which matters because `or()` merges
   * bindings that have already been through here.
   */
  #bind(values: readonly unknown[]): unknown[] {
    return values.map((value) => serialize(value, this.connection));
  }

  /** Rails' `where.not`, in its common single-condition form. */
  whereNot(conditions: Conditions): Relation<T> {
    const next = this.#clone();
    for (const [column, value] of Object.entries(conditions)) {
      const quoted = this.#quoteColumn(column);
      if (value === null) {
        next.#wheres.push({ sql: `${quoted} IS NOT NULL`, bindings: [] });
      } else if (Array.isArray(value)) {
        next.#wheres.push({
          sql: `${quoted} NOT IN (${value.map(() => "?").join(", ")})`,
          bindings: this.#bind(value),
        });
      } else {
        next.#wheres.push({ sql: `${quoted} != ?`, bindings: this.#bind([value]) });
      }
    }
    return next;
  }

  /**
   * Either set of conditions. Rails' `or`.
   *
   *     Post.where({ draft: 1 }).or(Post.where({ author_id: me }))
   *     // WHERE (draft = ?) OR (author_id = ?)
   *
   * Both sides are bracketed, because `a AND b OR c` is not what anybody who
   * wrote this meant — SQL binds AND tighter than OR, so leaving the brackets
   * off changes the query into a different one that still runs.
   */
  or(other: Relation<T>): Relation<T> {
    this.#assertCompatible(other, "or");

    const mine = joinClauses(this.#wheres);
    const theirs = joinClauses(other.#wheres);

    const next = this.#clone();

    // One side with no conditions matches every row, and anything OR true is
    // true — so the result is unconditional rather than the other side's
    // conditions. Getting this wrong silently narrows the query.
    if (!mine || !theirs) {
      next.#wheres = [];
      return next;
    }

    next.#wheres = [
      {
        sql: `(${mine.sql}) OR (${theirs.sql})`,
        bindings: [...mine.bindings, ...theirs.bindings],
      },
    ];

    return next;
  }

  /**
   * Folds another relation's conditions into this one. Rails' `merge`.
   *
   * A merged condition on a column *replaces* an earlier one rather than being
   * ANDed with it, which is Rails' behaviour and the only useful one: merging
   * `{ status: "published" }` onto `{ status: "draft" }` should mean published,
   * not a query that matches nothing.
   *
   * That only works for conditions written in the object form, since a raw SQL
   * fragment has no one column to replace. Those are kept and ANDed.
   */
  merge(other: Relation<T>): Relation<T> {
    const next = this.#clone();

    const replaced = new Set(
      other.#wheres.map((clause) => clause.column).filter((column): column is string => !!column),
    );

    next.#wheres = [
      ...next.#wheres.filter((clause) => !clause.column || !replaced.has(clause.column)),
      ...other.#wheres,
    ];

    // Rails takes the other relation's ordering and paging when it has any.
    if (other.#orders.length > 0) next.#orders = [...other.#orders];
    if (other.#limit !== undefined) next.#limit = other.#limit;
    if (other.#offset !== undefined) next.#offset = other.#offset;
    if (other.#includes.length > 0) next.#includes = [...other.#includes];

    return next;
  }

  /**
   * Rails refuses to `or` two relations that differ in anything but their
   * conditions, and so does this.
   *
   * The alternative is quietly dropping one side's `limit` or `joins`, which
   * produces a query that runs and answers something else.
   */
  #assertCompatible(other: Relation<T>, method: string): void {
    const differences: string[] = [];

    if (this.#limit !== other.#limit) differences.push("limit");
    if (this.#offset !== other.#offset) differences.push("offset");
    if (this.#distinct !== other.#distinct) differences.push("distinct");
    if (this.#joins.length !== other.#joins.length) differences.push("joins");
    if (this.#groups.join() !== other.#groups.join()) differences.push("group");
    if (this.#havings.length !== other.#havings.length) differences.push("having");

    if (differences.length > 0) {
      throw new Error(
        `Relations passed to \`${method}\` must differ only in their conditions. ` +
          `These differ in: ${differences.join(", ")}.`,
      );
    }
  }

  order(column: string, direction: Direction = "asc"): Relation<T> {
    // Checked at run time as well as by the compiler, because a direction is
    // usually a query parameter — `?sort=title&dir=descending` — and the type
    // says nothing about a string that arrived over the wire. Left alone, an
    // unrecognised direction became ASC, so a list asked to sort one way
    // silently sorted the other.
    if (direction !== "asc" && direction !== "desc") {
      throw new Error(`Unknown sort direction "${String(direction)}". Use "asc" or "desc".`);
    }

    const next = this.#clone();
    next.#orders.push({ column: this.#resolve(column), direction });
    return next;
  }

  /**
   * A bare identifier through the model's aliases; anything else untouched.
   *
   * The guard is the point: `order("created_at DESC")` and `select("count(*)")`
   * are expressions, and rewriting one would mean parsing SQL.
   */
  #resolve(column: string): string {
    if (!this.#source.resolveColumn) return column;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) return column;

    return this.#source.resolveColumn(column);
  }

  limit(count: number): Relation<T> {
    const next = this.#clone();
    next.#limit = countFor("limit", count);
    return next;
  }

  offset(count: number): Relation<T> {
    const next = this.#clone();
    next.#offset = countFor("offset", count);
    return next;
  }

  /**
   * Rails' `includes`: preload these associations for the whole result set.
   *
   * One extra query per association instead of one per row, which is the
   * difference between a list page that scales and an N+1.
   */
  /**
   * Joins an association's table. Rails' `joins`.
   *
   * An inner join, so a record with none of the association drops out — which
   * is what makes `Post.joins("comments")` mean "posts that have comments".
   */
  joins(...names: string[]): Relation<T> {
    return this.#addJoins("inner", names);
  }

  /**
   * Joins and keeps records that have none. Rails' `left_joins`.
   *
   * The one to use for counting: an inner join answers "how many posts have
   * comments" when the question was "how many comments has each post".
   */
  leftJoins(...names: string[]): Relation<T> {
    return this.#addJoins("left", names);
  }

  /**
   * Records that have none of an association. Rails' `where.missing`.
   *
   *     await Post.all().whereMissing("comments")
   *
   * A left join and a null check on the other side, which is the one shape SQL
   * has for "no matching row" and the one nobody remembers. Written by hand it
   * is an inner join by mistake about half the time, and an inner join answers
   * the opposite question.
   *
   * The alternative — `NOT IN (SELECT ...)` — is the version that quietly
   * matches nothing when the subquery returns a NULL, because `x NOT IN (1,
   * NULL)` is NULL rather than true. This shape has no such edge.
   */
  whereMissing(...names: string[]): Relation<T> {
    if (!this.#source.joinFor) {
      throw new Error("This relation cannot join: its source does not know the associations.");
    }

    let next = this.leftJoins(...names);

    for (const name of names) {
      const spec = this.#source.joinFor(name);

      next = next.where(
        `${this.connection.quote(spec.table)}.${this.connection.quote(spec.to)} IS NULL`,
      );
    }

    return next;
  }

  #addJoins(kind: "inner" | "left", names: string[]): Relation<T> {
    if (!this.#source.joinFor) {
      throw new Error("This relation cannot join: its source does not know the associations.");
    }

    const next = this.#clone();

    for (const name of names) {
      const spec = this.#source.joinFor(name);

      // Joining the same table twice produces a cross product, so a relation
      // that was told to join it twice joins it once.
      if (next.#joins.some((join) => join.table === spec.table)) continue;
      next.#joins.push({ ...spec, kind });
    }

    return next;
  }

  includes(...names: string[]): Relation<T> {
    const next = this.#clone();
    next.#includes.push(...names);
    return next;
  }

  /** Rails' `group`. */
  group(...columns: string[]): Relation<T> {
    const next = this.#clone();
    next.#groups.push(...columns);
    return next;
  }

  /** Rails' `having`, which filters groups rather than rows. */
  having(sql: string, ...bindings: unknown[]): Relation<T> {
    const next = this.#clone();
    // Bound the same way a `where` binds, because it is the same question
    // asked of a group: `having("MAX(at) > ?", aDate)` has no reason to
    // behave differently from `where("at > ?", aDate)`.
    next.#havings.push({ sql, bindings: this.#bind(bindings) });
    return next;
  }

  /** Rails' `distinct`. */
  distinct(value = true): Relation<T> {
    const next = this.#clone();
    next.#distinct = value;
    return next;
  }

  /**
   * Locks the rows this reads until the transaction ends. Rails' `lock`.
   *
   *     await connection.transaction(async () => {
   *       const account = await Account.where({ id }).lock().first()
   *       await account.update({ balance: account.balance - 10 })
   *     })
   *
   * The problem it solves is the one every balance and every counter has:
   * two requests read the same row, both subtract from what they read, and one
   * of the two subtractions vanishes. Nothing about that is visible in either
   * request — both succeeded — and it happens under load and never in a test.
   *
   * `"share"` lets other readers in and keeps writers out, which is what a
   * foreign-key check wants; the default keeps both out.
   *
   * Only meaningful inside a transaction: a lock is released when the
   * transaction ends, and a `SELECT … FOR UPDATE` outside one is released
   * immediately, which is the same as not taking it.
   */
  lock(mode: LockMode = "update"): Relation<T> {
    const next = this.#clone();
    next.#lock = mode;
    return next;
  }

  /**
   * Attaches a comment to the statement. Rails' `annotate`.
   *
   *     Post.all().annotate("dashboard#index")
   *     // SELECT … /* dashboard#index *\/
   *
   * A slow query log names the statement and not the code that sent it, so the
   * usual way to find the caller is to grep the application for something that
   * looks like it. A comment carries the answer along with the query, and
   * every database's slow log and `pg_stat_statements` keeps it.
   *
   * `*\/` is stripped rather than escaped, because there is no escape for it:
   * the sequence ends the comment, and whatever followed would be SQL. This is
   * the one place a relation puts caller-supplied text into a statement
   * without a binding, so it is the one place that could be an injection.
   */
  /**
   * Refuses to load these records' associations lazily. Rails' `strict_loading`.
   *
   *     const posts = await Post.all().includes("author").strictLoading()
   *
   * The N+1 guard. A list page reads `post.author` inside a loop, one query per
   * post, and nothing in the code says so — it looks exactly like reading an
   * attribute. This turns it into a failure where it happens rather than a
   * graph in a dashboard three weeks later.
   *
   * On the query rather than on the class, because the query is where an N+1
   * costs something. A background job walking one record at a time carries on
   * as it was.
   */
  strictLoading(on = true): Relation<T> {
    const next = this.#clone();
    next.#strictLoading = on;

    return next;
  }

  annotate(...comments: string[]): Relation<T> {
    const next = this.#clone();

    for (const comment of comments) {
      next.#annotations.push(comment.replaceAll("*/", "").replaceAll(String.fromCharCode(0), ""));
    }

    return next;
  }

  /**
   * Asks the database what it would do with this query. Rails' `explain`.
   *
   * Returns the plan as rows rather than a formatted string, since what each
   * adapter reports differs enough that pretending otherwise would lose the
   * detail somebody ran this for.
   */
  async explain(): Promise<Row[]> {
    const { sql, bindings } = this.toSql();
    const keyword = this.connection.adapter === "sqlite" ? "EXPLAIN QUERY PLAN" : "EXPLAIN";

    return await this.connection.query<Row>(`${keyword} ${sql}`, bindings);
  }

  select(...columns: string[]): Relation<T> {
    const next = this.#clone();
    next.#selects = columns;
    return next;
  }

  #quoteColumn(column: string): string {
    // A condition on a joined table names it: `comments.approved`.
    const dotted = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(column);

    if (dotted) {
      const [, table, name] = dotted;
      // Only a table this relation actually joined, so a condition cannot
      // reach a table the query does not mention.
      if (table !== this.#tableName && !this.#joins.some((join) => join.table === table)) {
        throw new Error(
          `Cannot filter on "${column}": this relation does not join "${table}". Add .joins("...") first.`,
        );
      }
      return `${this.connection.quote(table!)}.${this.connection.quote(name!)}`;
    }

    // Identifiers cannot be bound, so they are validated rather than escaped.
    // Anything that is not a plain column name is rejected outright.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) {
      throw new Error(`Invalid column name: ${column}`);
    }
    return `${this.connection.quote(this.#tableName)}.${this.connection.quote(column)}`;
  }

  /**
   * What this statement selects from, which `from` may have replaced.
   *
   * Every column reference has to follow it: qualified against the model's
   * table, an ORDER BY on a relation reading from a common table expression
   * names a table the statement no longer mentions, and the database rejects
   * the whole query.
   */
  get #tableName(): string {
    return this.#from ?? this.#source.tableName;
  }

  /**
   * Selects from something other than the model's table. Rails' `from`.
   *
   *     Post.with({ recent: Post.where(...) }).from("recent")
   *
   * The name is used as written, so it can be a common table expression
   * defined by `with` or a table this model does not otherwise know about. It
   * is quoted as an identifier and never interpolated as SQL, so a value that
   * reached here from a parameter cannot become a query.
   */
  from(source: string): Relation<T> {
    // Validated rather than escaped, like every other identifier here: quoting
    // a name with a quote in it produces something inert but nonsensical, and
    // a caller who reached this with a value from a parameter should be told
    // rather than handed a query against a table nobody named.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(source)) {
      throw new Error(`Invalid table name: ${source}`);
    }

    const next = this.#clone();
    next.#from = source;

    return next;
  }

  /**
   * Names a subquery this query can then select from. Rails' `with`.
   *
   *     Post.with({ recent: Post.where("created_at > ?", cutoff) })
   *         .from("recent")
   *
   * The reason to reach for one rather than a subquery written inline: a
   * common table expression is named, so it can be joined against more than
   * once and read once. Written inline, the same subquery appearing twice is
   * two subqueries, and the database is under no obligation to notice they are
   * the same.
   */
  with(expressions: WithExpressions): Relation<T> {
    return this.#withExpressions(expressions, false);
  }

  /**
   * The same, for a query that refers to itself. Rails' `with_recursive`.
   *
   *     Comment.withRecursive({
   *       thread: {
   *         sql: `SELECT * FROM comments WHERE id = ?
   *               UNION ALL
   *               SELECT c.* FROM comments c JOIN thread ON c.parent_id = thread.id`,
   *         bindings: [rootId],
   *       },
   *     }).from("thread")
   *
   * This is the one that earns its keep. A tree — a comment thread, an org
   * chart, a category hierarchy — cannot be fetched in one round trip any
   * other way. The alternatives are a query per level, which is a round trip
   * per level of depth and unbounded, or a materialized path column, which is
   * a second copy of the tree that has to be kept correct on every move.
   *
   * RECURSIVE is a property of the whole WITH clause rather than of one
   * expression, so mixing this with `with` makes the whole clause recursive —
   * `#withClause` asks whether any expression wants it. That is what the SQL
   * standard says and what every database implements; a non-recursive
   * expression inside a recursive clause is still fine.
   */
  withRecursive(expressions: WithExpressions): Relation<T> {
    return this.#withExpressions(expressions, true);
  }

  #withExpressions(expressions: WithExpressions, recursive: boolean): Relation<T> {
    const next = this.#clone();

    for (const [name, expression] of Object.entries(expressions)) {
      const built =
        "toSql" in expression
          ? expression.toSql()
          : { sql: expression.sql, bindings: expression.bindings ?? [] };

      // Replacing by name rather than appending, so chaining `with` twice with
      // the same name does not put two definitions in one clause — which is a
      // syntax error the database reports about a name the caller only wrote
      // once.
      const existing = next.#withs.findIndex((one) => one.name === name);
      const entry: CommonTableExpression = {
        name,
        sql: built.sql,
        bindings: built.bindings,
        recursive,
      };

      if (existing === -1) next.#withs.push(entry);
      else next.#withs[existing] = entry;
    }

    return next;
  }

  /** The WITH clause and its bindings, which come before everything else. */
  #withClause(bindings: unknown[]): string {
    if (this.#withs.length === 0) return "";

    const recursive = this.#withs.some((one) => one.recursive);
    const parts = this.#withs.map((one) => {
      bindings.push(...one.bindings);

      return `${this.connection.quote(one.name)} AS (${one.sql})`;
    });

    return `WITH ${recursive ? "RECURSIVE " : ""}${parts.join(", ")} `;
  }

  /** The SQL and bindings this relation would run. Useful in tests and logs. */
  toSql(): { sql: string; bindings: unknown[] } {
    const connection = this.connection;
    // The name everything else in the statement qualifies against: a `from`
    // replaces the model's table, so `table.*` and every join's ON clause have
    // to follow it or they name a table the statement no longer selects.
    const table = connection.quote(this.#tableName);
    const bindings: unknown[] = [];

    const columns = this.#selects
      ? this.#selects.map((column) => this.#quoteColumn(column)).join(", ")
      : `${table}.*`;

    // Built before the SELECT so its bindings are pushed first: they appear
    // first in the statement, and a positional placeholder counts from the
    // left regardless of which clause it sits in.
    const withClause = this.#withClause(bindings);

    let sql = `${withClause}SELECT ${this.#distinct ? "DISTINCT " : ""}${columns} FROM ${table}`;

    for (const join of this.#joins) {
      const joined = connection.quote(join.table);
      const keyword = join.kind === "left" ? "LEFT OUTER JOIN" : "INNER JOIN";

      let on = `${table}.${connection.quote(join.from)} = ${joined}.${connection.quote(join.to)}`;

      // A polymorphic association needs its type column in the ON clause, not
      // the WHERE: on a left join, putting it in WHERE would drop the rows the
      // left join exists to keep.
      for (const condition of join.where ?? []) {
        bindings.push(condition.value);
        on += ` AND ${joined}.${connection.quote(condition.column)} = ?`;
      }

      sql += ` ${keyword} ${joined} ON ${on}`;
    }

    if (this.#wheres.length > 0) {
      const clauses = this.#wheres.map((clause) => {
        bindings.push(...clause.bindings);
        return bracketed(clause.sql);
      });
      sql += ` WHERE ${clauses.join(" AND ")}`;
    }

    if (this.#groups.length > 0) {
      sql += ` GROUP BY ${this.#groups.map((column) => this.#quoteColumn(column)).join(", ")}`;
    }

    if (this.#havings.length > 0) {
      const clauses = this.#havings.map((clause) => {
        bindings.push(...clause.bindings);
        return clause.sql;
      });
      sql += ` HAVING ${clauses.join(" AND ")}`;
    }

    if (this.#orders.length > 0) {
      const clauses = this.#orders.map(
        (order) =>
          `${this.#quoteColumn(order.column)} ${order.direction === "desc" ? "DESC" : "ASC"}`,
      );
      sql += ` ORDER BY ${clauses.join(", ")}`;
    }

    if (this.#limit !== undefined) sql += ` LIMIT ${Number(this.#limit)}`;

    if (this.#offset !== undefined) {
      // SQLite and MySQL will not take an OFFSET without a LIMIT in front of
      // it — `OFFSET 4` on its own is a syntax error — so an offset with no
      // limit needs one meaning "all the rest". Rails' adapters do the same.
      //
      // Postgres takes a bare OFFSET and refuses `LIMIT -1` outright:
      // `LIMIT must not be negative`. The comment here used to claim it "does
      // not mind", and the fallback handed it exactly that — so `offset` with
      // no `limit` failed on Postgres, which is `page 2` on any list that
      // skips rather than paginates. Nothing caught it because these tests
      // only ever ran on SQLite.
      const all = ALL_ROWS[this.connection.adapter];
      if (this.#limit === undefined && all !== undefined) sql += ` LIMIT ${all}`;

      sql += ` OFFSET ${Number(this.#offset)}`;
    }

    if (this.#lock) sql += lockClause(connection.adapter, this.#lock);

    for (const comment of this.#annotations) sql += ` /* ${comment} */`;

    return { sql: this.#renumber(sql), bindings };
  }

  /**
   * PostgreSQL numbers its placeholders, so the `?` used while building is
   * rewritten once the final order is known.
   */
  #renumber(sql: string): string {
    if (this.connection.adapter !== "postgres") return sql;
    let index = 0;
    return sql.replaceAll("?", () => `$${++index}`);
  }

  /**
   * A copy of this relation that already holds its records.
   *
   * Used by `includes`, so a preloaded association is still a Relation and
   * runs no query when awaited.
   */
  resolvedWith(records: T[]): Relation<T> {
    const relation = new Relation<T>(this.#source);
    relation.#preloaded = records;
    return relation;
  }

  /** Runs the query and returns model instances, preloading any includes. */
  async toArray(): Promise<T[]> {
    if (this.#none) return [];

    if (this.#preloaded) return this.#preloaded;

    await this.#source.prepare?.();

    const { sql, bindings } = this.toSql();
    const rows = await this.connection.query<Row>(sql, bindings);
    const records = rows.map((row) => this.#source.instantiate(row));

    // Marked before preloading, not after: `includes` fills the associations
    // it was given, and anything it did not fill is exactly what this is meant
    // to catch.
    if (this.#strictLoading) {
      for (const record of records) {
        (record as { strictLoading?: (on?: boolean) => unknown }).strictLoading?.();
      }
    }

    if (this.#includes.length > 0 && this.#source.preload) {
      await this.#source.preload(records, this.#includes);
    }
    return records;
  }

  /**
   * Makes the relation awaitable, which is what keeps chains lazy.
   *
   * The linter warns against a thenable class because one can be awaited by
   * accident. Here that is the whole design: a relation must be composable
   * until it is awaited, which is what makes `Post.where(...).order(...)` work
   * the way it does in Rails.
   */
  // oxlint-disable-next-line unicorn/no-thenable
  then<R1 = T[], R2 = never>(
    onfulfilled?: ((value: T[]) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.toArray().then(onfulfilled, onrejected);
  }

  async first(): Promise<T | null> {
    const rows = await this.#firstOrdered().limit(1).toArray();
    return rows[0] ?? null;
  }

  /** Rails' `first!`. */
  async firstOrFail(): Promise<T> {
    const record = await this.first();
    if (!record) {
      throw new RecordNotFound(`Could not find ${this.#source.tableName} matching the conditions`);
    }
    return record;
  }

  /**
   * Exactly one record, or an error saying which way it went wrong.
   *
   * Rails' `sole`. `first` answers the same thing when one row matches and
   * quietly picks a winner when two do — so a uniqueness assumption that has
   * stopped being true reads as normal behaviour. This one says so.
   *
   * Two rows are fetched rather than counted separately: one query either way,
   * and no chance of the count and the read disagreeing about a table somebody
   * else is writing to.
   */
  async sole(): Promise<T> {
    const rows = await this.#firstOrdered().limit(2).toArray();

    if (rows.length === 0) {
      throw new RecordNotFound(`Could not find ${this.#source.tableName} matching the conditions`);
    }

    if (rows.length > 1) throw new SoleRecordExceeded(this.#source.tableName);

    return rows[0] as T;
  }

  async last(): Promise<T | null> {
    const rows = await this.reverseOrder().limit(1).toArray();
    return rows[0] ?? null;
  }

  /**
   * The same rows, the other way up. Rails' `reverse_order`.
   *
   * Every ordering flips, not just the first, or a two-column sort would come
   * back grouped the old way and only reversed within each group.
   *
   * With no ordering at all it sorts by the primary key descending, which is
   * what makes `last` mean anything: a query with no ORDER BY has no last row,
   * only whichever row the planner happened to hand back last.
   */
  reverseOrder(): Relation<T> {
    const next = this.#clone();

    next.#orders =
      this.#orders.length === 0
        ? [{ column: this.#source.primaryKey, direction: "desc" }]
        : this.#orders.map((order) => ({
            ...order,
            direction: order.direction === "asc" ? "desc" : "asc",
          }));

    return next;
  }

  /**
   * The nth record in order, counting from one.
   *
   * Rails names the first five and then, for its own amusement, the
   * forty-second. They are useful in tests and in the console far more than in
   * application code, which is the honest reason they exist.
   *
   * Ordered by the primary key when nothing else is, exactly as `first` is:
   * without an ORDER BY there is no second row to speak of.
   */
  async #nth(position: number): Promise<T | null> {
    const rows = await this.#firstOrdered()
      .offset(position - 1)
      .limit(1)
      .toArray();

    return rows[0] ?? null;
  }

  /** Rails' `second`. */
  async second(): Promise<T | null> {
    return await this.#nth(2);
  }

  /** Rails' `third`. */
  async third(): Promise<T | null> {
    return await this.#nth(3);
  }

  /** Rails' `fourth`. */
  async fourth(): Promise<T | null> {
    return await this.#nth(4);
  }

  /** Rails' `fifth`. */
  async fifth(): Promise<T | null> {
    return await this.#nth(5);
  }

  /** Rails' `forty_two`, which is a joke Rails has kept since 2012. */
  async fortyTwo(): Promise<T | null> {
    return await this.#nth(42);
  }

  /** Rails' `second_to_last`. */
  async secondToLast(): Promise<T | null> {
    const rows = await this.reverseOrder().offset(1).limit(1).toArray();
    return rows[0] ?? null;
  }

  /** Rails' `third_to_last`. */
  async thirdToLast(): Promise<T | null> {
    const rows = await this.reverseOrder().offset(2).limit(1).toArray();
    return rows[0] ?? null;
  }

  #firstOrdered(): Relation<T> {
    if (this.#orders.length > 0) return this;
    return this.order(this.#source.primaryKey);
  }

  /**
   * A key for this whole collection. Rails' `cache_key`.
   *
   *     const key = await Post.published().collectionCacheKey()
   *
   * How a list page gets one cache entry rather than none. The alternatives
   * are both bad: no cache at all, or a cache per record that has to be
   * reassembled on every request — which costs a read per row and gives back
   * most of what caching was for.
   *
   * The key is the count and the newest timestamp, digested. Together those
   * change whenever a member is added, removed, or edited, which is exactly
   * when the rendered list stops being right. Count alone misses an edit;
   * timestamp alone misses a deletion — the row that changed is gone, so the
   * maximum can go *down* and a key built on it would repeat a key it had
   * already used, serving a list with a record still in it.
   */
  async collectionCacheKey(timestampColumn = "updated_at"): Promise<string> {
    const table = this.#source.tableName;
    // One statement, and the maximum read raw. `maximum` returns a number, so
    // a datetime column comes back NaN through it — which made the timestamp
    // half of this key contribute nothing at all, and the key change only when
    // the count did. Counting and taking the maximum together also costs one
    // round trip rather than two.
    const { sql, bindings } = this.toSql();
    const quoted = this.connection.quote(timestampColumn);

    let size = 0;
    let newest: unknown = null;

    try {
      const rows = await this.connection.query<Row>(
        `SELECT COUNT(*) AS collection_size, MAX(${quoted}) AS collection_newest FROM (${sql}) AS collection_source`,
        bindings,
      );

      size = Number(rows[0]?.collection_size ?? 0);
      newest = rows[0]?.collection_newest ?? null;
    } catch {
      // A table with no such column still deserves a key. Count alone is a
      // weaker key, not a wrong one: it misses an edit, so a caller relying on
      // it should name a column the table has.
      size = await this.count();
    }

    const stamp = newest === null || newest === undefined ? "" : String(newest);
    const digest = createHash("sha256")
      .update(`${table}/${String(size)}-${stamp}`)
      .digest("hex")
      .slice(0, 16);

    return `${table}/query-${digest}`;
  }

  async count(): Promise<number> {
    if (this.#none) return 0;

    this.#refuseGrouped("count", "countByGroup()");

    return Number(await this.#scalar(`COUNT(*)`, "count")) || 0;
  }

  /**
   * Refuses a scalar aggregate on a grouped relation.
   *
   * It used to answer with the first group's value — a single number that
   * looks exactly like a total and is not one. Rails answers a hash here;
   * TypeScript would have to type that as a union of a number and a map, so
   * the grouped answer has its own method and this says which.
   */
  #refuseGrouped(called: string, instead: string): void {
    if (this.#groups.length === 0) return;

    throw new Error(
      `${called}() on a relation grouped by ${this.#groups.join(", ")} would answer for one group. Use ${instead} for a value per group.`,
    );
  }

  /**
   * One number, with limit and offset honoured.
   *
   * Wrapped in a subquery when either is set, because `LIMIT 2` beside
   * `COUNT(*)` limits the rows the count comes back in rather than the rows
   * being counted — so `limit(2).count()` answered with every row. Rails
   * wraps it for the same reason.
   */
  async #scalar(expression: string, alias: string, bounded_expression?: string): Promise<unknown> {
    // Distinct joins the list too: replacing the select list with COUNT(*)
    // throws away both the DISTINCT and the columns it applied to, so
    // `select(a, b).distinct().count()` counted every row. Wrapping keeps the
    // whole query intact and counts what came out of it.
    const bounded =
      this.#limit !== undefined || this.#offset !== undefined || this.#distinct === true;

    const relation = this.#clone();

    // An order costs a sort and changes nothing about a total — unless a limit
    // is present, in which case it decides *which* rows the limit keeps, and
    // dropping it makes `order(desc).limit(1).sum()` answer for whichever row
    // the database happened to return first.
    if (!bounded) relation.#orders = [];

    if (!bounded) {
      relation.#limit = undefined;
      relation.#offset = undefined;

      const { sql, bindings } = relation.toSql();
      const rows = await this.connection.query<Row>(
        sql.replace(
          /^SELECT .*? FROM/,
          `SELECT ${expression} AS ${this.connection.quote(alias)} FROM`,
        ),
        bindings,
      );

      return rows[0]?.[alias];
    }

    const { sql, bindings } = relation.toSql();

    // Inside the wrapper the rows come from a subquery with its own name, so a
    // column qualified by the table no longer resolves — `items.price` is not
    // a column of `bounded`. The caller supplies the unqualified form.
    const rows = await this.connection.query<Row>(
      `SELECT ${bounded_expression ?? expression} AS ${this.connection.quote(alias)} FROM (${sql}) AS ${this.connection.quote("bounded")}`,
      bindings,
    );

    return rows[0]?.[alias];
  }

  /**
   * A value per group. Rails' `Model.group(:kind).count`.
   *
   * Keyed by the group's value, in the order the database returns them — which
   * is the order the relation asked for when it asked for one.
   */
  async countByGroup(): Promise<Map<unknown, number>> {
    // Never null: a group exists because a row is in it.
    return (await this.#grouped(`COUNT(*)`)) as Map<unknown, number>;
  }

  /** Zero rather than null for an empty sum, as Rails' `sum` answers. */
  async sumByGroup(column: string): Promise<Map<unknown, number>> {
    const answer = await this.#grouped(`SUM(${this.#quoteColumn(column)})`);

    for (const [key, value] of answer) if (value === null) answer.set(key, 0);

    return answer as Map<unknown, number>;
  }

  async averageByGroup(column: string): Promise<Map<unknown, number | null>> {
    return await this.#grouped(`AVG(${this.#quoteColumn(column)})`);
  }

  async minimumByGroup(column: string): Promise<Map<unknown, number | null>> {
    return await this.#grouped(`MIN(${this.#quoteColumn(column)})`);
  }

  async maximumByGroup(column: string): Promise<Map<unknown, number | null>> {
    return await this.#grouped(`MAX(${this.#quoteColumn(column)})`);
  }

  /** Runs an aggregate and keys it by the grouped columns. */
  async #grouped(expression: string): Promise<Map<unknown, number | null>> {
    const answer = new Map<unknown, number | null>();
    if (this.#none) return answer;

    if (this.#groups.length === 0) {
      throw new Error("Nothing is grouped. Call group() before asking for a value per group.");
    }

    const keys = this.#groups.map((column) => this.#quoteColumn(column));

    const { sql, bindings } = this.toSql();
    const selected = sql.replace(
      /^SELECT .*? FROM/,
      `SELECT ${keys.join(", ")}, ${expression} AS ${this.connection.quote("value")} FROM`,
    );

    for (const row of await this.connection.query<Row>(selected, bindings)) {
      const parts = this.#groups.map((column) => row[column.split(".").pop() as string]);
      // One grouped column keys by the value; several key by the tuple, which
      // is what Rails does and the only thing a Map can hold on to.
      const key = parts.length === 1 ? parts[0] : JSON.stringify(parts);
      const value = row.value;

      answer.set(key, value === null || value === undefined ? null : Number(value));
    }

    return answer;
  }

  /**
   * Runs an aggregate over the current conditions.
   *
   * Rails spells these sum/average/minimum/maximum. They ignore order, limit
   * and offset, which would otherwise change the answer rather than the rows.
   */
  async #aggregate(fn: string, column: string): Promise<number | null> {
    if (this.#none) return null;

    this.#refuseGrouped(fn.toLowerCase(), `${fn.toLowerCase()}ByGroup("${column}")`);

    const value = await this.#scalar(
      `${fn}(${this.#quoteColumn(column)})`,
      "value",
      `${fn}(${this.connection.quote(column.split(".").pop() as string)})`,
    );

    return value === null || value === undefined ? null : Number(value);
  }

  async sum(column: string): Promise<number> {
    return (await this.#aggregate("SUM", column)) ?? 0;
  }

  async average(column: string): Promise<number | null> {
    return await this.#aggregate("AVG", column);
  }

  async minimum(column: string): Promise<number | null> {
    return await this.#aggregate("MIN", column);
  }

  async maximum(column: string): Promise<number | null> {
    return await this.#aggregate("MAX", column);
  }

  /**
   * One aggregate, named at run time. Rails' `calculate`.
   *
   * For where the operation is data rather than code — a report whose column
   * and function both come from a saved definition. Written by hand,
   * `sum("price")` says more than `calculate("sum", "price")` and should be
   * preferred; this exists so that a caller holding the operation in a
   * variable does not have to write the switch itself.
   *
   * `count` answers zero for no rows, as counting does. The others answer null,
   * because the average of nothing is not zero.
   */
  async calculate(operation: CalculationName, column?: string): Promise<number | null> {
    // COUNT(column) counts the rows where it is not null, which is the whole
    // difference from COUNT(*) and the reason Rails takes a column here.
    if (operation === "count") {
      return column ? ((await this.#aggregate("COUNT", column)) ?? 0) : await this.count();
    }

    if (!column) throw new Error(`calculate("${operation}") needs a column`);

    switch (operation) {
      case "sum":
        return await this.sum(column);
      case "average":
        return await this.average(column);
      case "minimum":
        return await this.minimum(column);
      case "maximum":
        return await this.maximum(column);
    }
  }

  /**
   * The attributes a record built from this relation starts with.
   *
   * Every equality condition, which for an association is the foreign key and
   * for `where(published: 1)` is the flag. Rails does the same, and it is what
   * makes `author.books.create(title)` link the book without being told to.
   */
  /**
   * The equality conditions as an object. Rails' `where_values_hash`.
   *
   * The public form of the seed a `build` starts from, so a caller can ask
   * what a relation implies about a new record without building one — which is
   * what a form needs to prefill a hidden field.
   */
  whereValues(): Record<string, unknown> {
    return this.#seed();
  }

  #seed(): Record<string, unknown> {
    const seed: Record<string, unknown> = {};

    for (const clause of this.#wheres) {
      if (clause.column !== undefined && "value" in clause) seed[clause.column] = clause.value;
    }

    return seed;
  }

  /**
   * A new record carrying this relation's conditions. Rails' `build`/`new`.
   *
   *     const book = author.books().build({ title: "One" })
   *     book.author_id  // already set
   */
  build(values: Partial<T> = {}): T {
    if (!this.#source.build) {
      throw new Error("This relation's source cannot build records.");
    }

    return this.#source.build({ ...this.#seed(), ...values });
  }

  /** The same, saved. Rails' `create`. */
  async create(values: Partial<T> = {}): Promise<T> {
    const record = this.build(values);

    await (record as unknown as { save(): Promise<boolean> }).save();

    return record;
  }

  /**
   * Links records that already exist. Rails' `collection <<`.
   *
   * Written one at a time rather than in a single UPDATE: each record's own
   * callbacks and validations are the reason a caller reaches for this instead
   * of `updateAll`.
   */
  async push(...records: T[]): Promise<T[]> {
    const seed = this.#seed();

    for (const record of records) {
      Object.assign(record as object, seed);
      await (record as unknown as { save(): Promise<boolean> }).save();
    }

    return records;
  }

  /**
   * Unlinks records from this collection. Rails' `collection.delete`.
   *
   * Unlinked rather than deleted: the record stays, its foreign key is
   * cleared, and it belongs to nobody. That is what Rails does for a `has_many`
   * without `dependent: :destroy`, and the distinction is the whole reason
   * both methods exist — removing a book from an author should not usually
   * burn the book.
   */
  async unlink(...records: T[]): Promise<T[]> {
    const seed = this.#seed();

    for (const record of records) {
      const cleared = Object.fromEntries(Object.keys(seed).map((column) => [column, null]));

      await (
        record as unknown as { updateColumns(values: object): Promise<boolean> }
      ).updateColumns(cleared);
    }

    return records;
  }

  /**
   * Destroys records in this collection. Rails' `collection.destroy`.
   *
   * One at a time, because each record's own callbacks are what separate this
   * from `deleteAll` — a destroyed comment should still take its attachments
   * with it.
   */
  async destroy(...records: T[]): Promise<T[]> {
    for (const record of records) {
      await (record as unknown as { destroy(): Promise<boolean> }).destroy();
    }

    return records;
  }

  /** How many, as Rails' `size` on a collection. */
  async size(): Promise<number> {
    return await this.count();
  }

  /** Whether there are none. Rails' `empty?`. */
  async isEmpty(): Promise<boolean> {
    return !(await this.exists());
  }

  /**
   * Every row this relation would not have matched. Rails' `invert_where`.
   *
   * Every condition inverted together rather than each one separately: the
   * opposite of "draft and mine" is "not (draft and mine)", which includes
   * somebody else's draft. Inverting them one at a time gives "published and
   * not mine", which is a different and much smaller set.
   */
  invertWhere(): Relation<T> {
    const next = this.#clone();

    if (next.#wheres.length === 0) return next;

    const inner = next.#wheres.map((clause) => `(${clause.sql})`).join(" AND ");

    const bindings = next.#wheres.flatMap((clause) => clause.bindings);

    next.#wheres = [{ sql: `NOT (${inner})`, bindings }];

    return next;
  }

  /**
   * Adds methods to this relation and everything chained off it. Rails'
   * `extending`.
   *
   *     Post.all().extending({ published() { return this.where({ live: 1 }) } })
   *
   * For a query vocabulary that belongs to one call site rather than to the
   * model — a report, an export — without a scope nobody else will ever use.
   */
  extending<E extends object>(methods: E): Relation<T> & E {
    const next = this.#clone();

    return Object.assign(next, methods) as Relation<T> & E;
  }

  /** Replaces the select list rather than adding to it. Rails' `reselect`. */
  reselect(...columns: string[]): Relation<T> {
    const next = this.#clone();
    next.#selects = [];

    return next.select(...columns);
  }

  /** Replaces the grouping rather than adding to it. Rails' `regroup`. */
  regroup(...columns: string[]): Relation<T> {
    const next = this.#clone();
    next.#groups = [];

    return next.group(...columns);
  }

  /**
   * Everything but these records. Rails' `excluding`.
   *
   * Takes the records themselves rather than their ids, because that is what
   * the caller has: "everything except the one I am showing".
   */
  excluding(...records: (T | number | string)[]): Relation<T> {
    const ids = records
      .flat()
      .map((one) =>
        typeof one === "object" && one !== null
          ? (one as Record<string, unknown>)[this.#source.primaryKey]
          : one,
      );

    return ids.length === 0 ? this.#clone() : this.whereNot({ [this.#source.primaryKey]: ids });
  }

  async exists(): Promise<boolean> {
    return (await this.limit(1).toArray()).length > 0;
  }

  /**
   * A relation that matches nothing, and does not ask the database.
   *
   * Rails' `none`. What it is for is returning a relation from a method that
   * has decided there is nothing to return — an authorisation check, a guard
   * clause — without the caller having to know. It stays chainable, so
   * `visible().where(...).order(...)` keeps working and still runs no query.
   *
   * `where({ id: null })` is the usual stand-in and is not the same thing: it
   * runs a query, and it stops being empty the moment somebody chains an `or`
   * onto it.
   */
  none(): Relation<T> {
    const next = this.#clone();
    next.#none = true;
    return next;
  }

  /**
   * Replaces the ordering instead of adding to it. Rails' `reorder`.
   *
   * `order` appends, which is right when a caller is refining — and wrong when
   * one is overriding. An association or a default scope that already ordered
   * leaves its column first, so a later `order` only breaks ties and the
   * caller's intent quietly does nothing.
   */
  reorder(column: string, direction: Direction = "asc"): Relation<T> {
    const next = this.#clone();
    next.#orders = [{ column, direction }];
    return next;
  }

  /**
   * Replaces the conditions on the named columns. Rails' `rewhere`.
   *
   * `where` conjoins, so narrowing a relation that already has a condition on
   * the same column gives `status = 'draft' AND status = 'published'` — which
   * matches nothing and reads like it should match something.
   */
  rewhere(conditions: Conditions): Relation<T> {
    const columns = new Set(Object.keys(conditions));
    const next = this.#clone();

    // Only the object-form conditions can be matched by column; a string
    // condition is opaque, so it is left alone rather than guessed at.
    next.#wheres = next.#wheres.filter(
      (clause) => !(clause.column !== undefined && columns.has(clause.column)),
    );

    return next.where(conditions);
  }

  /**
   * Drops whole clauses. Rails' `unscope`.
   *
   *     Post.published().unscope("order", "limit")
   *
   * For undoing what a scope or an association put there, which is the only
   * way to get out from under a default that does not suit one caller.
   */
  unscope(...clauses: RelationClause[]): Relation<T> {
    const next = this.#clone();

    for (const clause of clauses) {
      // Rails raises here too. An unrecognised clause used to be ignored, so
      // `unscope("wheres")` — a plural away from the right word — left the
      // conditions in place and said it had removed them.
      if (!ALL_CLAUSES.includes(clause)) {
        throw new Error(
          `Unknown clause "${String(clause)}". Expected one of: ${ALL_CLAUSES.join(", ")}.`,
        );
      }

      next.#clear(clause);
    }

    return next;
  }

  /** Keeps only the named clauses, dropping the rest. Rails' `only`. */
  only(...clauses: RelationClause[]): Relation<T> {
    const next = this.#clone();
    const kept = new Set(clauses);

    for (const clause of ALL_CLAUSES) {
      if (!kept.has(clause)) next.#clear(clause);
    }

    return next;
  }

  /** Drops the named clauses, keeping the rest. Rails' `except`. */
  except(...clauses: RelationClause[]): Relation<T> {
    return this.unscope(...clauses);
  }

  /**
   * Empties one clause.
   *
   * A method rather than a module function: `#private` fields are reachable
   * only from inside the class that declares them.
   */
  #clear(clause: RelationClause): void {
    switch (clause) {
      case "where":
        this.#wheres = [];
        return;
      case "order":
        this.#orders = [];
        return;
      case "limit":
        this.#limit = undefined;
        return;
      case "offset":
        this.#offset = undefined;
        return;
      case "select":
        this.#selects = undefined;
        return;
      case "includes":
        this.#includes = [];
        return;
      case "group":
        this.#groups = [];
        return;
      case "having":
        this.#havings = [];
        return;
      case "distinct":
        this.#distinct = false;
        return;
      case "lock":
        this.#lock = undefined;
        return;
      case "joins":
        this.#joins = [];
        return;
    }
  }

  /** Whether this relation was emptied by `none`. */
  get isNone(): boolean {
    return this.#none;
  }

  /**
   * The first record, in no particular order. Rails' `take`.
   *
   * `first` orders by the primary key so the answer is stable; this does not,
   * which is what makes it the cheaper call when any row will do.
   */
  async take(): Promise<T | null> {
    return (await this.limit(1).toArray())[0] ?? null;
  }

  /** The primary keys of everything matching. Rails' `ids`. */
  async ids(): Promise<unknown[]> {
    return await this.pluck(this.#source.primaryKey);
  }

  /** Whether anything matches. Rails' `any?`. */
  async any(): Promise<boolean> {
    return await this.exists();
  }

  /**
   * Whether more than one thing matches. Rails' `many?`.
   *
   * Two rows fetched rather than a count, for the same reason `sole` does it:
   * the question is "more than one", and counting a million rows to learn
   * there are at least two is work nobody asked for.
   */
  async many(): Promise<boolean> {
    return (await this.limit(2).toArray()).length > 1;
  }

  /**
   * Loads each record and destroys it. Rails' `destroy_all`.
   *
   * Unlike `deleteAll`, which is one statement and skips everything: this runs
   * callbacks and dependent options, which is the difference between removing
   * rows and removing records. Slower on purpose.
   */
  async destroyAll(): Promise<number> {
    const records = await this.toArray();

    for (const record of records) {
      await (record as unknown as { destroy(): Promise<boolean> }).destroy();
    }

    return records.length;
  }

  /** One column's values. Rails' `pluck`. */
  /** One row's worth of columns, or null. Rails' `pick`. */
  async pick(column: string): Promise<unknown>;
  /** Several columns from one row. */
  async pick(...columns: string[]): Promise<unknown[] | null>;
  /**
   * The first row's values, or null when there is no row. Rails' `pick`.
   *
   *     const title = await Post.where({ id }).pick("title")
   *
   * `pluck(...)[0]` reads the same and is not the same: it selects every
   * matching row and throws all but one away. On a table of any size that is
   * the difference between reading one row and reading the table.
   *
   * Null rather than undefined for a missing row, matching `first`, so the two
   * can be checked the same way.
   */
  async pick(...columns: string[]): Promise<unknown> {
    if (columns.length === 0) throw new Error("pick needs at least one column.");

    const rows = (await this.limit(1).pluck(...(columns as [string]))) as unknown[];

    if (rows.length === 0) return null;

    return rows[0];
  }

  async pluck(column: string): Promise<unknown[]>;
  /** Several columns, as a row of values each. */
  async pluck(...columns: string[]): Promise<unknown[][]>;
  async pluck(...columns: string[]): Promise<unknown[] | unknown[][]> {
    if (this.#none) return [];

    // Resolved once and reused for both the query and the read-back, or a
    // plucked alias would select the right column and then look for the wrong
    // key in the row.
    const resolved = columns.map((column) => this.#resolve(column));

    const { sql, bindings } = this.select(...resolved).toSql();
    const raw = await this.connection.query<Row>(sql, bindings);

    // Cast, so plucked values agree with the same values read off a record.
    const rows = this.#source.castRow ? raw.map((row) => this.#source.castRow!(row)) : raw;

    if (resolved.length === 1) return rows.map((row) => row[resolved[0] as string]);
    return rows.map((row) => resolved.map((column) => row[column]));
  }

  /**
   * Iterates in batches, a record at a time. Rails' `find_each`.
   *
   *     for await (const post of Post.where({ draft: true }).findEach()) { … }
   *
   * The point is not to hold a million rows in memory at once. The other
   * point, less obvious and more important, is the cursor: batches walk
   * `WHERE id > last_seen` rather than counting with OFFSET.
   *
   * OFFSET is wrong twice over. The database scans and discards every row it
   * skips, so walking a large table is quadratic; and if the block deletes or
   * inserts anything, the offsets shift underneath the walk and records are
   * silently skipped. A queue drained with `destroy` inside the loop misses
   * half its rows — which is exactly what a batching helper is for.
   */
  async *findEach(options: BatchOptions = {}): AsyncGenerator<T> {
    for await (const batch of this.findInBatches(options)) {
      for (const record of batch) yield record;
    }
  }

  /** Rails' `find_in_batches`: an array at a time. */
  async *findInBatches(options: BatchOptions = {}): AsyncGenerator<T[]> {
    for await (const batch of this.inBatches(options)) {
      const records = await batch.relation.toArray();
      if (records.length > 0) yield records;
    }
  }

  /**
   * Rails' `in_batches`: a relation at a time.
   *
   * What makes bulk work possible without instantiating anything —
   * `batch.relation.updateAll(...)` keeps a long update off one lock.
   *
   * A `Batch` rather than the relation itself, because a relation is a
   * thenable and an async generator awaits whatever it yields: yielding one
   * directly would hand the caller a loaded array and quietly undo the point
   * of the method.
   */
  async *inBatches(options: BatchOptions = {}): AsyncGenerator<Batch<T>> {
    const size = options.batchSize ?? 1000;
    const direction = options.order ?? "asc";
    const key = this.#source.primaryKey;

    if (size < 1) throw new Error(`batchSize must be at least 1, got ${size}.`);

    // Rails ignores an order here and logs a warning. Ignoring the order
    // somebody wrote is a worse outcome than saying so: the walk has to be
    // ordered by the key it pages on, and a relation that quietly came back in
    // a different order than asked for is a bug found much later.
    if (this.#orders.length > 0) {
      throw new Error(
        `Cannot batch an ordered relation: batching walks the ${key} to page with a cursor. ` +
          `Drop the order, or load the records with toArray().`,
      );
    }

    if (this.#selects && !this.#selects.includes(key)) {
      throw new Error(`Batching needs ${key} in the select, since it is what the cursor reads.`);
    }

    const after = direction === "asc" ? ">" : "<";
    const before = direction === "asc" ? "<=" : ">=";

    let scope = this.order(key, direction);
    if (options.start !== undefined) {
      scope = scope.where(
        `${this.#quoteColumn(key)} ${direction === "asc" ? ">=" : "<="} ?`,
        options.start,
      );
    }
    if (options.finish !== undefined) {
      scope = scope.where(`${this.#quoteColumn(key)} ${before} ?`, options.finish);
    }

    // A limit on the relation is a limit on the whole walk, not on each batch.
    let remaining = this.#limit;
    let cursor: unknown;

    for (;;) {
      const take = remaining === undefined ? size : Math.min(size, remaining);
      if (take <= 0) return;

      let batch = scope.limit(take);
      if (cursor !== undefined) {
        batch = batch.where(`${this.#quoteColumn(key)} ${after} ?`, cursor);
      }

      const keys = (await batch.pluck(key)) as unknown[];
      if (keys.length === 0) return;

      cursor = keys.at(-1);
      if (remaining !== undefined) remaining -= keys.length;

      // Yielded as a relation over the keys just read, so the caller can add
      // `includes` or run `updateAll` against exactly this batch.
      // Ordered the same way the walk is: without this the batch comes back in
      // whatever order the database felt like, so a descending walk delivered
      // its batches backwards but each batch's contents forwards.
      yield {
        keys,
        relation: this.unordered()
          .where({ [key]: keys })
          .order(key, direction),
      };

      if (keys.length < take) return;
    }
  }

  /** @internal A copy with no order, limit or offset. */
  unordered(): Relation<T> {
    const next = this.#clone();
    next.#orders = [];
    next.#limit = undefined;
    next.#offset = undefined;
    return next;
  }

  /** Rails' `find_each`, under the name this had before batching was fixed. */
  each(batchSize = 1000): AsyncGenerator<T> {
    return this.findEach({ batchSize });
  }

  /** The WHERE clause and its bindings, shared by update and delete. */
  #whereClause(): { sql: string; bindings: unknown[] } {
    const bindings: unknown[] = [];
    if (this.#wheres.length === 0) return { sql: "", bindings };

    const clauses = this.#wheres.map((clause) => {
      bindings.push(...clause.bindings);
      return bracketed(clause.sql);
    });
    return { sql: ` WHERE ${clauses.join(" AND ")}`, bindings };
  }

  #assertColumn(column: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) {
      throw new Error(`Invalid column name: ${column}`);
    }
    return column;
  }

  /**
   * Updates every matching row in one statement.
   *
   * Rails' `update_all`: no callbacks, no validations, no instantiation. Fast,
   * and deliberately blunt — the name is the warning.
   */
  async updateAll(values: Record<string, unknown>): Promise<void> {
    checkWritable("update");
    const entries = Object.entries(values);
    if (entries.length === 0) return;

    const where = this.#whereClause();
    const assignments = entries
      .map(([column]) => `${this.connection.quote(this.#assertColumn(column))} = ?`)
      .join(", ");

    const statement = `UPDATE ${this.connection.quote(this.#source.tableName)} SET ${assignments}${where.sql}`;

    // Serialized the same way a single save serializes. Without this a Date
    // reaches the driver as an object and is refused outright — so
    // `updateAll({ published_at: new Date() })`, which is the obvious use for
    // a bulk update, threw.
    await this.connection.execute(this.#renumber(statement), [
      ...entries.map(([, value]) => serialize(value, this.connection)),
      ...where.bindings,
    ]);
  }

  /**
   * Moves every matching row's timestamps. Rails' `touch_all`.
   *
   *     await Post.where({ author_id: id }).touchAll()
   *     await Post.all().touchAll("reviewed_at")
   *
   * One statement, no callbacks, no records loaded. What a bulk import reaches
   * for: touching each record individually is a query per row, and the point
   * of a timestamp column is usually to invalidate a cache, which does not
   * care how it moved.
   *
   * `updated_at` always, plus whatever else is named — because a caller asking
   * for `reviewed_at` almost never means "and leave `updated_at` where it is",
   * and Rails reads the same way.
   */
  async touchAll(...columns: string[]): Promise<number> {
    checkWritable("update");

    const now = new Date();
    const names = ["updated_at", ...columns.filter((column) => column !== "updated_at")];

    const where = this.#whereClause();
    const assignments = names
      .map((column) => `${this.connection.quote(this.#assertColumn(column))} = ?`)
      .join(", ");

    const statement = `UPDATE ${this.connection.quote(this.#source.tableName)} SET ${assignments}${where.sql}`;

    return await this.connection.executeCount(this.#renumber(statement), [
      ...names.map(() => serialize(now, this.connection)),
      ...where.bindings,
    ]);
  }

  /**
   * Deletes every matching row in one statement, and answers how many.
   *
   * The count is Rails' — `delete_all` returns it — and it is the only way a
   * caller can tell "deleted nothing because nothing matched" from "deleted
   * nothing because the conditions were wrong". This returned void, so it
   * could not.
   */
  async deleteAll(): Promise<number> {
    if (this.#none) return 0;

    checkWritable("delete");
    const where = this.#whereClause();
    const statement = `DELETE FROM ${this.connection.quote(this.#source.tableName)}${where.sql}`;

    return await this.connection.executeCount(this.#renumber(statement), where.bindings);
  }
}
