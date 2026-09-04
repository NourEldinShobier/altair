/**
 * What a default scope does to a write, and what it deliberately does not.
 *
 * Rails lets a default scope seed `create`, so `Draft.create(...)` sets the
 * column the scope filters on. This does not — `defaultScope` says so in its
 * own comment: a scope is a statement about which rows you want to see, and
 * reading it as a statement about what to write is a second meaning nobody
 * asked for.
 *
 * The cases here pin that decision rather than assume it, because its
 * consequence is surprising in the other direction: a record created through a
 * default-scoped model can be one that model cannot then find. Somebody
 * changing this should have to change a test that says what they are giving up.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Model, SchemaStatements, setConnection } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { isSqlite, testConnection } from "./support/database.js";

interface PostRow {
  id: number;
  title: string;
  state: string | null;
}

class Post extends Model<PostRow>("posts") {}

class Draft extends Model<PostRow>("posts") {
  static {
    this.defaultScope((posts) => posts.where({ state: "draft" }));
  }
}

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  for (const model of [Post, Draft]) {
    model.resetColumnInformation();
  }

  await new SchemaStatements(connection).createTable("posts", (t) => {
    t.string("title");
    t.string("state");
  });

  await Post.create({ title: "A", state: "draft" });
  await Post.create({ title: "B", state: "live" });
});

afterEach(async () => {
  if (isSqlite) await connection.close();
});

describe("reading", () => {
  it("narrows to what the scope allows", async () => {
    expect(await Draft.all().count()).toBe(1);
    expect(await Post.all().count()).toBe(2);
  });

  it("is escaped by unscoped", async () => {
    expect(await Draft.unscoped().count()).toBe(2);
  });

  it("composes with a further condition", async () => {
    expect(await Draft.where({ title: "A" }).count()).toBe(1);
    expect(await Draft.where({ title: "B" }).count()).toBe(0);
  });
});

/**
 * A default scope fills in what `create` writes, from its equality conditions,
 * as Rails' does.
 *
 * This diverged for a while, on the reasoning that Rails' seeding is the most
 * complained-about behaviour in ActiveRecord. The reasoning did not survive
 * the alternative: `Draft.create(...)` made a record `Draft` could not find,
 * which reads as a persistence bug rather than as a scope doing its job. The
 * complaints are about scopes used to filter rather than to define, which the
 * Rails guides themselves warn against.
 */
describe("writing", () => {
  it("fills in the column the scope filters on", async () => {
    const draft = await Draft.create({ title: "C" });

    expect(draft.state).toBe("draft");
  });

  /** The point of the change: a record made through a scope is one it can find. */
  it("so the new record is visible to the model that made it", async () => {
    await Draft.create({ title: "C" });

    expect(await Draft.all().count()).toBe(2);
    expect(await Draft.unscoped().count()).toBe(3);
  });

  /**
   * Rails seeds from a Hash condition and not from a string or an array, since
   * there is no one value those mean. The same rule falls out here for free:
   * a clause records the value it compared against only when there was one.
   */
  it("seeds nothing from a condition with no single value", async () => {
    class Recent extends Model<PostRow>("posts") {
      static {
        this.defaultScope((posts) => posts.where("state != ?", "archived"));
      }
    }
    Recent.resetColumnInformation();

    expect((await Recent.create({ title: "D" })).state).toBeNull();
  });

  it("keeps a value that was given, including one the scope would exclude", async () => {
    const post = await Draft.create({ title: "C", state: "live" });

    expect(post.state).toBe("live");
  });

  // The two paths agree now. They did not: `Draft.all().create()` seeded from
  // the scope and `Draft.create()` did not, so the same record came out
  // differently depending on which was called.
  it("agrees with what a relation's own create does", async () => {
    const post = await Post.where({ state: "draft" }).create({ title: "C" });

    expect(post.state).toBe("draft");
    expect(await Draft.all().count()).toBe(2);
  });
});
