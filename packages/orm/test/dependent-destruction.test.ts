/**
 * What a `dependent:` option does to the rows, ported from the
 * `dependent_destroy`, `dependent_delete_all` and `dependent_restrict` cases
 * in `activerecord/test/cases/associations/has_many_associations_test.rb`.
 *
 * `model.ts` used to handle two options with a pair of `if`s and let
 * everything else fall past them into the nullify at the bottom. Three of the
 * six did that: `delete`, `delete_all` and `destroy_async` all left the
 * children alive with a null foreign key, where the caller had asked for them
 * to be gone. Every one passed `checkDependentOptions` on the way in — the
 * function whose own comment says it exists because "Rails accepts an option a
 * macro cannot honour and does nothing with it, which reads as configured and
 * is not".
 *
 * And the order was whatever order the associations were declared in. A
 * `restrict` declared after a `destroy` refused the destroy *after* the other
 * association's children were already gone: the caller sees an exception,
 * assumes nothing happened, and the rows are not coming back.
 *
 * `inheritance.ts` had both answers — `handleDependency` maps an option to an
 * action, `destroyAssociations` puts every refusal first — and nothing called
 * either.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Connection, setConnection } from "../src/connection.js";
import { testConnection } from "./support/database.js";
import { SchemaStatements } from "../src/schema.js";
import { beforeDestroy, DeleteRestricted, Model } from "../src/index.js";
import { InvalidDependentOption } from "../src/inheritance.js";

interface PostRow {
  id: number;
  title: string;
}

interface ChildRow {
  id: number;
  post_id: number | null;
  body: string;
}

class Post extends Model<PostRow>("posts") {
  declare id: number;
  declare title: string;
  declare comments: () => Promise<Comment[]>;
  declare locks: () => Promise<Lock[]>;
}

let ranCallbacks = 0;

class Comment extends Model<ChildRow>("comments") {
  declare id: number;
  declare post_id: number | null;
  declare body: string;
  declare post: () => Promise<Post | null>;

  @beforeDestroy
  countIt(): void {
    ranCallbacks += 1;
  }
}

class Lock extends Model<ChildRow>("locks") {
  declare id: number;
  declare post_id: number | null;
  declare body: string;
}

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  for (const model of [Post, Comment, Lock]) {
    model.resetColumnInformation();
  }

  Post.associations = {};

  const schema = new SchemaStatements(connection);

  await schema.createTable("posts", (t) => {
    t.string("title");
  });

  for (const name of ["comments", "locks"]) {
    await schema.createTable(name, (t) => {
      t.integer("post_id");
      t.string("body");
    });
  }
});

/** A post with one comment, destroyed under the given option. */
async function destroyUnder(option: string): Promise<ChildRow[]> {
  Post.hasMany("comments", () => Comment, {
    foreignKey: "post_id",
    dependent: option as never,
  });

  const post = await Post.create({ title: "a" });
  await Comment.create({ post_id: post.id, body: "c" });
  await post.destroy();

  return await Comment.all().toArray();
}

describe("destroy", () => {
  it("takes the children with it", async () => {
    expect(await destroyUnder("destroy")).toHaveLength(0);
  });
});

describe("nullify", () => {
  it("leaves the children with no parent", async () => {
    const left = await destroyUnder("nullify");

    expect(left).toHaveLength(1);
    expect(left[0]?.post_id).toBeNull();
  });
});

describe("delete_all", () => {
  /** The regression: these used to survive with a null key. */
  it("takes the children with it", async () => {
    expect(await destroyUnder("delete_all")).toHaveLength(0);
  });

  /**
   * Without running the children's own callbacks, which is what the option
   * asks for and also its hazard — a child that owns an upload or children of
   * its own leaves both behind. That is why it is a separate option rather
   * than a speed setting on `destroy`, and it is the whole observable
   * difference between the two.
   */
  it("does not run the children's callbacks, where destroy does", async () => {
    async function destroyFive(option: "destroy" | "delete_all"): Promise<number> {
      Post.associations = {};
      Post.hasMany("comments", () => Comment, { foreignKey: "post_id", dependent: option });

      const post = await Post.create({ title: option });
      for (let i = 0; i < 5; i += 1) {
        await Comment.create({ post_id: post.id, body: `c${String(i)}` });
      }

      ranCallbacks = 0;
      await post.destroy();

      return ranCallbacks;
    }

    expect(await destroyFive("destroy")).toBe(5);
    expect(await destroyFive("delete_all")).toBe(0);
    expect(await Comment.all().toArray()).toHaveLength(0);
  });
});

describe("an option nothing can honour", () => {
  /** Refused where it is written, not silently turned into a nullify. */
  it("is refused at the declaration", () => {
    expect(() =>
      Post.hasMany("comments", () => Comment, {
        foreignKey: "post_id",
        dependent: "destroy_async" as never,
      }),
    ).toThrow(InvalidDependentOption);
  });

  it("is refused on a belongsTo, which the destroy path skips", () => {
    expect(() =>
      Comment.belongsTo("post", () => Post, {
        foreignKey: "post_id",
        dependent: "destroy" as never,
      }),
    ).toThrow(InvalidDependentOption);
  });
});

describe("restrict", () => {
  it("refuses when there are children", async () => {
    Post.hasMany("locks", () => Lock, { foreignKey: "post_id", dependent: "restrict" });

    const post = await Post.create({ title: "a" });
    await Lock.create({ post_id: post.id, body: "l" });

    await expect(post.destroy()).rejects.toThrow(DeleteRestricted);
    expect(await Post.all().toArray()).toHaveLength(1);
  });

  it("allows it when there are none", async () => {
    Post.hasMany("locks", () => Lock, { foreignKey: "post_id", dependent: "restrict" });

    await (await Post.create({ title: "a" })).destroy();

    expect(await Post.all().toArray()).toHaveLength(0);
  });

  /**
   * The regression that costs rows. Declared second, the refusal used to
   * arrive with the comments already destroyed — and a caller who sees an
   * exception assumes nothing happened.
   */
  it("refuses before anything else has been destroyed", async () => {
    Post.hasMany("comments", () => Comment, { foreignKey: "post_id", dependent: "destroy" });
    Post.hasMany("locks", () => Lock, { foreignKey: "post_id", dependent: "restrict" });

    const post = await Post.create({ title: "a" });
    await Comment.create({ post_id: post.id, body: "c" });
    await Lock.create({ post_id: post.id, body: "l" });

    await expect(post.destroy()).rejects.toThrow(DeleteRestricted);

    expect(await Comment.all().toArray()).toHaveLength(1);
    expect(await Post.all().toArray()).toHaveLength(1);
  });

  it("does the same when it is a delete_all that would have run", async () => {
    Post.hasMany("comments", () => Comment, { foreignKey: "post_id", dependent: "delete_all" });
    Post.hasMany("locks", () => Lock, { foreignKey: "post_id", dependent: "restrict" });

    const post = await Post.create({ title: "a" });
    await Comment.create({ post_id: post.id, body: "c" });
    await Lock.create({ post_id: post.id, body: "l" });

    await expect(post.destroy()).rejects.toThrow(DeleteRestricted);
    expect(await Comment.all().toArray()).toHaveLength(1);
  });
});

describe("an association with no dependent", () => {
  it("leaves the children exactly as they were", async () => {
    Post.hasMany("comments", () => Comment, { foreignKey: "post_id" });

    const post = await Post.create({ title: "a" });
    await Comment.create({ post_id: post.id, body: "c" });
    await post.destroy();

    const left = await Comment.all().toArray();

    expect(left).toHaveLength(1);
    expect(left[0]?.post_id).toBe(post.id);
  });
});
