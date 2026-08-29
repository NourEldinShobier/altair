/**
 * Saving what an association is holding.
 *
 * Mirrors activerecord/test/cases/autosave_association_test.rb.
 *
 * Only what is already in memory. Fetching an association in order to save it
 * would turn every save into a query per association, and nothing that was
 * never read can have been changed.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { notifications } from "@altair/support";
import { Connection, Model, SchemaStatements, setConnection } from "../src/index.js";
import { testConnection } from "./support/database.js";

interface PostRow {
  id: number;
  title: string;
}

interface CommentRow {
  id: number;
  post_id: number;
  body: string;
}

class Comment extends Model<CommentRow>("comments") {
  static {
    this.validates("body", { presence: true });
  }
}

class Post extends Model<PostRow>("posts") {
  declare comments: () => Promise<Comment[]>;
  declare saved: () => Promise<Comment[]>;

  static {
    this.hasMany("comments", () => Comment);
    this.hasMany("saved", () => Comment, { foreignKey: "post_id", autosave: true });
  }
}

let connection: Connection;
let post: Post;

const bodyOf = async (id: unknown): Promise<string> =>
  String(((await Comment.findBy({ id })) as Comment).body);

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  for (const model of [Post, Comment]) {
    model.columnCache = undefined;
    model.columnTypeCache = undefined;
  }

  const schema = new SchemaStatements(connection);
  await schema.dropTable("comments", { ifExists: true });
  await schema.dropTable("posts", { ifExists: true });
  await schema.createTable("posts", (t) => t.string("title"));
  await schema.createTable("comments", (t) => {
    t.bigint("post_id");
    t.text("body");
  });

  post = await Post.create({ title: "one" });
});

describe("a loaded child that changed", () => {
  it("is saved with its owner", async () => {
    const child = await Comment.create({ post_id: post.id, body: "before" });

    const [loaded] = await Post.all().includes("saved");
    const children = await (loaded as Post).saved();
    (children[0] as Comment).body = "after";

    await (loaded as Post).save();

    expect(await bodyOf(child.id)).toBe("after");
  });

  it("is not saved when the association does not autosave", async () => {
    const child = await Comment.create({ post_id: post.id, body: "before" });

    const [loaded] = await Post.all().includes("comments");
    const children = await (loaded as Post).comments();
    (children[0] as Comment).body = "after";

    await (loaded as Post).save();

    expect(await bodyOf(child.id)).toBe("before");
  });

  it("saves the owner's own changes as well", async () => {
    await Comment.create({ post_id: post.id, body: "x" });

    const [loaded] = await Post.all().includes("saved");
    (loaded as Post).title = "renamed";
    await (loaded as Post).save();

    expect(((await Post.findBy({ id: post.id })) as Post).title).toBe("renamed");
  });
});

/**
 * A loaded collection of a hundred comments should not be a hundred statements
 * because one of them changed.
 */
describe("a loaded child that did not change", () => {
  it("is left alone", async () => {
    await Comment.create({ post_id: post.id, body: "a" });
    await Comment.create({ post_id: post.id, body: "b" });

    const [loaded] = await Post.all().includes("saved");
    const children = await (loaded as Post).saved();
    (children[0] as Comment).body = "edited";

    let writes = 0;
    const subscription = notifications.subscribe("sql.altair", (event) => {
      // The statement is on `payload`, not on the event: an event carries the
      // timing and the payload carries what ran.
      const sql = String((event.payload as { sql?: string } | undefined)?.sql ?? "");

      if (sql.startsWith("UPDATE")) writes += 1;
    });

    try {
      await (loaded as Post).save();
    } finally {
      subscription.unsubscribe();
    }

    // The changed child, and nothing for the other one. The owner itself has
    // nothing to write, since only the child moved.
    expect(writes).toBe(1);
  });
});

describe("an association nobody read", () => {
  it("is not fetched in order to be saved", async () => {
    await Comment.create({ post_id: post.id, body: "a" });

    const fresh = (await Post.findBy({ id: post.id })) as Post;
    fresh.title = "renamed";

    let queries = 0;
    const subscription = notifications.subscribe("sql.altair", () => {
      queries += 1;
    });

    try {
      await fresh.save();
    } finally {
      subscription.unsubscribe();
    }

    // One UPDATE for the post. Nothing went looking for comments.
    expect(queries).toBe(1);
  });
});

/**
 * The owner and its children are one save, so a child that will not validate
 * has to take the whole thing down — otherwise the owner is written and the
 * child that was meant to go with it is not.
 */
describe("a child that will not save", () => {
  it("stops the owner being saved", async () => {
    await Comment.create({ post_id: post.id, body: "fine" });

    const [loaded] = await Post.all().includes("saved");
    const children = await (loaded as Post).saved();
    (children[0] as Comment).body = "";
    (loaded as Post).title = "renamed";

    await (loaded as Post).save().catch(() => undefined);

    expect(((await Post.findBy({ id: post.id })) as Post).title).toBe("one");
  });

  it("leaves the child as it was", async () => {
    const child = await Comment.create({ post_id: post.id, body: "fine" });

    const [loaded] = await Post.all().includes("saved");
    const children = await (loaded as Post).saved();
    (children[0] as Comment).body = "";

    await (loaded as Post).save().catch(() => undefined);

    expect(await bodyOf(child.id)).toBe("fine");
  });
});
