/**
 * Composing relations.
 *
 * Mirrors activerecord/test/cases/relation/or_test.rb and merging_test.rb.
 * The SQL is asserted alongside the rows, because both of the interesting bugs
 * here — missing brackets and a silently narrowed query — produce statements
 * that run perfectly well and answer the wrong thing.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Model, SchemaStatements, setConnection } from "../src/index.js";
import { testConnection } from "./support/database.js";

interface PostRow {
  id: number;
  title: string;
  status: string;
  author_id: number;
  views: number;
}

class Post extends Model<PostRow>("posts") {}

beforeEach(async () => {
  const connection = await testConnection();
  setConnection(connection);
  Post.resetColumnInformation();

  const schema = new SchemaStatements(connection);
  await schema.dropTable("posts", { ifExists: true });
  await schema.createTable("posts", (t) => {
    t.string("title");
    t.string("status");
    t.bigint("author_id");
    t.integer("views", { default: 0 });
  });

  await Post.insertAll([
    { title: "A", status: "draft", author_id: 1, views: 10 },
    { title: "B", status: "published", author_id: 1, views: 20 },
    { title: "C", status: "published", author_id: 2, views: 30 },
    { title: "D", status: "archived", author_id: 2, views: 40 },
  ]);
});

const titles = async (relation: { toArray(): Promise<Post[]> }) =>
  (await relation.toArray()).map((post) => post.title as string).sort();

describe("or", () => {
  it("matches either side", async () => {
    const relation = Post.where({ status: "draft" }).or(Post.where({ author_id: 2 }));

    expect(await titles(relation)).toEqual(["A", "C", "D"]);
  });

  // SQL binds AND tighter than OR, so leaving the brackets off turns this into
  // a different query that still runs.
  it("brackets both sides", async () => {
    const relation = Post.where({ status: "published" })
      .where({ author_id: 1 })
      .or(Post.where({ views: 40 }));

    expect(relation.toSql().sql).toContain("((");
    expect(await titles(relation)).toEqual(["B", "D"]);
  });

  it("keeps conditions added afterwards", async () => {
    const relation = Post.where({ status: "draft" })
      .or(Post.where({ author_id: 2 }))
      .where({ views: 30 });

    expect(await titles(relation)).toEqual(["C"]);
  });

  // Anything OR true is true. Treating an empty side as "no conditions to add"
  // would silently narrow the query to the other side alone.
  it("matches everything when one side has no conditions", async () => {
    expect(await titles(Post.where({ status: "draft" }).or(Post.all()))).toEqual([
      "A",
      "B",
      "C",
      "D",
    ]);

    expect(await titles(Post.all().or(Post.where({ status: "draft" })))).toEqual([
      "A",
      "B",
      "C",
      "D",
    ]);
  });

  it("takes a raw fragment on either side", async () => {
    const relation = Post.where("views > ?", 35).or(Post.where({ status: "draft" }));

    expect(await titles(relation)).toEqual(["A", "D"]);
  });

  it("chains", async () => {
    const relation = Post.where({ status: "draft" })
      .or(Post.where({ status: "archived" }))
      .or(Post.where({ views: 30 }));

    expect(await titles(relation)).toEqual(["A", "C", "D"]);
  });

  // Quietly dropping one side's limit or joins produces a query that runs and
  // answers something else.
  it("refuses two relations that differ in more than their conditions", () => {
    expect(() => Post.where({ status: "draft" }).or(Post.all().limit(2))).toThrow(/limit/);
    expect(() => Post.where({ status: "draft" }).or(Post.all().distinct())).toThrow(/distinct/);
  });

  it("allows different orderings, which do not change what matches", () => {
    expect(() =>
      Post.where({ status: "draft" }).or(Post.where({ views: 30 }).order("title")),
    ).not.toThrow();
  });
});

describe("merge", () => {
  it("adds the other relation's conditions", async () => {
    const relation = Post.where({ author_id: 1 }).merge(Post.where({ status: "published" }));

    expect(await titles(relation)).toEqual(["B"]);
  });

  // Rails' behaviour, and the only useful one: merging published onto draft
  // should mean published, not a query that matches nothing.
  it("replaces a condition on the same column rather than anding it", async () => {
    const relation = Post.where({ status: "draft" }).merge(Post.where({ status: "published" }));

    expect(await titles(relation)).toEqual(["B", "C"]);
  });

  it("leaves conditions on other columns alone", async () => {
    const relation = Post.where({ status: "draft", author_id: 1 }).merge(
      Post.where({ status: "published" }),
    );

    expect(await titles(relation)).toEqual(["B"]);
  });

  // A raw fragment has no one column to replace, so it survives.
  it("keeps a raw fragment", async () => {
    const relation = Post.where("views > ?", 15).merge(Post.where({ author_id: 2 }));

    expect(await titles(relation)).toEqual(["C", "D"]);
  });

  it("takes the other relation's ordering", async () => {
    const relation = Post.order("views").merge(Post.all().order("views", "desc"));

    expect((await relation.toArray()).map((post) => post.title)).toEqual(["D", "C", "B", "A"]);
  });

  // Asserted on the rows rather than on `count`, which drops the limit the way
  // COUNT(*) has to.
  it("takes the other relation's limit", async () => {
    expect((await Post.all().merge(Post.all().limit(2)).toArray()).length).toBe(2);
  });

  it("keeps its own ordering when the other has none", async () => {
    const relation = Post.order("views", "desc").merge(Post.where({ author_id: 2 }));

    expect((await relation.toArray()).map((post) => post.title)).toEqual(["D", "C"]);
  });

  it("is happy merging an empty relation", async () => {
    expect(await titles(Post.where({ author_id: 2 }).merge(Post.all()))).toEqual(["C", "D"]);
  });
});

// Composition is what scopes are for, and it should read as one query.
describe("used the way scopes are", () => {
  const published = () => Post.where({ status: "published" });
  const popular = () => Post.where("views >= ?", 30);

  it("combines two scopes with or", async () => {
    expect(await titles(published().or(popular()))).toEqual(["B", "C", "D"]);
  });

  it("combines two scopes with merge", async () => {
    expect(await titles(published().merge(popular()))).toEqual(["C"]);
  });
});
