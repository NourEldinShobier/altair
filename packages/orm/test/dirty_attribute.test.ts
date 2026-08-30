/**
 * Per-attribute dirty tracking, ported from
 * `activemodel/test/cases/dirty_test.rb` and the saved-change cases in
 * `activerecord/test/cases/dirty_test.rb`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Model, SchemaStatements, setConnection } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { isSqlite, testConnection } from "./support/database.js";

interface PostRow {
  id: number;
  title: string;
  body: string | null;
  views: number;
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
    t.string("body");
    t.integer("views");
  });
});

afterEach(async () => {
  if (isSqlite) await connection.close();
});

describe("changeToAttribute", () => {
  it("gives what it was and what it is", async () => {
    const post = await Post.create({ title: "one", views: 1 });
    post.title = "two";

    expect(post.changeToAttribute("title")).toEqual(["one", "two"]);
  });

  /**
   * Undefined separates "was set to null" from "was not touched", which
   * `changes()[name]` cannot do without a key check people leave out.
   */
  it("gives undefined for an attribute that did not change", async () => {
    const post = await Post.create({ title: "one", views: 1 });
    post.title = "two";

    expect(post.changeToAttribute("views")).toBeUndefined();
  });

  it("reports a change to null as a change", async () => {
    const post = await Post.create({ title: "one", body: "text", views: 1 });
    post.body = null;

    expect(post.changeToAttribute("body")).toEqual(["text", null]);
  });

  it("gives undefined on a record nobody has touched", async () => {
    const post = await Post.create({ title: "one", views: 1 });

    expect(post.changeToAttribute("title")).toBeUndefined();
  });
});

describe("willSaveChangeTo", () => {
  /** For a beforeSave deciding whether to regenerate a slug. */
  it("says yes for a pending change", async () => {
    const post = await Post.create({ title: "one", views: 1 });
    post.title = "two";

    expect(post.willSaveChangeTo("title")).toBe(true);
    expect(post.willSaveChangeTo("views")).toBe(false);
  });

  it("says no once the change has been written", async () => {
    const post = await Post.create({ title: "one", views: 1 });
    post.title = "two";
    await post.save();

    expect(post.willSaveChangeTo("title")).toBe(false);
  });
});

describe("savedChangeToAttribute", () => {
  /**
   * The one an afterSave wants. changeToAttribute is empty by then, so a
   * callback asking that question gets nothing and quietly does not run.
   */
  it("reports what the last save wrote", async () => {
    const post = await Post.create({ title: "one", views: 1 });
    post.title = "two";
    await post.save();

    expect(post.savedChangeToAttribute("title")).toEqual(["one", "two"]);
  });

  it("gives undefined for an attribute the save did not touch", async () => {
    const post = await Post.create({ title: "one", views: 1 });
    post.title = "two";
    await post.save();

    expect(post.savedChangeToAttribute("views")).toBeUndefined();
  });

  it("is empty before anything has been saved over", async () => {
    const post = Post.build({ title: "one", views: 1 });

    expect(post.savedChangeToAttribute("title")).toBeUndefined();
  });
});

describe("restoreAttribute", () => {
  it("puts one attribute back", async () => {
    const post = await Post.create({ title: "one", views: 1 });
    post.title = "two";
    post.restoreAttribute("title");

    expect(post.title).toBe("one");
    expect(post.willSaveChangeTo("title")).toBe(false);
  });

  /** The narrow form: everything else the caller set has to survive. */
  it("leaves other changes alone", async () => {
    const post = await Post.create({ title: "one", views: 1 });
    post.title = "two";
    post.views = 99;
    post.restoreAttribute("title");

    expect(post.title).toBe("one");
    expect(post.views).toBe(99);
    expect(post.willSaveChangeTo("views")).toBe(true);
  });

  it("does nothing for an attribute that did not change", async () => {
    const post = await Post.create({ title: "one", views: 1 });
    post.restoreAttribute("title");

    expect(post.title).toBe("one");
  });
});

describe("clearAttributeChanges", () => {
  /** The value stays; only the record's memory of having changed it goes. */
  it("keeps the value and forgets the change", async () => {
    const post = await Post.create({ title: "one", views: 1 });
    post.views = 99;
    post.clearAttributeChanges("views");

    expect(post.views).toBe(99);
    expect(post.willSaveChangeTo("views")).toBe(false);
  });

  it("stops the next save writing that column", async () => {
    const post = await Post.create({ title: "one", views: 1 });
    post.views = 99;
    post.clearAttributeChanges("views");
    post.title = "two";
    await post.save();

    const stored = await Post.find(post.id);

    expect(stored.title).toBe("two");
    expect(stored.views).toBe(1);
  });

  it("leaves other changes pending", async () => {
    const post = await Post.create({ title: "one", views: 1 });
    post.title = "two";
    post.views = 99;
    post.clearAttributeChanges("views");

    expect(post.willSaveChangeTo("title")).toBe(true);
  });

  it("clears everything when given no names", async () => {
    const post = await Post.create({ title: "one", views: 1 });
    post.title = "two";
    post.views = 99;
    post.clearAttributeChanges();

    expect(post.changed()).toEqual([]);
  });
});
