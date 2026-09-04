/**
 * Narrowing an association.
 *
 * Mirrors activerecord/test/cases/associations/has_many_associations_test.rb's
 * scoped-association cases.
 *
 * The care needed here is not in the narrowing, which is a `where`. It is that
 * an association is read two ways — directly and through `includes` — and both
 * have to mean the same thing. If one narrowed and the other did not, adding
 * `includes` to a page would change which records it showed, and the only
 * thing that looked different would be the query count.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Model, SchemaStatements, setConnection } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { testConnection } from "./support/database.js";

interface PostRow {
  id: number;
  title: string;
}

interface CommentRow {
  id: number;
  post_id: number;
  body: string;
  approved: number;
}

class Comment extends Model<CommentRow>("comments") {
  declare post: () => Promise<Post | null>;
  declare livePost: () => Promise<Post | null>;

  static {
    this.belongsTo("post", () => Post);
    this.belongsTo("livePost", () => Post, {
      foreignKey: "post_id",
      scope: (posts) => posts.where({ title: "one" }),
    });
  }
}

class Post extends Model<PostRow>("posts") {
  declare comments: () => Promise<Comment[]>;
  declare approvedComments: () => Promise<Comment[]>;
  declare newestComment: () => Promise<Comment[]>;

  static {
    this.hasMany("comments", () => Comment);
    this.hasMany("approvedComments", () => Comment, {
      foreignKey: "post_id",
      scope: (comments) => comments.where({ approved: 1 }),
    });
    this.hasMany("newestComment", () => Comment, {
      foreignKey: "post_id",
      scope: (comments) => comments.order("id", "desc").limit(1),
    });
  }
}

let connection: Connection;
let post: Post;

const bodies = (comments: Comment[]) => comments.map((comment) => String(comment.body)).sort();

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  for (const model of [Post, Comment]) {
    model.resetColumnInformation();
  }

  const schema = new SchemaStatements(connection);
  await schema.dropTable("comments", { ifExists: true });
  await schema.dropTable("posts", { ifExists: true });
  await schema.createTable("posts", (t) => t.string("title"));
  await schema.createTable("comments", (t) => {
    t.bigint("post_id");
    t.text("body");
    t.integer("approved", { default: 0 });
  });

  post = await Post.create({ title: "one" });
  await Comment.create({ post_id: post.id, body: "yes", approved: 1 });
  await Comment.create({ post_id: post.id, body: "no", approved: 0 });
  await Comment.create({ post_id: post.id, body: "also yes", approved: 1 });
});

describe("reading it directly", () => {
  it("returns only what the scope allows", async () => {
    expect(bodies(await post.approvedComments())).toEqual(["also yes", "yes"]);
  });

  it("leaves an association with no scope alone", async () => {
    expect(bodies(await post.comments())).toEqual(["also yes", "no", "yes"]);
  });

  it("takes an ordering and a limit, not only conditions", async () => {
    const newest = await post.newestComment();

    expect(newest).toHaveLength(1);
    expect(String(newest[0]?.body)).toBe("also yes");
  });
});

describe("preloading it", () => {
  it("returns the same records as reading it directly", async () => {
    const direct = bodies(await post.approvedComments());

    const [loaded] = await Post.all().includes("approvedComments");
    const preloaded = bodies(await (loaded as Post).approvedComments());

    expect(preloaded).toEqual(direct);
  });

  // Said as its own assertion, because this is the failure: adding `includes`
  // to a page changing which records it shows, with only the query count
  // appearing to differ.
  it("does not return what the scope excluded", async () => {
    const [loaded] = await Post.all().includes("approvedComments");

    expect(bodies(await (loaded as Post).approvedComments())).not.toContain("no");
  });

  it("still preloads an unscoped association in full", async () => {
    const [loaded] = await Post.all().includes("comments");

    expect(bodies(await (loaded as Post).comments())).toHaveLength(3);
  });
});

describe("on a belongsTo", () => {
  it("narrows the parent it will accept", async () => {
    const other = await Post.create({ title: "two" });
    const comment = await Comment.create({ post_id: other.id, body: "x", approved: 1 });

    expect(await comment.post()).not.toBeNull();
    expect(await comment.livePost()).toBeNull();
  });

  it("finds the parent when the scope allows it", async () => {
    const comment = (await Comment.findBy({ body: "yes" })) as Comment;

    expect(await comment.livePost()).not.toBeNull();
  });

  it("agrees with the preloaded answer", async () => {
    const other = await Post.create({ title: "two" });
    await Comment.create({ post_id: other.id, body: "orphan", approved: 1 });

    const loaded = await Comment.where({ body: "orphan" }).includes("livePost");

    expect(await (loaded[0] as Comment).livePost()).toBeNull();
  });
});
