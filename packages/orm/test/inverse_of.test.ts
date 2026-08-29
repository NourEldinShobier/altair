/**
 * The other side of an association that was just loaded.
 *
 * Mirrors activerecord/test/cases/associations/inverse_associations_test.rb.
 *
 * Preloading a post's comments already knows which post each comment belongs
 * to — that is how they were grouped. Without saying so, a comment asked for
 * its post goes and fetches a row the owner is holding, which is the N+1 that
 * `includes` exists to remove, one level down.
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
  declare post: () => Promise<Post | null>;
  declare linkedPost: () => Promise<Post | null>;

  static {
    this.belongsTo("post", () => Post, { optional: true });
    this.belongsTo("linkedPost", () => Post, {
      foreignKey: "post_id",
      optional: true,
      inverseOf: "linkedComments",
    });
  }
}

class Post extends Model<PostRow>("posts") {
  declare comments: () => Promise<Comment[]>;
  declare linked: () => Promise<Comment[]>;
  declare linkedComments: () => Promise<Comment[]>;

  static {
    this.hasMany("comments", () => Comment);
    this.hasMany("linked", () => Comment, { foreignKey: "post_id", inverseOf: "post" });
    this.hasMany("linkedComments", () => Comment, { foreignKey: "post_id" });
  }
}

let connection: Connection;
let post: Post;

/** How many statements a block runs. */
const queriesFor = async (body: () => Promise<unknown>): Promise<number> => {
  let queries = 0;
  const subscription = notifications.subscribe("sql.altair", () => {
    queries += 1;
  });

  try {
    await body();
  } finally {
    subscription.unsubscribe();
  }

  return queries;
};

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

  for (const body of ["a", "b", "c"]) {
    await Comment.create({ post_id: post.id, body });
  }
});

describe("a child asked for its owner", () => {
  it("does not go back to the database", async () => {
    const [loaded] = await Post.all().includes("linked");
    const children = await (loaded as Post).linked();

    const queries = await queriesFor(async () => {
      for (const child of children) await child.post();
    });

    expect(queries).toBe(0);
  });

  // The measurement that gives the number above its meaning.
  it("asks once per child without it", async () => {
    const [loaded] = await Post.all().includes("comments");
    const children = await (loaded as Post).comments();

    const queries = await queriesFor(async () => {
      for (const child of children) await child.post();
    });

    expect(queries).toBe(3);
  });

  it("is handed the very same record", async () => {
    const [loaded] = await Post.all().includes("linked");
    const children = await (loaded as Post).linked();

    expect(await (children[0] as Comment).post()).toBe(loaded as Post);
  });

  // Object identity, not just equal contents: an edit to one is visible
  // through the other, which is the difference that matters.
  it("sees an edit made through the owner", async () => {
    const [loaded] = await Post.all().includes("linked");
    const children = await (loaded as Post).linked();

    (loaded as Post).title = "renamed";

    expect(((await (children[0] as Comment).post()) as Post).title).toBe("renamed");
  });
});

describe("the other direction", () => {
  it("fills the owner's collection from a preloaded parent", async () => {
    const children = await Comment.all().includes("linkedPost");
    const owner = (await (children[0] as Comment).linkedPost()) as Post;

    const queries = await queriesFor(async () => {
      await owner.linkedComments();
    });

    expect(queries).toBe(0);
  });

  it("gathers every child under the one owner", async () => {
    const children = await Comment.all().includes("linkedPost");
    const owner = (await (children[0] as Comment).linkedPost()) as Post;

    expect(await owner.linkedComments()).toHaveLength(3);
  });
});

describe("an association without it", () => {
  it("still loads correctly, just not for free", async () => {
    const [loaded] = await Post.all().includes("comments");
    const children = await (loaded as Post).comments();

    expect(((await (children[0] as Comment).post()) as Post).id).toBe(post.id);
  });
});
