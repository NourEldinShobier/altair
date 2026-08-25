/**
 * Touching records.
 *
 * Mirrors activerecord/test/cases/touch_later_test.rb and the `touch: true`
 * half of associations_test.rb. The tests that matter are the ones tying it to
 * `cacheKey`, since keeping a parent's cache key honest is the reason the
 * option exists at all.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Connection, Model, SchemaStatements, setConnection } from "../src/index.js";
import { travelTo } from "@altair/support";

interface PostRow {
  id: number;
  title: string;
  comments_count: number;
  created_at: Date;
  updated_at: Date;
  published_at: Date | null;
}

interface CommentRow {
  id: number;
  post_id: number | null;
  body: string;
  created_at: Date;
  updated_at: Date;
}

class Post extends Model<PostRow>("posts") {}

class Comment extends Model<CommentRow>("comments") {
  declare post: Post;

  static {
    this.belongsTo("post", () => Post, { touch: true });
  }
}

class Bare extends Model<{ id: number; name: string }>("bares") {}

let connection: Connection;

beforeEach(async () => {
  connection = new Connection(process.env.DATABASE_URL ?? "sqlite://:memory:");
  setConnection(connection);

  for (const model of [Post, Comment, Bare]) {
    model.columnCache = undefined;
    model.columnTypeCache = undefined;
  }

  const schema = new SchemaStatements(connection);

  for (const table of ["comments", "posts", "bares"]) {
    await schema.dropTable(table, { ifExists: true });
  }

  await schema.createTable("posts", (t) => {
    t.string("title");
    t.integer("comments_count", { default: 0 });
    t.datetime("created_at");
    t.datetime("updated_at");
    t.datetime("published_at");
  });

  await schema.createTable("comments", (t) => {
    t.bigint("post_id");
    t.text("body");
    t.datetime("created_at");
    t.datetime("updated_at");
  });

  await schema.createTable("bares", (t) => {
    t.string("name");
  });
});

/**
 * Pushes a row's clock into the past.
 *
 * Timestamps are written to whole seconds, so proving one moved would
 * otherwise mean sleeping a second per assertion — six seconds in this file,
 * on each of three adapters. Backdating the row instead makes the same point
 * instantly, and `updateAll` is the blunt write that does not re-stamp.
 */
const OLD = new Date("2020-01-01T00:00:00Z");

const backdate = async (post: Post): Promise<void> => {
  await Post.where({ id: post.id }).updateAll({ updated_at: OLD });
};

const reload = async (post: Post) => await Post.find(post.id);

/** Whether the row's clock has moved off the backdated value. */
const moved = async (post: Post): Promise<boolean> => {
  const now = (await reload(post)).updated_at as Date;
  return new Date(now).getTime() !== OLD.getTime();
};

describe("touching a record", () => {
  it("moves updated_at", async () => {
    const post = await Post.create({ title: "Hello" });
    await backdate(post);

    await post.touch();

    expect(await moved(post)).toBe(true);
  });

  it("moves the record in memory too, not just the row", async () => {
    const post = await Post.create({ title: "Hello" });
    post.updated_at = OLD;

    await post.touch();

    expect(post.updated_at).not.toEqual(OLD);
  });

  it("moves other columns it is given", async () => {
    const post = await Post.create({ title: "Hello" });
    await post.touch("published_at");

    expect((await reload(post)).published_at).toBeTruthy();
  });

  // The point of touch rather than save: move the clock without writing
  // whatever else is half-edited in memory.
  it("writes nothing else", async () => {
    const post = await Post.create({ title: "Hello" });
    post.title = "Edited but not saved";

    await post.touch();

    expect((await reload(post)).title).toBe("Hello");
  });

  it("leaves the record clean afterwards", async () => {
    const post = await Post.create({ title: "Hello" });
    await post.touch();

    expect(post.hasChanged()).toBe(false);
  });

  it("refuses a record that was never saved", async () => {
    await expect(Post.build({ title: "Hello" }).touch()).rejects.toThrow(/not been saved/);
  });

  it("refuses a column the table does not have", async () => {
    const post = await Post.create({ title: "Hello" });

    await expect(post.touch("nonexistent")).rejects.toThrow(/no such column/);
  });

  it("does nothing for a table with no timestamps", async () => {
    const bare = await Bare.create({ name: "x" });
    await expect(bare.touch()).resolves.toBeUndefined();
  });
});

// The reason the option exists: a page cached under `posts/1-…` would keep
// showing yesterday's comments, because adding one does not change the post.
describe("keeping a cache key honest", () => {
  it("changes the parent's cache key", async () => {
    const post = await Post.create({ title: "Hello" });
    await backdate(post);
    const before = (await reload(post)).cacheKey();

    await Comment.create({ post_id: post.id, body: "first" });

    expect((await reload(post)).cacheKey()).not.toBe(before);
  });

  // Found by running a real application rather than by testing a unit: the key
  // was cut to whole seconds, so a record touched twice in the same second
  // kept the same key and every cache downstream went on serving the old
  // content. Two comments arriving together is not unusual.
  // Held rather than slept through. The clock is the thing under test, so
  // moving it is more honest than waiting for it — and it is the difference
  // between a test that takes a millisecond and one that takes two.
  it("changes even when touched twice in the same second", async () => {
    const post = await travelTo(new Date("2026-06-01T12:00:00.000Z"), async () =>
      Post.create({ title: "Hello" }),
    );
    const before = post.cacheKey();

    await travelTo(new Date("2026-06-01T12:00:00.400Z"), async () => {
      await post.touch();
    });

    expect(post.cacheKey()).not.toBe(before);
  });

  it("carries milliseconds, which is what makes that possible", async () => {
    const post = await Post.create({ title: "Hello" });

    expect(post.cacheKey()).toMatch(/^posts\/\d+-\d{17}$/);
  });
});

describe("touch: true on belongsTo", () => {
  it("touches the parent when a child is created", async () => {
    const post = await Post.create({ title: "Hello" });
    await backdate(post);

    await Comment.create({ post_id: post.id, body: "first" });

    expect(await moved(post)).toBe(true);
  });

  it("touches it when a child is updated", async () => {
    const post = await Post.create({ title: "Hello" });
    const comment = await Comment.create({ post_id: post.id, body: "first" });
    await backdate(post);

    await comment.update({ body: "edited" });

    expect(await moved(post)).toBe(true);
  });

  // A removed comment changes the rendered post exactly as much as an added
  // one, so the cache has to know about it either way.
  it("touches it when a child is destroyed", async () => {
    const post = await Post.create({ title: "Hello" });
    const comment = await Comment.create({ post_id: post.id, body: "first" });
    await backdate(post);

    await comment.destroy();

    expect(await moved(post)).toBe(true);
  });

  it("does nothing for a child with no parent", async () => {
    await expect(Comment.create({ post_id: null, body: "orphan" })).resolves.toBeDefined();
  });

  it("leaves the counter cache alone", async () => {
    const post = await Post.create({ title: "Hello" });
    await Comment.create({ post_id: post.id, body: "first" });

    // Declared without counterCache here, so it should stay where it started.
    expect((await reload(post)).comments_count).toBe(0);
  });
});
