/**
 * The rest of the attribute surface, ported from
 * `activerecord/test/cases/dirty_test.rb` and
 * `attribute_methods/query_test.rb`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Model, SchemaStatements, setConnection } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { isSqlite, testConnection } from "./support/database.js";

let connection: Connection;

interface PostRow {
  id: number;
  title: string | null;
  views: number | null;
  published: boolean | null;
}

class Post extends Model<PostRow>("posts") {}

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  await new SchemaStatements(connection).createTable("posts", (t) => {
    t.string("title");
    t.integer("views");
    t.boolean("published");
  });

  Post.resetColumnInformation();
});

afterEach(async () => {
  if (isSqlite) await connection.close();
});

/**
 * Rails treats `0`, `""` and `false` as absent here, which is what makes
 * `if user.name?` read the way it does — and is exactly what a hand-written
 * truthiness check gets wrong for `0`.
 */
describe("whether an attribute holds something worth having", () => {
  it("is false for null, empty and false", async () => {
    const post = await Post.create({ title: "", views: null, published: false });

    expect(post.queryAttribute("title")).toBe(false);
    expect(post.queryAttribute("views")).toBe(false);
    expect(post.queryAttribute("published")).toBe(false);
  });

  it("is false for zero", async () => {
    const post = await Post.create({ views: 0 });

    expect(post.queryAttribute("views")).toBe(false);
  });

  it("is true for anything else", async () => {
    const post = await Post.create({ title: "A", views: 3, published: true });

    expect(post.queryAttribute("title")).toBe(true);
    expect(post.queryAttribute("views")).toBe(true);
    expect(post.queryAttribute("published")).toBe(true);
  });

  it("is false for whitespace, which is not something worth having", async () => {
    const post = await Post.create({ title: "   " });

    expect(post.queryAttribute("title")).toBe(false);
  });
});

describe("the names Rails also gives the last save", () => {
  it("answers the same as savedChanges", async () => {
    const post = await Post.create({ title: "A" });
    post.title = "B";
    await post.save();

    expect(post.previousChanges()).toEqual(post.savedChanges());
    expect(post.previousChanges().title).toEqual(["A", "B"]);
  });

  it("says whether one attribute moved", async () => {
    const post = await Post.create({ title: "A", views: 1 });
    post.title = "B";
    await post.save();

    expect(post.attributePreviouslyChanged("title")).toBe(true);
    expect(post.attributePreviouslyChanged("views")).toBe(false);
  });

  it("says what it held before", async () => {
    const post = await Post.create({ title: "A" });
    post.title = "B";
    await post.save();

    expect(post.attributePreviouslyWas("title")).toBe("A");
  });
});

describe("whether an attribute has an unsaved change", () => {
  it("is true after a write and false after a save", async () => {
    const post = await Post.create({ title: "A" });

    expect(post.attributeChanged("title")).toBe(false);

    post.title = "B";
    expect(post.attributeChanged("title")).toBe(true);

    await post.save();
    expect(post.attributeChanged("title")).toBe(false);
  });

  it("stays false for an attribute nobody touched", async () => {
    const post = await Post.create({ title: "A", views: 1 });
    post.title = "B";

    expect(post.attributeChanged("views")).toBe(false);
  });
});

/**
 * For a record synced by hand — written by a raw statement, reloaded from
 * elsewhere — where the tracked "before" is no longer what the row holds and a
 * later save would write stale values back over it.
 */
describe("forgetting what changed", () => {
  it("leaves nothing for a save to write", async () => {
    const post = await Post.create({ title: "A" });
    post.title = "B";

    expect(post.changed()).toEqual(["title"]);

    post.clearChangesInformation();

    expect(post.changed()).toEqual([]);
    expect(post.attributeChanged("title")).toBe(false);
  });

  it("takes the current value as the new baseline", async () => {
    const post = await Post.create({ title: "A" });
    post.title = "B";
    post.clearChangesInformation();

    expect(post.attributeInDatabase("title")).toBe("B");
  });

  it("forgets the last save too", async () => {
    const post = await Post.create({ title: "A" });
    post.title = "B";
    await post.save();

    expect(post.hasSavedChange("title")).toBe(true);

    post.clearChangesInformation();

    expect(post.hasSavedChange("title")).toBe(false);
  });
});
