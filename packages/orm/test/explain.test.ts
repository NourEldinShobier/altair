/**
 * Query annotations and plans.
 *
 * Mirrors activerecord/test/cases/relation/query_annotation_test.rb and
 * explain_test.rb. The stripping test is the important one: this is the only
 * place a relation puts caller-supplied text into a statement without a
 * binding, so it is the only place that could be an injection.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Model, SchemaStatements, setConnection } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { testConnection } from "./support/database.js";

interface PostRow {
  id: number;
  title: string;
}

class Post extends Model<PostRow>("posts") {}

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);
  Post.columnCache = undefined;
  Post.columnTypeCache = undefined;

  const schema = new SchemaStatements(connection);
  await schema.dropTable("posts", { ifExists: true });
  await schema.createTable("posts", (t) => {
    t.string("title");
  });

  await Post.create({ title: "A" });
});

describe("annotating a query", () => {
  it("appends the comment", () => {
    expect(Post.all().annotate("dashboard#index").toSql().sql).toEndWith("/* dashboard#index */");
  });

  it("keeps the query working", async () => {
    expect(await Post.all().annotate("dashboard#index").count()).toBe(1);
  });

  it("takes more than one", () => {
    const sql = Post.all().annotate("a", "b").toSql().sql;

    expect(sql).toContain("/* a */");
    expect(sql).toContain("/* b */");
  });

  it("comes after everything else", () => {
    const sql = Post.all().where({ title: "A" }).order("id").limit(1).annotate("here").toSql().sql;

    expect(sql).toEndWith("LIMIT 1 /* here */");
  });

  it("does not change a relation it was chained from", () => {
    const base = Post.all();
    base.annotate("only on the copy");

    expect(base.toSql().sql).not.toContain("/*");
  });

  // The one place caller text reaches a statement without a binding. `*/` ends
  // the comment, and whatever followed would be SQL — there is no escape for
  // it, so it comes out.
  it("strips the sequence that would end the comment", () => {
    const sql = Post.all().annotate("*/ DROP TABLE posts; --").toSql().sql;

    expect(sql).not.toContain("*/ DROP");
    expect(sql).toEndWith("/*  DROP TABLE posts; -- */");
  });

  it("still runs after something tried", async () => {
    await expect(Post.all().annotate("*/ DROP TABLE posts; --").count()).resolves.toBe(1);
    expect(await Post.count()).toBe(1);
  });

  it("strips a null byte, which some drivers treat as a terminator", () => {
    const sql = Post.all()
      .annotate(`a${String.fromCharCode(0)}b`)
      .toSql().sql;

    expect(sql).toContain("/* ab */");
  });
});

describe("explaining a query", () => {
  it("returns the plan as rows", async () => {
    const plan = await Post.where({ title: "A" }).explain();

    expect(Array.isArray(plan)).toBe(true);
    expect(plan.length).toBeGreaterThan(0);
  });

  it("explains the query it was asked about, bindings and all", async () => {
    await expect(Post.where({ title: "A" }).order("id").limit(1).explain()).resolves.toBeDefined();
  });

  it("does not run the query itself", async () => {
    await Post.all().explain();

    expect(await Post.count()).toBe(1);
  });
});
