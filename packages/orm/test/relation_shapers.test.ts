/**
 * Taking clauses off a relation.
 *
 * Mirrors activerecord/test/cases/relations_test.rb's `reorder`, `rewhere`,
 * `unscope`, `except` and `only` cases.
 *
 * Everything else on a relation adds. These five remove or replace, which is
 * the only way out from under a scope or an association that already decided
 * something for you.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Model, SchemaStatements, setConnection } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { testConnection } from "./support/database.js";

interface PostRow {
  id: number;
  title: string;
  status: string;
}

class Post extends Model<PostRow>("posts") {}

let connection: Connection;

const sqlOf = (relation: { toSql(): { sql: string } }) => relation.toSql().sql;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);
  Post.columnCache = undefined;
  Post.columnTypeCache = undefined;

  const schema = new SchemaStatements(connection);
  await schema.dropTable("posts", { ifExists: true });
  await schema.createTable("posts", (t) => {
    t.string("title");
    t.string("status");
  });

  await Post.create({ title: "b", status: "draft" });
  await Post.create({ title: "a", status: "published" });
  await Post.create({ title: "c", status: "published" });
});

/**
 * `order` appends, which is right when a caller is refining and wrong when one
 * is overriding: a scope that already ordered leaves its column first, so a
 * later `order` only breaks ties and the caller's intent quietly does nothing.
 */
describe("reorder", () => {
  it("replaces the ordering rather than adding to it", () => {
    const sql = sqlOf(Post.all().order("status").reorder("title", "desc"));

    // Quoted through the connection: MySQL uses backticks where the other two
    // use double quotes, so spelling the quotes here was an assertion that the
    // database was not MySQL.
    expect(sql).toContain(`${connection.quote("title")} DESC`);
    expect(sql).not.toContain("status");
  });

  it("is what order does not do", () => {
    expect(sqlOf(Post.all().order("status").order("title"))).toContain("status");
  });

  it("actually changes the answer", async () => {
    const titles = (await Post.all().order("title").reorder("title", "desc")).map((p) => p.title);

    expect(titles).toEqual(["c", "b", "a"]);
  });
});

/**
 * `where` conjoins, so narrowing a relation that already has a condition on the
 * same column gives `status = 'draft' AND status = 'published'` — which matches
 * nothing and reads like it should match something.
 */
describe("rewhere", () => {
  it("replaces a condition on the same column", () => {
    const sql = sqlOf(Post.where({ status: "draft" }).rewhere({ status: "published" }));

    expect(sql.match(/status/g)).toHaveLength(1);
  });

  it("is what where does not do", () => {
    const sql = sqlOf(Post.where({ status: "draft" }).where({ status: "published" }));

    expect(sql.match(/status/g)).toHaveLength(2);
  });

  it("leaves conditions on other columns alone", () => {
    const sql = sqlOf(
      Post.where({ status: "draft" }).where({ title: "a" }).rewhere({ status: "published" }),
    );

    expect(sql).toContain("title");
    expect(sql).toContain("status");
  });

  it("takes the replaced binding with it", () => {
    const { sql, bindings } = Post.where({ status: "draft" })
      .rewhere({ status: "published" })
      .toSql();

    expect(bindings).toEqual(["published"]);

    // Counted adapter-neutrally: SQLite and MySQL write `?`, Postgres writes
    // `$1`. Matching only `?` was an assertion that the database was SQLite.
    expect(sql.match(/\?|\$\d+/g) ?? []).toHaveLength(bindings.length);
  });

  it("finds what the new condition says", async () => {
    const titles = (await Post.where({ status: "draft" }).rewhere({ status: "published" }))
      .map((post) => post.title)
      .sort();

    expect(titles).toEqual(["a", "c"]);
  });

  // A raw SQL condition has no single column, so there is nothing to match it
  // against. Left alone rather than guessed at.
  it("leaves a raw condition alone", () => {
    const sql = sqlOf(Post.where("title IS NOT NULL").rewhere({ status: "published" }));

    expect(sql).toContain("title IS NOT NULL");
  });
});

describe("unscope, except and only", () => {
  const shaped = () => Post.where({ status: "published" }).order("title").limit(2).offset(1);

  it("drops the clauses it is given", () => {
    const sql = sqlOf(shaped().unscope("limit", "offset"));

    expect(sql).not.toContain("LIMIT");
    expect(sql).not.toContain("OFFSET");
    expect(sql).toContain("ORDER BY");
  });

  it("keeps the clauses it is not given", () => {
    expect(sqlOf(shaped().except("order"))).toContain("LIMIT");
  });

  it("keeps only what only names", () => {
    const sql = sqlOf(shaped().only("where"));

    expect(sql).toContain("WHERE");
    expect(sql).not.toContain("ORDER BY");
    expect(sql).not.toContain("LIMIT");
  });

  it("takes the bindings with the clause", () => {
    const { sql, bindings } = shaped().unscope("where").toSql();

    expect(bindings).toEqual([]);
    expect(sql).not.toContain("WHERE");
  });

  it("drops distinct, group, having and joins too", () => {
    const relation = Post.all().distinct().group("status").having("COUNT(*) > 0");

    const sql = sqlOf(relation.unscope("distinct", "group", "having"));

    expect(sql).not.toContain("DISTINCT");
    expect(sql).not.toContain("GROUP BY");
    expect(sql).not.toContain("HAVING");
  });

  // Every other method on a relation returns a new one, and these are no
  // different — a caller holding the original keeps what it had.
  it("leaves the relation it came from alone", () => {
    const original = shaped();
    original.unscope("where", "order", "limit");

    expect(sqlOf(original)).toContain("WHERE");
    expect(sqlOf(original)).toContain("ORDER BY");
    expect(sqlOf(original)).toContain("LIMIT");
  });

  it("runs after being emptied", async () => {
    expect(await shaped().unscope("where", "limit", "offset").count()).toBe(3);
  });
});
