/**
 * Validating the records an association holds.
 *
 * Mirrors activerecord/test/cases/validations/association_validation_test.rb.
 * The cycle test is the one that matters: two models validating each other is
 * an ordinary thing to write, and without a guard it recurses until the stack
 * runs out — which is a much worse way to learn about it than an error.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Connection, Model, SchemaStatements, setConnection } from "../src/index.js";

interface PostRow {
  id: number;
  title: string;
}

interface CommentRow {
  id: number;
  post_id: number | null;
  body: string;
}

class Comment extends Model<CommentRow>("comments") {
  declare post: Post | undefined;

  static {
    this.validates("body", { presence: true });
  }
}

class Post extends Model<PostRow>("posts") {
  declare comments: Comment[];

  static {
    this.validates("title", { presence: true });
    this.hasMany("comments", () => Comment);
    this.validatesAssociated("comments");
  }
}

/** Two models that validate each other, to prove the guard holds. */
class Author extends Model<PostRow>("posts") {
  declare comments: Note[];
  static {
    this.hasMany("comments", () => Note);
    this.validatesAssociated("comments");
  }
}

class Note extends Model<CommentRow>("comments") {
  declare post: Author | undefined;
  static {
    this.validates("body", { presence: true });
    this.belongsTo("post", () => Author);
    this.validatesAssociated("post");
  }
}

let connection: Connection;

beforeEach(async () => {
  connection = new Connection(process.env.DATABASE_URL ?? "sqlite://:memory:");
  setConnection(connection);

  for (const model of [Post, Comment, Author, Note]) {
    model.columnCache = undefined;
    model.columnTypeCache = undefined;
  }

  const schema = new SchemaStatements(connection);
  await schema.dropTable("comments", { ifExists: true });
  await schema.dropTable("posts", { ifExists: true });

  await schema.createTable("posts", (t) => {
    t.string("title");
  });
  await schema.createTable("comments", (t) => {
    t.bigint("post_id");
    t.text("body");
  });
});

describe("with nothing loaded", () => {
  // Reaching for the association would turn every validation of every record
  // into a query, and the records a form just built are in memory anyway.
  it("passes, and asks the database nothing", async () => {
    const post = Post.build({ title: "A" });

    expect(await post.validate()).toBe(true);
  });
});

describe("with loaded records", () => {
  it("passes when they are all valid", async () => {
    const post = Post.build({ title: "A" });
    post.comments = [Comment.build({ body: "fine" })];

    expect(await post.validate()).toBe(true);
  });

  // Without this a form builds three comments, one of them blank, and the save
  // reports success while the blank one is dropped or written empty.
  it("fails when one is not", async () => {
    const post = Post.build({ title: "A" });
    post.comments = [Comment.build({ body: "fine" }), Comment.build({ body: "" })];

    expect(await post.validate()).toBe(false);
    expect(post.errors.on("comments")).toEqual(["is invalid"]);
  });

  it("says so once, however many are wrong", async () => {
    const post = Post.build({ title: "A" });
    post.comments = [Comment.build({ body: "" }), Comment.build({ body: "" })];

    await post.validate();

    expect(post.errors.on("comments")).toHaveLength(1);
  });

  it("leaves the parent's own errors alone", async () => {
    const post = Post.build({ title: "" });
    post.comments = [Comment.build({ body: "" })];

    await post.validate();

    expect(post.errors.on("title")).toContain("can't be blank");
    expect(post.errors.on("comments")).toEqual(["is invalid"]);
  });

  it("fills in the child's own errors too", async () => {
    const post = Post.build({ title: "A" });
    const bad = Comment.build({ body: "" });
    post.comments = [bad];

    await post.validate();

    expect(bad.errors.on("body")).toContain("can't be blank");
  });

  it("handles a to-one association", async () => {
    const note = Note.build({ body: "fine" });
    note.post = Author.build({});

    expect(await note.validate()).toBe(true);
  });
});

// Two models validating each other is an ordinary thing to write. Without a
// guard it recurses until the stack runs out, and a stack overflow during a
// save is a much worse way to find out than a validation error.
describe("when two models validate each other", () => {
  it("does not recurse", async () => {
    const author = Author.build({});
    const note = Note.build({ body: "fine" });

    author.comments = [note];
    note.post = author;

    expect(await author.validate()).toBe(true);
  });

  it("still reports a real failure through the cycle", async () => {
    const author = Author.build({});
    const note = Note.build({ body: "" });

    author.comments = [note];
    note.post = author;

    expect(await author.validate()).toBe(false);
    expect(author.errors.on("comments")).toEqual(["is invalid"]);
  });

  it("does not leak the guard between two separate validations", async () => {
    const author = Author.build({});
    author.comments = [Note.build({ body: "" })];

    expect(await author.validate()).toBe(false);
    expect(await author.validate()).toBe(false);
  });
});

describe("declaring it", () => {
  it("does not leak into a parent class", () => {
    class Narrower extends Post {
      static {
        this.validatesAssociated("other");
      }
    }
    void Narrower;

    expect(Post.associatedValidations).not.toContain("other");
  });
});
