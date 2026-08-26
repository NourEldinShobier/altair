/**
 * A `belongsTo` with nothing on the other end.
 *
 * Mirrors activerecord/test/cases/associations/belongs_to_associations_test.rb's
 * `belongs_to_required_by_default` cases.
 *
 * Rails changed this default in 5.0, and the reason is that an orphan is found
 * late: a comment with no post saves quietly and turns up as an exception in a
 * view months later, in a request nobody can reproduce.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Connection, Model, SchemaStatements, setConnection } from "../src/index.js";

interface PostRow {
  id: number;
  title: string;
}

interface CommentRow {
  id: number;
  post_id: number;
  body: string;
}

interface NoteRow {
  id: number;
  post_id: number;
  body: string;
}

class Comment extends Model<CommentRow>("comments") {
  declare post: () => Promise<Post | null>;

  static {
    this.belongsTo("post", () => Post);
  }
}

/** The same shape, saying it does not need one. */
class Note extends Model<NoteRow>("notes") {
  declare post: () => Promise<Post | null>;

  static {
    this.belongsTo("post", () => Post, { optional: true });
  }
}

class Post extends Model<PostRow>("posts") {
  declare comments: () => Promise<Comment[]>;

  static {
    this.hasMany("comments", () => Comment);
    this.acceptsNestedAttributesFor("comments");
  }
}

let connection: Connection;
let post: Post;

beforeEach(async () => {
  connection = new Connection(process.env.DATABASE_URL ?? "sqlite://:memory:");
  setConnection(connection);

  for (const model of [Post, Comment, Note]) {
    model.columnCache = undefined;
    model.columnTypeCache = undefined;
  }

  const schema = new SchemaStatements(connection);
  await schema.dropTable("comments", { ifExists: true });
  await schema.dropTable("notes", { ifExists: true });
  await schema.dropTable("posts", { ifExists: true });
  await schema.createTable("posts", (t) => t.string("title"));
  await schema.createTable("comments", (t) => {
    t.bigint("post_id");
    t.text("body");
  });
  await schema.createTable("notes", (t) => {
    t.bigint("post_id");
    t.text("body");
  });

  post = await Post.create({ title: "one" });
});

describe("by default", () => {
  it("refuses a record with no parent", async () => {
    const orphan = new Comment({ body: "no parent" });

    expect(await orphan.validate()).toBe(false);
  });

  it("says what Rails says", async () => {
    const orphan = new Comment({ body: "no parent" });
    await orphan.validate();

    expect(orphan.errors.on("post")).toEqual(["must exist"]);
  });

  it("does not save it", async () => {
    expect(await new Comment({ body: "no parent" }).save()).toBe(false);
    expect(await Comment.all().count()).toBe(0);
  });

  it("accepts one with a parent", async () => {
    expect(await new Comment({ post_id: post.id, body: "fine" }).validate()).toBe(true);
  });

  // This is what caught the guard not running at all: every model in the
  // existing tests declared some other validation, so the early return in
  // `runValidations` skipped this silently. A model that declares nothing else
  // is the case that finds it.
  it("applies to a model with no other validations", async () => {
    expect(Comment.validations).toHaveLength(0);
    expect(await new Comment({ body: "x" }).validate()).toBe(false);
  });
});

describe("optional", () => {
  it("lets the parent be missing", async () => {
    expect(await new Note({ body: "no parent" }).validate()).toBe(true);
  });

  it("saves without one", async () => {
    expect(await new Note({ body: "no parent" }).save()).toBe(true);
  });
});

/**
 * The flow that made the first implementation wrong. The child's foreign key
 * does not exist until the parent has been written, so a check made too early
 * refuses a save that is perfectly valid.
 */
describe("saving a parent and its children together", () => {
  it("goes through", async () => {
    const created = Post.build({
      title: "two",
      comments_attributes: [{ body: "nested" }],
    } as never);

    expect(await created.save()).toBe(true);
  });

  it("writes the child", async () => {
    const created = Post.build({
      title: "two",
      comments_attributes: [{ body: "nested" }],
    } as never);

    await created.save();

    expect(await Comment.where({ body: "nested" }).exists()).toBe(true);
  });

  it("leaves the child pointing at the parent", async () => {
    const created = Post.build({
      title: "two",
      comments_attributes: [{ body: "nested" }],
    } as never);

    await created.save();
    const child = (await Comment.findBy({ body: "nested" })) as Comment;

    expect(child.post_id).toBe(created.id as number);
  });
});
