/**
 * Optimistic locking.
 *
 * Mirrors activerecord/test/cases/locking_test.rb's optimistic half, which had
 * no counterpart here — the implementation existed and nothing exercised it.
 *
 * The problem it solves is the lost update. Two people open the same record,
 * both save, and the second write lands on top of the first with no sign that
 * anything was lost: no error, no conflict, and a user whose edit simply is
 * not there. Optimistic locking notices after the fact and makes the second
 * writer retry; the pessimistic kind, in locking.test.ts, prevents it up front
 * by making them wait.
 *
 * Runs against whatever `DATABASE_URL` names, so the three adapters are
 * checked rather than assumed — the whole feature turns on how many rows an
 * UPDATE reports having touched.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import {
  Connection,
  Model,
  SchemaStatements,
  StaleObjectError,
  setConnection,
} from "../src/index.js";
import { testConnection } from "./support/database.js";

interface PostRow {
  id: number;
  title: string;
  lock_version: number;
}

/** A table with no locking column, to prove the feature stays out of the way. */
interface NoteRow {
  id: number;
  body: string;
}

class Post extends Model<PostRow>("posts") {}
class Note extends Model<NoteRow>("notes") {}

let connection: Connection;

/** The same row, read twice — which is what two people with a browser are. */
const readAgain = async (post: Post): Promise<Post> => (await Post.findBy({ id: post.id })) as Post;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  for (const model of [Post, Note]) {
    model.columnCache = undefined;
    model.columnTypeCache = undefined;
  }

  const schema = new SchemaStatements(connection);

  await schema.dropTable("posts", { ifExists: true });
  await schema.createTable("posts", (t) => {
    t.string("title");
    t.integer("lock_version", { default: 0 });
  });

  await schema.dropTable("notes", { ifExists: true });
  await schema.createTable("notes", (t) => {
    t.string("body");
  });
});

describe("the version", () => {
  it("starts at zero", async () => {
    const post = await Post.create({ title: "one" });

    expect(post.lock_version).toBe(0);
  });

  it("moves on every save that writes", async () => {
    const post = await Post.create({ title: "one" });

    post.title = "two";
    await post.save();
    expect(post.lock_version).toBe(1);

    post.title = "three";
    await post.save();
    expect(post.lock_version).toBe(2);
  });

  // A save with nothing to write is not a write, and a version that moved
  // would make every other copy stale for no reason.
  it("stays put when a save has nothing to write", async () => {
    const post = await Post.create({ title: "one" });

    post.title = "two";
    await post.save();
    await post.save();

    expect(post.lock_version).toBe(1);
  });

  it("comes back current after a reload", async () => {
    const post = await Post.create({ title: "one" });
    const other = await readAgain(post);

    post.title = "changed";
    await post.save();

    await other.reload();

    expect(other.lock_version).toBe(1);
  });
});

// The lost update, and the whole reason for the column.
describe("two writers", () => {
  it("lets the first one through", async () => {
    const post = await Post.create({ title: "one" });
    const second = await readAgain(post);

    post.title = "from the first";
    await post.save();

    expect(second.lock_version).toBe(0);
  });

  it("refuses the second", async () => {
    const post = await Post.create({ title: "one" });
    const second = await readAgain(post);

    post.title = "from the first";
    await post.save();

    second.title = "from the second";

    expect(second.save()).rejects.toBeInstanceOf(StaleObjectError);
  });

  // The point of refusing: what the first writer saved is still there.
  it("leaves the first writer's work alone", async () => {
    const post = await Post.create({ title: "one" });
    const second = await readAgain(post);

    post.title = "from the first";
    await post.save();

    second.title = "from the second";
    await second.save().catch(() => undefined);

    expect((await readAgain(post)).title).toBe("from the first");
  });

  it("says which record went stale", async () => {
    const post = await Post.create({ title: "one" });
    const second = await readAgain(post);

    post.title = "changed";
    await post.save();
    second.title = "conflicting";

    expect(second.save()).rejects.toThrow(/Post/);
  });

  // Rereading is how a caller recovers, and it has to actually work.
  it("goes through once the second writer catches up", async () => {
    const post = await Post.create({ title: "one" });
    const second = await readAgain(post);

    post.title = "from the first";
    await post.save();

    await second.reload();
    second.title = "from the second";
    await second.save();

    expect((await readAgain(post)).title).toBe("from the second");
  });
});

// Deleting a record is acting on it just as much as updating one, and the
// version was missing from the WHERE clause: somebody opened a record,
// somebody else changed it, and the first could still delete what they were
// looking at a version of.
describe("deleting", () => {
  it("refuses a record that has moved on", async () => {
    const post = await Post.create({ title: "one" });
    const stale = await readAgain(post);

    post.title = "changed";
    await post.save();

    expect(stale.destroy()).rejects.toBeInstanceOf(StaleObjectError);
  });

  it("leaves the row where it was", async () => {
    const post = await Post.create({ title: "one" });
    const stale = await readAgain(post);

    post.title = "changed";
    await post.save();
    await stale.destroy().catch(() => undefined);

    expect(await Post.findBy({ id: post.id })).not.toBeNull();
  });

  it("goes through on a current record", async () => {
    const post = await Post.create({ title: "one" });

    expect(await post.destroy()).toBe(true);
    expect(await Post.findBy({ id: post.id })).toBeNull();
  });

  it("goes through after a reload", async () => {
    const post = await Post.create({ title: "one" });
    const stale = await readAgain(post);

    post.title = "changed";
    await post.save();

    await stale.reload();

    expect(await stale.destroy()).toBe(true);
  });
});

describe("a table with no locking column", () => {
  it("saves without a version", async () => {
    const note = await Note.create({ body: "one" });

    note.body = "two";

    expect(await note.save()).toBe(true);
  });

  // Nothing to compare, so the last write wins — which is the behaviour every
  // table had before anybody added the column.
  it("lets the second writer through", async () => {
    const note = await Note.create({ body: "one" });
    const second = (await Note.findBy({ id: note.id })) as Note;

    note.body = "from the first";
    await note.save();

    second.body = "from the second";
    await second.save();

    expect(((await Note.findBy({ id: note.id })) as Note).body).toBe("from the second");
  });

  it("deletes without a version", async () => {
    const note = await Note.create({ body: "one" });

    expect(await note.destroy()).toBe(true);
  });
});

// `updateAll` writes straight to the table, skipping callbacks, validations
// and this. Rails draws the line in the same place, and a test says so rather
// than leaving the next reader to find out.
describe("what updateAll does", () => {
  it("does not move the version", async () => {
    const post = await Post.create({ title: "one" });

    await Post.where({ id: post.id }).updateAll({ title: "written directly" });

    expect((await readAgain(post)).lock_version).toBe(0);
  });

  it("leaves a record read before it looking current", async () => {
    const post = await Post.create({ title: "one" });
    const held = await readAgain(post);

    await Post.where({ id: post.id }).updateAll({ title: "written directly" });

    held.title = "from the record";
    await held.save();

    expect((await readAgain(post)).title).toBe("from the record");
  });
});
