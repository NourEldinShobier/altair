/**
 * Reaching an attribute past its accessor, and what a log line shows of a
 * record. Ported from `activerecord/test/cases/attribute_methods_test.rb` and
 * the `attributes_for_inspect` cases in `base_test.rb`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Model, SchemaStatements, setConnection } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { isSqlite, testConnection } from "./support/database.js";

interface PostRow {
  id: number;
  title: string;
  body: string;
  status: number;
  email: string;
}

class Post extends Model<PostRow>("posts") {}

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  Post.columnCache = undefined;
  Post.columnTypeCache = undefined;
  Post.attributeAliases = {};
  Post.attributesForInspect = [];
  Post.enums = {};
  Post.normalizers = {};

  await new SchemaStatements(connection).createTable("posts", (t) => {
    t.string("title");
    t.string("body");
    t.integer("status");
    t.string("email");
  });
});

afterEach(async () => {
  Post.attributesForInspect = [];
  Post.enums = {};
  Post.normalizers = {};

  // `enum` and `normalizes` put accessors on the prototype, and emptying the
  // registries does not take them off — a stale enum setter left behind here
  // rejects a plain integer in the next test, from a declaration that test
  // never made.
  for (const name of ["status", "email"]) {
    delete (Post.prototype as unknown as Record<string, unknown>)[name];
  }

  if (isSqlite) await connection.close();
});

describe("readAttribute", () => {
  it("gives a column's value", () => {
    expect(Post.build({ title: "one" }).readAttribute("title")).toBe("one");
  });

  it("gives undefined for a column nobody set", () => {
    expect(Post.build({}).readAttribute("title")).toBeUndefined();
  });

  it("follows an alias, so it reads what the accessor would", () => {
    Post.aliasAttribute("headline", "title");

    expect(Post.build({ title: "one" }).readAttribute("headline")).toBe("one");
  });

  /**
   * The reason it exists. An accessor overriding a column has no `super` to
   * reach through — the value lives in the attribute store, not on a
   * prototype — so without this it calls itself and the process stops with a
   * stack overflow rather than a message about the model.
   */
  it("is reachable from an accessor that shadows the column", () => {
    // Its own base rather than a subclass of Post: `inherit()` would turn Post
    // into an STI root and every other test here would start writing a `type`
    // column the table has not got.
    class Shouty extends Model<PostRow>("posts") {
      override get title(): string {
        return String(this.readAttribute("title") ?? "").toUpperCase();
      }
    }

    expect(Shouty.build({ title: "one" }).title).toBe("ONE");
  });
});

describe("writeAttribute", () => {
  it("sets a column's value", () => {
    const post = Post.build({});

    post.writeAttribute("title", "one");

    expect(post.title).toBe("one");
  });

  it("follows an alias", () => {
    Post.aliasAttribute("headline", "title");

    const post = Post.build({});

    post.writeAttribute("headline", "one");

    expect(post.title).toBe("one");
  });

  /** The point: the caller has already done that work and would do it twice. */
  it("skips a normaliser the class declared", () => {
    Post.normalizes("email", (value: string) => value.trim().toLowerCase());

    const post = Post.build({});

    post.writeAttribute("email", "  A@B.TEST  ");

    expect(post.readAttribute("email")).toBe("  A@B.TEST  ");
  });

  it("marks the record as changed", async () => {
    const post = await Post.create({ title: "one", body: "b", status: 0, email: "a" });

    post.writeAttribute("title", "two");

    expect(post.changed()).toContain("title");
  });
});

describe("readAttributeBeforeTypeCast", () => {
  /**
   * A form re-render. Somebody picks a status the model stores as an integer;
   * the validation fails, the field is rendered from the record, and it comes
   * back holding the integer rather than what they chose.
   */
  it("gives back what was assigned to an enum", () => {
    Post.enum("status", { draft: 0, published: 1 });

    const post = Post.build({});
    post.status = "published" as never;

    expect(post.readAttribute("status")).toBe(1);
    expect(post.readAttributeBeforeTypeCast("status")).toBe("published");
  });

  it("gives back what was typed before a normaliser trimmed it", () => {
    Post.normalizes("email", (value: string) => value.trim().toLowerCase());

    const post = Post.build({});
    post.email = "  A@B.TEST  " as never;

    expect(post.readAttribute("email")).toBe("a@b.test");
    expect(post.readAttributeBeforeTypeCast("email")).toBe("  A@B.TEST  ");
  });

  /** A plain column keeps what was assigned, so there is nothing earlier. */
  it("gives the stored value for a column the model does not transform", () => {
    expect(Post.build({ title: "one" }).readAttributeBeforeTypeCast("title")).toBe("one");
  });

  it("gives the stored value for a record loaded from the database", async () => {
    await Post.create({ title: "one", body: "b", status: 0, email: "a@b.test" });

    expect((await Post.first())?.readAttributeBeforeTypeCast("title")).toBe("one");
  });

  it("collects them all", () => {
    Post.normalizes("email", (value: string) => value.trim());

    const post = Post.build({ title: "one" });
    post.email = "  a@b.test  " as never;

    expect(post.attributesBeforeTypeCast()).toMatchObject({
      title: "one",
      email: "  a@b.test  ",
    });
  });

  it("follows an alias", () => {
    Post.normalizes("email", (value: string) => value.trim());
    Post.aliasAttribute("contact", "email");

    const post = Post.build({});
    post.email = "  a@b.test  " as never;

    expect(post.readAttributeBeforeTypeCast("contact")).toBe("  a@b.test  ");
  });
});

describe("what would be written", () => {
  it("gives an enum as its stored integer", () => {
    Post.enum("status", { draft: 0, published: 1 });

    const post = Post.build({});
    post.status = "published" as never;

    expect(post.readAttributeForDatabase("status")).toBe(1);
  });

  it("collects them all", () => {
    const post = Post.build({ title: "one", body: "b" });

    expect(post.attributesForDatabase()).toMatchObject({ title: "one", body: "b" });
  });

  it("gives a copy, so a caller cannot write through it", () => {
    const post = Post.build({ title: "one" });
    const values = post.attributesForDatabase();

    values.title = "changed";

    expect(post.title).toBe("one");
  });
});

describe("what a log line shows", () => {
  /**
   * Rails added this because logging a record with a large text column puts
   * kilobytes into the log for every line that mentions it, and a log nobody
   * can scroll is a log nobody reads.
   */
  it("shows the primary key alone by default", async () => {
    const post = await Post.create({ title: "one", body: "x".repeat(5000), status: 0, email: "a" });

    expect(Object.keys(post.attributesForInspect())).toEqual(["id"]);
  });

  it("shows what the class asked for", async () => {
    Post.attributesForInspect = ["title"];

    const post = await Post.create({ title: "one", body: "b", status: 0, email: "a" });

    expect(post.attributesForInspect()).toEqual({ id: post.id, title: "one" });
  });

  it("skips a name the record has no value for", () => {
    Post.attributesForInspect = ["title", "nonexistent"];

    expect(Object.keys(Post.build({ title: "one" }).attributesForInspect())).toEqual(["title"]);
  });

  /** One very long value defeats a readable line as thoroughly as ten short ones. */
  it("cuts a long value short", () => {
    Post.attributesForInspect = ["body"];

    const shown = Post.build({ body: "x".repeat(5000) }).attributesForInspect(20);

    expect(String(shown.body)).toBe(`${"x".repeat(20)}...`);
  });

  it("leaves a short value whole", () => {
    Post.attributesForInspect = ["title"];

    expect(Post.build({ title: "one" }).attributesForInspect(20).title).toBe("one");
  });

  it("leaves a value that is not a string alone", () => {
    Post.attributesForInspect = ["status"];

    expect(Post.build({ status: 3 }).attributesForInspect(2).status).toBe(3);
  });

  it("shows everything when the class says so", () => {
    Post.attributesForInspect = "all";

    const shown = Post.build({ title: "one", body: "b" }).attributesForInspect();

    expect(Object.keys(shown).sort()).toEqual(["body", "title"]);
  });

  /** For a console, where the whole record is the point. */
  it("has a way to see everything regardless", () => {
    const post = Post.build({ title: "one", body: "b" });

    expect(post.allAttributesForInspect()).toMatchObject({ title: "one", body: "b" });
  });

  it("does not cut anything in the full view", () => {
    const long = "x".repeat(5000);

    expect(Post.build({ body: long }).allAttributesForInspect().body).toBe(long);
  });
});
