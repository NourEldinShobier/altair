/**
 * The query methods that reshape a relation rather than narrowing it, ported
 * from `activerecord/test/cases/relation/where_test.rb` and
 * `relation_test.rb`.
 *
 * `invertWhere` is the one worth reading twice: the opposite of "draft and
 * mine" is not "published and not mine".
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Model, SchemaStatements, setConnection } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { isSqlite, testConnection } from "./support/database.js";

interface PostRow {
  id: number;
  title: string;
  state: string;
  author_id: number;
}

class Post extends Model<PostRow>("posts") {}

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  Post.columnCache = undefined;
  Post.columnTypeCache = undefined;

  await new SchemaStatements(connection).createTable("posts", (t) => {
    t.string("title");
    t.string("state");
    t.integer("author_id");
  });

  for (const [title, state, author_id] of [
    ["A", "draft", 1],
    ["B", "live", 1],
    ["C", "draft", 2],
    ["D", "live", 2],
  ] as [string, string, number][]) {
    await Post.create({ title, state, author_id });
  }
});

afterEach(async () => {
  if (isSqlite) await connection.close();
});

const titles = async (relation: { toArray(): Promise<PostRow[]> }) =>
  (await relation.toArray()).map((post) => post.title).sort();

/**
 * The whole thing inverted, not each condition separately.
 *
 * The opposite of "draft and mine" is "not (draft and mine)", which includes
 * somebody else's draft. Inverting one at a time gives "published and not
 * mine" — a different and much smaller set, and the mistake this method exists
 * to stop people making by hand.
 */
describe("inverting a where", () => {
  it("takes everything the relation would not have matched", async () => {
    const mine = Post.where({ state: "draft", author_id: 1 });

    expect(await titles(mine)).toEqual(["A"]);
    expect(await titles(mine.invertWhere())).toEqual(["B", "C", "D"]);
  });

  it("is not the same as inverting each condition", async () => {
    const inverted = await titles(Post.where({ state: "draft", author_id: 1 }).invertWhere());
    const eachInverted = await titles(
      Post.all().whereNot({ state: "draft" }).whereNot({ author_id: 1 }),
    );

    // "not (draft and mine)" keeps C; "published and not mine" does not.
    expect(inverted).toContain("C");
    expect(eachInverted).not.toContain("C");
  });

  it("does nothing to a relation with no conditions", async () => {
    expect(await titles(Post.all().invertWhere())).toEqual(["A", "B", "C", "D"]);
  });

  it("can be inverted back", async () => {
    const twice = Post.where({ state: "draft" }).invertWhere().invertWhere();

    expect(await titles(twice)).toEqual(["A", "C"]);
  });
});

describe("adding methods to a relation", () => {
  it("puts them on this relation and what chains off it", async () => {
    const base = Post.all();
    const posts = base.extending({
      drafts: () => base.where({ state: "draft" }),
    });

    expect(await titles(posts.drafts())).toEqual(["A", "C"]);
  });

  it("leaves another relation alone", async () => {
    Post.all().extending({ drafts: () => null });

    expect((Post.all() as unknown as Record<string, unknown>).drafts).toBeUndefined();
  });
});

describe("replacing rather than adding", () => {
  it("replaces the select list", () => {
    const { sql } = Post.all().select("title").reselect("state").toSql();

    expect(sql).toContain('"state"');
    expect(sql).not.toContain('"title"');
  });

  it("replaces the grouping", () => {
    const { sql } = Post.all().group("title").regroup("state").toSql();

    expect(sql).toContain('GROUP BY "posts"."state"');
    expect(sql).not.toContain('"posts"."title"');
  });
});

/**
 * Takes the records themselves rather than their ids, because that is what the
 * caller has: "everything except the one I am showing".
 */
describe("leaving records out", () => {
  it("excludes one it was given", async () => {
    const first = await Post.find(1);

    expect(await titles(Post.all().excluding(first))).toEqual(["B", "C", "D"]);
  });

  it("excludes several", async () => {
    const [first, second] = await Post.find([1, 2]);

    expect(await titles(Post.all().excluding(first!, second!))).toEqual(["C", "D"]);
  });

  it("takes ids as well as records", async () => {
    expect(await titles(Post.all().excluding(1, 2))).toEqual(["C", "D"]);
  });

  it("does nothing when given nothing", async () => {
    expect(await titles(Post.all().excluding())).toEqual(["A", "B", "C", "D"]);
  });
});
