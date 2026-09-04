/**
 * `post.commentIds()` and `post.setCommentIds([…])`, ported from
 * `ids_reader` / `ids_writer` in
 * `activerecord/lib/active_record/associations/collection_association.rb` and
 * the `test_ids_reader` cases in
 * `activerecord/test/cases/associations/has_many_associations_test.rb`.
 *
 * `hasAndBelongsToMany` has had these since it was written and `hasMany` never
 * did, which is the wrong way round: a checkbox list posts back a set of ids
 * and nothing else, and the collection it edits is usually a `hasMany`.
 *
 * Without them the controller works out which rows to detach and which to
 * attach, which is the diff below written again at every call site that edits
 * a collection.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Connection, setConnection } from "../src/connection.js";
import { testConnection } from "./support/database.js";
import { SchemaStatements } from "../src/schema.js";
import { DeleteRestricted, Model, RecordNotFound } from "../src/index.js";

interface PostRow {
  id: number;
  title: string;
}

interface CommentRow {
  id: number;
  post_id: number | null;
  body: string;
}

class Post extends Model<PostRow>("posts") {
  declare id: number;
  declare title: string;
  declare comments: () => Promise<Comment[]>;
  declare commentIds: () => Promise<unknown[]>;
  declare setCommentIds: (ids: readonly unknown[]) => Promise<void>;
}

class Comment extends Model<CommentRow>("comments") {
  declare id: number;
  declare post_id: number | null;
  declare body: string;
}

let connection: Connection;
let post: Post;

async function commentsNamed(...bodies: string[]): Promise<Comment[]> {
  const made: Comment[] = [];

  for (const body of bodies) made.push(await Comment.create({ post_id: post.id, body }));

  return made;
}

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  for (const model of [Post, Comment]) model.resetColumnInformation();

  Post.associations = {};
  Post.hasMany("comments", () => Comment, { foreignKey: "post_id" });

  const schema = new SchemaStatements(connection);

  await schema.createTable("posts", (t) => {
    t.string("title");
  });
  await schema.createTable("comments", (t) => {
    t.integer("post_id");
    t.string("body");
  });

  post = await Post.create({ title: "a" });
});

describe("reading", () => {
  it("gives the ids of the collection", async () => {
    const [one, two] = await commentsNamed("one", "two");

    expect(await post.commentIds()).toEqual([one?.id, two?.id]);
  });

  it("gives nothing for an empty collection", async () => {
    expect(await post.commentIds()).toEqual([]);
  });

  it("gives only this record's", async () => {
    const [mine] = await commentsNamed("mine");
    const other = await Post.create({ title: "b" });

    await Comment.create({ post_id: other.id, body: "theirs" });

    expect(await post.commentIds()).toEqual([mine?.id]);
  });
});

describe("writing", () => {
  it("attaches the ones named", async () => {
    const loose = await Comment.create({ post_id: null, body: "loose" });

    await post.setCommentIds([loose.id]);

    expect(await post.commentIds()).toEqual([loose.id]);
  });

  it("detaches the ones left out", async () => {
    const [one, two] = await commentsNamed("one", "two");

    await post.setCommentIds([one?.id]);

    expect(await post.commentIds()).toEqual([one?.id]);
    expect((await Comment.find(two?.id)).post_id).toBeNull();
  });

  it("empties the collection when given nothing", async () => {
    await commentsNamed("one", "two");

    await post.setCommentIds([]);

    expect(await post.commentIds()).toEqual([]);
    expect(await Comment.all().count()).toBe(2);
  });

  /**
   * A checkbox list posts an empty string alongside the ticked ones, so that
   * unticking them all still submits the field.
   */
  it("ignores the blank a form sends", async () => {
    const [one] = await commentsNamed("one");

    await post.setCommentIds(["", one?.id, null]);

    expect(await post.commentIds()).toEqual([one?.id]);
  });

  it("takes an id as a string, the way a form supplies it", async () => {
    const [one] = await commentsNamed("one");

    await post.setCommentIds([String(one?.id)]);

    expect(await post.commentIds()).toEqual([one?.id]);
  });

  it("changes nothing when given what is already there", async () => {
    const [one, two] = await commentsNamed("one", "two");

    await post.setCommentIds([one?.id, two?.id]);

    expect(await post.commentIds()).toEqual([one?.id, two?.id]);
  });
});

describe("an id that is not there", () => {
  /**
   * Refused rather than quietly assigning the ones that exist. A form posting
   * an id that has since been deleted means the page was stale, and dropping
   * it silently writes a collection nobody chose.
   */
  it("refuses the whole assignment", async () => {
    const [one] = await commentsNamed("one");

    await expect(post.setCommentIds([one?.id, 9999])).rejects.toThrow(RecordNotFound);
  });

  it("says which id it could not find", async () => {
    await expect(post.setCommentIds([9999])).rejects.toThrow(/9999/);
  });

  it("leaves the collection as it was", async () => {
    const [one] = await commentsNamed("one");

    await expect(post.setCommentIds([9999])).rejects.toThrow(RecordNotFound);
    expect(await post.commentIds()).toEqual([one?.id]);
  });
});

describe("what happens to the ones dropped", () => {
  /**
   * The same rule a destroy follows. Nullifying a record the declaration says
   * should be deleted leaves rows an application believes are gone.
   */
  it("deletes them under delete_all", async () => {
    Post.associations = {};
    Post.hasMany("comments", () => Comment, { foreignKey: "post_id", dependent: "delete_all" });

    const [one, two] = await commentsNamed("one", "two");

    await post.setCommentIds([one?.id]);

    expect(await Comment.all().count()).toBe(1);
    expect(await Comment.where({ id: two?.id }).count()).toBe(0);
  });

  it("destroys them under destroy", async () => {
    Post.associations = {};
    Post.hasMany("comments", () => Comment, { foreignKey: "post_id", dependent: "destroy" });

    await commentsNamed("one", "two");

    await post.setCommentIds([]);

    expect(await Comment.all().count()).toBe(0);
  });

  /** Which is what `restrict` says: these may not be orphaned. */
  it("refuses under restrict", async () => {
    Post.associations = {};
    Post.hasMany("comments", () => Comment, { foreignKey: "post_id", dependent: "restrict" });

    await commentsNamed("one");

    await expect(post.setCommentIds([])).rejects.toThrow(DeleteRestricted);
  });

  it("nullifies them when nothing was declared", async () => {
    const [, two] = await commentsNamed("one", "two");

    await post.setCommentIds([]);

    expect((await Comment.find(two?.id)).post_id).toBeNull();
  });
});

describe("an unsaved record", () => {
  it("refuses, because a child needs an id to point at", async () => {
    const fresh = Post.build({ title: "unsaved" });

    await expect((fresh as unknown as Post).setCommentIds([1])).rejects.toThrow(/must be saved/);
  });
});
