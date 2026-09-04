/**
 * The attribute and commit-callback API Rails has, ported from
 * `activerecord/test/cases/dirty_test.rb` and `transaction_callbacks_test.rb`.
 *
 * These are the questions a callback asks. Rails names each of them because
 * "did this change" has four different meanings depending on whether the save
 * has happened yet, and reaching into the attributes by hand gets it wrong in
 * a way that only shows up under a transaction.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Model, SchemaStatements, setConnection } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { isSqlite, testConnection } from "./support/database.js";

interface PostRow {
  id: number;
  title: string;
  views: number | null;
}

class Post extends Model<PostRow>("posts") {}

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  Post.resetColumnInformation();

  await new SchemaStatements(connection).createTable("posts", (t) => {
    t.string("title");
    t.integer("views");
  });
});

afterEach(async () => {
  if (isSqlite) await connection.close();
});

describe("asking a record about its attributes", () => {
  it("says which it has", async () => {
    const post = await Post.create({ title: "A", views: 1 });

    expect(post.hasAttribute("title")).toBe(true);
    expect(post.hasAttribute("nonsense")).toBe(false);
  });

  it("lists them", async () => {
    const post = await Post.create({ title: "A", views: 1 });

    expect(post.attributeNames().sort()).toEqual(["id", "title", "views"]);
  });
});

/**
 * The distinction Rails names carefully: before a save, the database still
 * holds the old value, and a callback comparing against it needs that rather
 * than the one in memory.
 */
describe("what the row holds against what the record holds", () => {
  it("answers with the value before the change", async () => {
    const post = await Post.create({ title: "A" });
    post.title = "B";

    expect(post.title).toBe("B");
    expect(post.attributeInDatabase("title")).toBe("A");
  });

  it("gives all of them at once", async () => {
    const post = await Post.create({ title: "A", views: 1 });
    post.title = "B";

    expect(post.attributesInDatabase().title).toBe("A");
    expect(post.attributesInDatabase().views).toBe(1);
  });

  it("keeps the key the row was found by", async () => {
    const post = await Post.create({ title: "A" });

    expect(post.idInDatabase).toBe(post.id);
  });
});

describe("what a save would write", () => {
  it("says whether it would write anything", async () => {
    const post = await Post.create({ title: "A" });

    expect(post.hasChangesToSave()).toBe(false);

    post.title = "B";

    expect(post.hasChangesToSave()).toBe(true);
  });

  it("says whether it would write one attribute", async () => {
    const post = await Post.create({ title: "A", views: 1 });
    post.title = "B";

    expect(post.willSaveChangeToAttribute("title")).toBe(true);
    expect(post.willSaveChangeToAttribute("views")).toBe(false);
  });

  it("gives the pending change as was and is", async () => {
    const post = await Post.create({ title: "A" });
    post.title = "B";

    expect(post.attributeChangeToBeSaved("title")).toEqual(["A", "B"]);
    expect(post.attributeChangeToBeSaved("views")).toBeUndefined();
  });

  it("names them all", async () => {
    const post = await Post.create({ title: "A", views: 1 });
    post.title = "B";
    post.views = 2;

    expect(post.changedAttributeNamesToSave().sort()).toEqual(["title", "views"]);
    expect(Object.keys(post.changesToSave()).sort()).toEqual(["title", "views"]);
  });

  // The other side of #127: after the save the record is clean, and the
  // question becomes what it *did* write.
  it("says nothing once the save has happened", async () => {
    const post = await Post.create({ title: "A" });
    post.title = "B";
    await post.save();

    expect(post.hasChangesToSave()).toBe(false);
    expect(post.hasSavedChange("title")).toBe(true);
  });
});

/**
 * The named commit callbacks. `afterCommit(fn, { on: "create" })` says the same
 * thing, and reading `afterCreateCommit` at a glance is the point — an options
 * hash three lines below the body is a thing to go and check.
 */
describe("commit callbacks by name", () => {
  it("runs the create one only on a create", async () => {
    const ran: string[] = [];

    class Article extends Model<PostRow>("posts") {
      static {
        this.afterCreateCommit(() => void ran.push("create"));
        this.afterUpdateCommit(() => void ran.push("update"));
      }
    }

    const article = await Article.create({ title: "A" });

    expect(ran).toEqual(["create"]);

    article.title = "B";
    await article.save();

    expect(ran).toEqual(["create", "update"]);
  });

  it("runs the destroy one only on a destroy", async () => {
    const ran: string[] = [];

    class Article extends Model<PostRow>("posts") {
      static {
        this.afterDestroyCommit(() => void ran.push("destroy"));
      }
    }

    const article = await Article.create({ title: "A" });
    expect(ran).toEqual([]);

    await article.destroy();
    expect(ran).toEqual(["destroy"]);
  });

  // Both halves of a save, and not a destroy.
  it("runs the save one for a create and an update", async () => {
    const ran: string[] = [];

    class Article extends Model<PostRow>("posts") {
      static {
        this.afterSaveCommit(() => void ran.push("save"));
      }
    }

    const article = await Article.create({ title: "A" });
    article.title = "B";
    await article.save();
    await article.destroy();

    expect(ran).toEqual(["save", "save"]);
  });
});
