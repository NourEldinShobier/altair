/**
 * Turning a tree of association names into joins, ported from
 * `activerecord/test/cases/associations/join_dependency_test.rb`,
 * `activerecord/test/cases/associations/eager_test.rb` and the alias cases in
 * `activerecord/test/cases/relations_test.rb`.
 *
 * Aliasing is where the failures are, and none of them raise: two joins of one
 * table without aliases produce SQL the database accepts and answers from
 * whichever copy it picked. So most of these check the *second* use of a table,
 * not the first.
 */

import { describe, expect, it } from "bun:test";
import {
  AliasTracker,
  type AssociationSpec,
  DEFAULT_ALIAS_LENGTH,
  type JoinNode,
  type JoinReflection,
  UnknownAssociation,
  addChild,
  aliasCandidate,
  applyColumnAliases,
  buildJoinTree,
  checkEagerLoadable,
  columnAlias,
  columnAliases,
  constructJoinDependency,
  eachChildren,
  findReflection,
  joinConstraints,
  joinDepth,
  joinSql,
  tableAliasFor,
} from "../src/join_dependency.js";

const SCHEMA: Record<string, JoinReflection> = {
  author: {
    table: "authors",
    foreignKey: "author_id",
    primaryKey: "id",
    associations: {
      company: { table: "companies", foreignKey: "company_id", primaryKey: "id" },
    },
  },
  editor: {
    table: "authors",
    foreignKey: "editor_id",
    primaryKey: "id",
    associations: {
      company: { table: "companies", foreignKey: "company_id", primaryKey: "id" },
    },
  },
  comments: { table: "comments", foreignKey: "id", primaryKey: "post_id" },
};

describe("handing out table names", () => {
  it("gives the first use the table's own name", () => {
    const tracker = new AliasTracker();

    expect(tracker.aliasedTableFor("companies")).toEqual({
      name: "companies",
      alias: "companies",
    });
  });

  /**
   * The whole point. Without this the statement has two `companies` and the
   * database answers from whichever it picked — no error, wrong rows.
   */
  it("aliases the second use", () => {
    const tracker = new AliasTracker();
    tracker.aliasedTableFor("companies");

    expect(tracker.aliasedTableFor("companies").alias).not.toBe("companies");
  });

  it("keeps the real table name alongside the alias", () => {
    const tracker = new AliasTracker();
    tracker.aliasedTableFor("companies");

    expect(tracker.aliasedTableFor("companies").name).toBe("companies");
  });

  /** A name that says where it came from, rather than `companies_2`. */
  it("names an alias after the association it came through", () => {
    const tracker = new AliasTracker();
    tracker.aliasedTableFor("companies");

    expect(tracker.aliasedTableFor("companies", "editors_companies").alias).toBe(
      "editors_companies",
    );
  });

  it("counts a third use", () => {
    const tracker = new AliasTracker();
    tracker.aliasedTableFor("companies");
    tracker.aliasedTableFor("companies", "editors_companies");

    expect(tracker.aliasedTableFor("companies", "editors_companies").alias).toBe(
      "editors_companies_2",
    );
  });

  /** The same query built twice has to produce the same SQL, or nothing caches. */
  it("is stable across two identical builds", () => {
    const build = () => {
      const tracker = new AliasTracker();
      tracker.aliasedTableFor("companies");

      return tracker.aliasedTableFor("companies", "editors_companies").alias;
    };

    expect(build()).toBe(build());
  });

  it("reports what it has handed out", () => {
    const tracker = new AliasTracker();
    tracker.aliasedTableFor("companies");

    expect(tracker.countFor("companies")).toBe(1);
    expect(tracker.countFor("authors")).toBe(0);
  });

  /** A join the caller wrote by hand already used the name. */
  it("takes a seeded count into account", () => {
    const tracker = new AliasTracker();
    tracker.seed("companies");

    expect(tracker.aliasedTableFor("companies").alias).not.toBe("companies");
  });

  it("forgets everything when cleared", () => {
    const tracker = new AliasTracker();
    tracker.aliasedTableFor("companies");
    tracker.clear();

    expect(tracker.aliasedTableFor("companies").alias).toBe("companies");
  });
});

describe("making a name the adapter will take", () => {
  it("leaves a short one alone", () => {
    expect(tableAliasFor("companies")).toBe("companies");
  });

  /** `public.users` as an alias is a syntax error — it is one identifier. */
  it("replaces the dots in a qualified name", () => {
    expect(tableAliasFor("public.users")).toBe("public_users");
  });

  it("cuts one that is too long", () => {
    expect(tableAliasFor("a".repeat(80)).length).toBe(DEFAULT_ALIAS_LENGTH);
  });

  /**
   * Truncated before the counter goes on. Cutting `_2` off the end is exactly
   * the collision the alias existed to prevent.
   */
  it("leaves room for the counter", () => {
    const tracker = new AliasTracker(10);
    tracker.aliasedTableFor("companies");
    const first = tracker.aliasedTableFor("companies", "a".repeat(40)).alias;
    const second = tracker.aliasedTableFor("companies", "a".repeat(40)).alias;

    expect(second.length).toBeLessThanOrEqual(10);
    expect(second).not.toBe(first);
    expect(second).toEndWith("_2");
  });

  it("builds a candidate from the association and the table", () => {
    expect(aliasCandidate("editor", "companies")).toBe("editor_companies");
  });
});

describe("naming columns", () => {
  it("qualifies a column by whatever the table is called here", () => {
    expect(columnAlias({ name: "companies", alias: "editors_companies" }, "id")).toBe(
      "editors_companies.id",
    );
  });

  /**
   * Every column, not only the ambiguous ones: three joined tables each
   * selecting `id` give three columns called `id`, and the row keeps whichever
   * the driver saw last.
   */
  it("gives every selected column a distinct alias", () => {
    const aliases = columnAliases([
      { table: { name: "posts", alias: "posts" }, columns: ["id", "title"] },
      { table: { name: "authors", alias: "authors" }, columns: ["id", "name"] },
    ]);

    expect(new Set(aliases.map((each) => each.as)).size).toBe(4);
  });

  it("keeps the expression alongside", () => {
    const aliases = columnAliases([{ table: { name: "posts", alias: "posts" }, columns: ["id"] }]);

    expect(aliases[0]?.expression).toBe("posts.id");
  });

  it("renders a select list", () => {
    const aliases = columnAliases([{ table: { name: "posts", alias: "posts" }, columns: ["id"] }]);

    expect(applyColumnAliases(aliases)).toBe('"posts"."id" AS "t0_r0"');
  });

  it("quotes the way the adapter asks", () => {
    const aliases = columnAliases([{ table: { name: "posts", alias: "posts" }, columns: ["id"] }]);

    expect(applyColumnAliases(aliases, (name) => `\`${name}\``)).toContain("`posts`.`id`");
  });
});

describe("normalising what the caller passed", () => {
  it("takes a bare name", () => {
    expect(buildJoinTree("author")).toEqual([{ name: "author", children: [] }]);
  });

  it("takes a list", () => {
    expect(buildJoinTree(["author", "comments"]).map((each) => each.name)).toEqual([
      "author",
      "comments",
    ]);
  });

  it("takes a nested object", () => {
    const tree = buildJoinTree({ author: "company" });

    expect(tree[0]?.name).toBe("author");
    expect(tree[0]?.children[0]?.name).toBe("company");
  });

  it("takes a list inside an object", () => {
    const tree = buildJoinTree({ author: ["company", "posts"] } as AssociationSpec);

    expect(tree[0]?.children.map((each) => each.name)).toEqual(["company", "posts"]);
  });

  it("takes nothing", () => {
    expect(buildJoinTree(undefined)).toEqual([]);
  });

  it("walks parents before children", () => {
    expect(eachChildren(buildJoinTree({ author: "company" })).map((each) => each.name)).toEqual([
      "author",
      "company",
    ]);
  });

  it("measures how deep it goes", () => {
    expect(joinDepth(buildJoinTree({ author: "company" }))).toBe(2);
    expect(joinDepth(buildJoinTree("author"))).toBe(1);
    expect(joinDepth([])).toBe(0);
  });
});

describe("adding to a tree", () => {
  const root = (): JoinNode => ({ name: "author", children: [] });

  it("adds a new child", () => {
    const parent = root();
    addChild(parent, { name: "company", children: [] });

    expect(parent.children.map((each) => each.name)).toEqual(["company"]);
  });

  /**
   * `includes(author: :company).includes(author: :posts)` names `author` twice
   * and means one join with two children. Appending would join `authors` twice
   * and double every row.
   */
  it("merges a name it already has", () => {
    const parent = root();
    addChild(parent, { name: "company", children: [{ name: "owner", children: [] }] });
    addChild(parent, { name: "company", children: [{ name: "staff", children: [] }] });

    expect(parent.children).toHaveLength(1);
    expect(parent.children[0]?.children.map((each) => each.name)).toEqual(["owner", "staff"]);
  });

  it("hands back the node it kept", () => {
    const parent = root();
    const first = addChild(parent, { name: "company", children: [] });

    expect(addChild(parent, { name: "company", children: [] })).toBe(first);
  });
});

describe("resolving a name", () => {
  it("finds one that exists", () => {
    expect(findReflection(SCHEMA, "author").table).toBe("authors");
  });

  /** SQL referencing a table that is not there is reported far from the cause. */
  it("refuses one that does not", () => {
    expect(() => findReflection(SCHEMA, "auther")).toThrow(UnknownAssociation);
  });

  it("says what there is instead", () => {
    expect(() => findReflection(SCHEMA, "auther")).toThrow("author");
  });
});

describe("building the joins", () => {
  it("joins one association", () => {
    const { constraints } = constructJoinDependency("author", SCHEMA, "posts");

    expect(constraints).toHaveLength(1);
    expect(constraints[0]?.table.alias).toBe("authors");
    expect(constraints[0]?.on).toEqual([{ left: "posts.author_id", right: "authors.id" }]);
  });

  it("joins a nested one", () => {
    const { constraints } = constructJoinDependency({ author: "company" }, SCHEMA, "posts");

    expect(constraints.map((each) => each.table.alias)).toEqual(["authors", "companies"]);
    expect(constraints[1]?.on).toEqual([{ left: "authors.company_id", right: "companies.id" }]);
  });

  /**
   * The case the whole file is for. Two paths reach `companies`, and the
   * tracker is threaded through both — reset per branch, they would each
   * believe they were first and both take the unaliased name.
   */
  it("aliases a table reached twice", () => {
    const { constraints } = constructJoinDependency(
      [{ author: "company" }, { editor: "company" }],
      SCHEMA,
      "posts",
    );

    const aliases = constraints.map((each) => each.table.alias);

    expect(new Set(aliases).size).toBe(aliases.length);
  });

  it("aliases the second author too", () => {
    const { constraints } = constructJoinDependency(["author", "editor"], SCHEMA, "posts");

    expect(constraints[0]?.table.alias).toBe("authors");
    expect(constraints[1]?.table.alias).toBe("editor_authors");
    expect(constraints[1]?.table.name).toBe("authors");
  });

  it("joins the nested table to the alias, not the real name", () => {
    const { constraints } = constructJoinDependency(
      [{ author: "company" }, { editor: "company" }],
      SCHEMA,
      "posts",
    );

    expect(constraints[3]?.on[0]?.left).toStartWith(constraints[2]?.table.alias as string);
  });

  it("takes the base table first", () => {
    const { root } = constructJoinDependency("author", SCHEMA, "posts");

    expect(root).toEqual({ name: "posts", alias: "posts" });
  });

  it("makes an outer join when asked", () => {
    const { constraints } = constructJoinDependency("author", SCHEMA, "posts", {
      type: "LEFT OUTER",
    });

    expect(constraints[0]?.type).toBe("LEFT OUTER");
  });

  it("joins nothing for an empty spec", () => {
    expect(constructJoinDependency(undefined, SCHEMA, "posts").constraints).toEqual([]);
  });

  it("shares the tracker across branches", () => {
    const tracker = new AliasTracker();
    const root = tracker.aliasedTableFor("posts");
    joinConstraints(buildJoinTree("author"), SCHEMA, root, tracker);
    const second = joinConstraints(buildJoinTree("editor"), SCHEMA, root, tracker);

    expect(second[0]?.table.alias).not.toBe("authors");
  });
});

describe("rendering the SQL", () => {
  it("writes a plain join", () => {
    const { constraints } = constructJoinDependency("author", SCHEMA, "posts");

    expect(joinSql(constraints)).toBe(
      'INNER JOIN "authors" ON "posts"."author_id" = "authors"."id"',
    );
  });

  /** An aliased table has to name both, or the alias refers to nothing. */
  it("writes the real name and the alias", () => {
    const { constraints } = constructJoinDependency(["author", "editor"], SCHEMA, "posts");

    expect(joinSql(constraints)).toContain('"authors" "editor_authors"');
  });

  it("writes an outer join", () => {
    const { constraints } = constructJoinDependency("author", SCHEMA, "posts", {
      type: "LEFT OUTER",
    });

    expect(joinSql(constraints)).toStartWith("LEFT OUTER JOIN");
  });

  it("quotes the way the adapter asks", () => {
    const { constraints } = constructJoinDependency("author", SCHEMA, "posts");

    expect(joinSql(constraints, (name) => `\`${name}\``)).toContain("`authors`");
  });

  it("writes nothing for no joins", () => {
    expect(joinSql([])).toBe("");
  });
});

describe("what cannot be joined", () => {
  /**
   * The table depends on each row's type and a statement joins one table.
   * Joining anyway returns only the rows whose type happened to match.
   */
  it("refuses a polymorphic association", () => {
    expect(() => checkEagerLoadable("subject", { polymorphic: true })).toThrow("polymorphic");
  });

  it("says what to do instead", () => {
    expect(() => checkEagerLoadable("subject", { polymorphic: true })).toThrow("Preload");
  });

  it("allows an ordinary one", () => {
    expect(() => checkEagerLoadable("author", {})).not.toThrow();
  });
});
