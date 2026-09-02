/**
 * The relational algebra a relation compiles into, ported from
 * `activerecord/test/cases/relation/where_clause_test.rb`,
 * `activerecord/test/cases/relation/merging_test.rb` and the inversion cases in
 * `activerecord/test/cases/relation/where_test.rb`.
 *
 * The tree exists because three operations are impossible over SQL text —
 * removing a condition, merging two, and inverting one — and each failure is
 * silent, so the cases are all about the wrong answer that still runs.
 */

import { describe, expect, it } from "bun:test";
import {
  type ArelNode,
  addBack,
  andNodes,
  appliedTo,
  arel,
  arelColumns,
  arelTable,
  branches,
  clauseToSql,
  exceptAttributes,
  invertClause,
  invertNode,
  makeTree,
  mergeClauses,
  orNodes,
  predicateBuilder,
  predicateFor,
  resolveArelAttribute,
  toSql,
  walkTree,
  whereClauses,
  whereHash,
} from "../src/arel.js";

const posts = arelTable("posts");

describe("naming a column", () => {
  /**
   * A bare column name in a join where both tables have `id` is ambiguous, and
   * the database says so only sometimes — so the failure appears when somebody
   * adds a join months later.
   */
  it("carries the table", () => {
    expect(arel(posts, "title")).toEqual({ table: posts, name: "title" });
  });

  it("names several at once", () => {
    expect(arelColumns(posts, ["id", "title"]).map((each) => each.name)).toEqual(["id", "title"]);
  });

  it("reads a qualified reference", () => {
    expect(resolveArelAttribute("comments.body", posts)).toEqual({
      table: { name: "comments" },
      name: "body",
    });
  });

  /** Guessing a table from a column would pick whichever registered first. */
  it("takes the given table for an unqualified one", () => {
    expect(resolveArelAttribute("title", posts).table).toBe(posts);
  });

  it("carries an alias where there is one", () => {
    const aliased = arelTable("posts", "p");

    expect(toSql(predicateFor(arel(aliased, "id"), 1)).sql).toContain('"p"."id"');
  });
});

describe("choosing an operator", () => {
  /**
   * `=` for every shape produces `id = NULL`, which is never true — so a query
   * looking for records with no author silently returns none.
   */
  it("comes from the value's shape", () => {
    expect(predicateFor(arel(posts, "id"), 1)).toMatchObject({ operator: "=" });
    expect(predicateFor(arel(posts, "id"), [1, 2])).toMatchObject({ operator: "IN" });
    expect(predicateFor(arel(posts, "id"), null)).toMatchObject({ operator: "IS NULL" });
    expect(predicateFor(arel(posts, "id"), undefined)).toMatchObject({ operator: "IS NULL" });
    expect(predicateFor(arel(posts, "id"), { begin: 1, end: 5 })).toMatchObject({
      operator: "BETWEEN",
    });
  });

  /**
   * `IN ()` is a syntax error on most servers and matches everything on one,
   * so an empty list is a contradiction instead.
   */
  it("makes an empty list a contradiction", () => {
    expect(toSql(predicateFor(arel(posts, "id"), [])).sql).toBe("1=0");
  });

  /**
   * Joined with OR, `where(a: 1, b: 2)` would mean "either" — which produces
   * more rows rather than fewer, so nothing fails and there are just extra
   * records.
   */
  it("joins several conditions with AND", () => {
    expect(predicateBuilder(posts, { a: 1, b: 2 })).toMatchObject({ kind: "and" });
  });

  it("does not wrap a single condition", () => {
    expect(predicateBuilder(posts, { a: 1 })).toMatchObject({ kind: "comparison" });
  });

  /**
   * The caller's array is copied. A relation built from a list the caller then
   * appends to would change underneath every other relation built from it, and
   * a scope is one relation reused by every caller.
   */
  it("copies the list it is given", () => {
    const nodes = [predicateFor(arel(posts, "a"), 1), predicateFor(arel(posts, "b"), 2)];
    const joined = andNodes(nodes) as ArelNode;
    const either = orNodes(nodes) as ArelNode;
    const clause = whereClauses(nodes);
    nodes.push(predicateFor(arel(posts, "c"), 3));

    expect(branches(joined)).toHaveLength(2);
    expect(branches(either)).toHaveLength(2);
    expect(clause.predicates).toHaveLength(2);
  });

  it("builds nothing from nothing", () => {
    expect(predicateBuilder(posts, {})).toBeUndefined();
    expect(andNodes([])).toBeUndefined();
    expect(orNodes([])).toBeUndefined();
  });
});

describe("merging two clauses", () => {
  /**
   * Keeping both gives `a = 1 AND a = 2`, which matches nothing — and no rows
   * is a normal answer, so nothing reports it.
   */
  it("replaces a condition on the same attribute", () => {
    const merged = mergeClauses(
      whereClauses([predicateFor(arel(posts, "a"), 1)]),
      whereClauses([predicateFor(arel(posts, "a"), 2)]),
    );

    expect(merged.predicates).toHaveLength(1);
    expect(whereHash(merged)).toEqual({ a: 2 });
  });

  it("keeps conditions on other attributes", () => {
    const merged = mergeClauses(
      whereClauses([predicateFor(arel(posts, "a"), 1), predicateFor(arel(posts, "b"), 1)]),
      whereClauses([predicateFor(arel(posts, "a"), 2)]),
    );

    expect(whereHash(merged)).toEqual({ b: 1, a: 2 });
    // This relation's own conditions first, then what was merged onto it — the
    // order the binds reach the driver, and the order the query reads in a log.
    expect(clauseToSql(merged).binds).toEqual([1, 2]);
  });

  /** A condition on `posts.a` and one on `comments.a` are different conditions. */
  it("keeps conditions on the same name in different tables", () => {
    const merged = mergeClauses(
      whereClauses([predicateFor(arel(arelTable("comments"), "a"), 1)]),
      whereClauses([predicateFor(arel(posts, "a"), 2)]),
    );

    expect(merged.predicates).toHaveLength(2);
  });

  it("keeps raw SQL, which it cannot compare", () => {
    const raw: ArelNode = { kind: "sql", sql: "a > 1", binds: [] };
    const merged = mergeClauses(
      whereClauses([raw]),
      whereClauses([predicateFor(arel(posts, "a"), 2)]),
    );

    expect(merged.predicates).toHaveLength(2);
  });
});

describe("the hash form of a clause", () => {
  /**
   * Only simple equality: inventing a hash form for a range or a negation
   * would let a caller read a condition back as something that does not mean
   * the same thing.
   */
  it("leaves out anything that is not plain equality", () => {
    const clause = whereClauses([
      predicateFor(arel(posts, "a"), 1),
      predicateFor(arel(posts, "b"), [1, 2]),
      predicateFor(arel(posts, "c"), null),
    ]);

    expect(whereHash(clause)).toEqual({ a: 1 });
  });
});

describe("removing a condition", () => {
  /**
   * Over a tree rather than SQL text: parsing what the application generated
   * removes the wrong condition when the parse is not exactly right.
   */
  it("drops the named attributes and keeps the rest", () => {
    const clause = whereClauses([
      predicateFor(arel(posts, "draft"), true),
      predicateFor(arel(posts, "author_id"), 1),
    ]);

    expect(whereHash(exceptAttributes(clause, ["draft"]))).toEqual({ author_id: 1 });
  });

  it("keeps raw SQL it cannot inspect", () => {
    const clause = whereClauses([{ kind: "sql", sql: "a > 1", binds: [] }]);

    expect(exceptAttributes(clause, ["a"]).predicates).toHaveLength(1);
  });
});

describe("inverting a condition", () => {
  it("flips a comparison", () => {
    expect(invertNode(predicateFor(arel(posts, "a"), 1))).toMatchObject({ operator: "!=" });
    expect(invertNode(predicateFor(arel(posts, "a"), null))).toMatchObject({
      operator: "IS NOT NULL",
    });
    expect(invertNode(predicateFor(arel(posts, "a"), [1]))).toMatchObject({ operator: "NOT IN" });
  });

  it("flips the ordering comparisons", () => {
    const less: ArelNode = {
      kind: "comparison",
      attribute: arel(posts, "a"),
      operator: "<",
      value: 1,
    };

    expect(invertNode(less)).toMatchObject({ operator: ">=" });
  });

  /**
   * De Morgan's law: negating each part and keeping the AND gives a *narrower*
   * query — it runs, returns rows, and returns the wrong ones.
   */
  it("turns an AND into an OR", () => {
    const clause = whereClauses([
      predicateFor(arel(posts, "a"), 1),
      predicateFor(arel(posts, "b"), 2),
    ]);

    expect(invertClause(clause).predicates[0]).toMatchObject({ kind: "or" });
  });

  it("turns an OR into an AND", () => {
    const either = orNodes([
      predicateFor(arel(posts, "a"), 1),
      predicateFor(arel(posts, "b"), 2),
    ]) as ArelNode;

    expect(invertNode(either)).toMatchObject({ kind: "and" });
  });

  it("cancels a double negation", () => {
    const one = predicateFor(arel(posts, "a"), 1);

    expect(invertNode({ kind: "not", child: one })).toBe(one);
  });

  /**
   * Raw SQL is wrapped rather than rewritten: rewriting means parsing a
   * fragment the application wrote, which is the one thing here that cannot be
   * assumed simple.
   */
  it("wraps raw SQL", () => {
    expect(invertNode({ kind: "sql", sql: "a > 1", binds: [] })).toMatchObject({ kind: "not" });
  });

  it("inverts an empty clause into itself", () => {
    expect(invertClause(whereClauses()).predicates).toEqual([]);
  });
});

describe("walking a tree", () => {
  const tree = andNodes([
    predicateFor(arel(posts, "a"), 1),
    orNodes([predicateFor(arel(posts, "b"), 2), predicateFor(arel(posts, "c"), 3)]) as ArelNode,
  ]) as ArelNode;

  /**
   * Parents first, because the usual question is "does this contain X" and an
   * answer near the root stops the walk.
   */
  it("visits parents before children", () => {
    expect(walkTree(tree)[0]).toBe(tree);
    expect(walkTree(tree).map((each) => each.kind)).toEqual([
      "and",
      "comparison",
      "or",
      "comparison",
      "comparison",
    ]);
  });

  it("names a node's children", () => {
    expect(branches(tree)).toHaveLength(2);
    expect(branches(predicateFor(arel(posts, "a"), 1))).toEqual([]);
    expect(branches({ kind: "not", child: tree })).toEqual([tree]);
  });

  /**
   * `a AND (b AND c)` and `(a AND b) AND c` mean the same thing, and leaving
   * them different shapes makes every later comparison depend on how the
   * conditions happened to be written.
   */
  it("flattens a nested join of the same kind", () => {
    const nested = makeTree(
      [
        predicateFor(arel(posts, "a"), 1),
        andNodes([
          predicateFor(arel(posts, "b"), 2),
          predicateFor(arel(posts, "c"), 3),
        ]) as ArelNode,
      ],
      "and",
    );

    expect(branches(nested as ArelNode)).toHaveLength(3);
  });

  it("joins with the kind it was asked for", () => {
    const either = makeTree(
      [predicateFor(arel(posts, "a"), 1), predicateFor(arel(posts, "b"), 2)],
      "or",
    );

    expect(either).toMatchObject({ kind: "or" });
  });

  it("does not flatten a different kind", () => {
    const mixed = makeTree(
      [
        predicateFor(arel(posts, "a"), 1),
        orNodes([predicateFor(arel(posts, "b"), 2), predicateFor(arel(posts, "c"), 3)]) as ArelNode,
      ],
      "and",
    );

    expect(branches(mixed as ArelNode)).toHaveLength(2);
  });

  /**
   * A scope is one relation reused by every caller, so mutating the tree would
   * change every relation built from it.
   */
  it("adds a condition without mutating the tree", () => {
    const before = branches(tree).length;
    addBack(tree, predicateFor(arel(posts, "d"), 4));

    expect(branches(tree)).toHaveLength(before);
  });

  it("adds to nothing", () => {
    const one = predicateFor(arel(posts, "a"), 1);

    expect(addBack(undefined, one)).toBe(one);
  });

  /**
   * What a merge and a default scope both need: a default `where` on top of
   * one a caller wrote should not produce two conditions on one column.
   */
  it("says whether an attribute is already constrained", () => {
    expect(appliedTo(tree, arel(posts, "b"))).toBe(true);
    expect(appliedTo(tree, arel(posts, "z"))).toBe(false);
    expect(appliedTo(undefined, arel(posts, "a"))).toBe(false);
  });
});

describe("rendering", () => {
  /**
   * A tree exists so conditions can be manipulated, and a manipulation that
   * re-interpolated would be the moment a user's value reaches the text.
   */
  it("binds values at every depth", () => {
    const rendered = toSql(
      andNodes([
        predicateFor(arel(posts, "a"), 1),
        predicateFor(arel(posts, "b"), [2, 3]),
      ]) as ArelNode,
    );

    expect(rendered.sql).not.toContain("1");
    expect(rendered.sql).toContain(" AND ");
    expect(rendered.binds).toEqual([1, 2, 3]);
  });

  /**
   * `a OR b AND c` binds as `a OR (b AND c)`, so a tree meaning
   * `(a OR b) AND c` would render as a different query that runs and returns
   * different rows.
   */
  it("parenthesises so precedence cannot change the meaning", () => {
    const tree = makeTree(
      [
        orNodes([predicateFor(arel(posts, "a"), 1), predicateFor(arel(posts, "b"), 2)]) as ArelNode,
        predicateFor(arel(posts, "c"), 3),
      ],
      "and",
    ) as ArelNode;

    expect(toSql(tree).sql).toStartWith("((");
  });

  it("writes a null check with no bind", () => {
    expect(toSql(predicateFor(arel(posts, "a"), null))).toEqual({
      sql: '"posts"."a" IS NULL',
      binds: [],
    });
  });

  it("writes a range as BETWEEN", () => {
    expect(toSql(predicateFor(arel(posts, "a"), { begin: 1, end: 5 }))).toEqual({
      sql: '"posts"."a" BETWEEN ? AND ?',
      binds: [1, 5],
    });
  });

  it("writes a negation", () => {
    expect(toSql(invertNode({ kind: "sql", sql: "a > 1", binds: [] })).sql).toBe("NOT (a > 1)");
  });

  it("renders an empty clause as nothing", () => {
    expect(clauseToSql(whereClauses())).toEqual({ sql: "", binds: [] });
  });

  it("takes a different quoting", () => {
    expect(
      clauseToSql(whereClauses([predicateFor(arel(posts, "a"), 1)]), (n) => `\`${n}\``).sql,
    ).toBe("`posts`.`a` = ?");
  });
});
