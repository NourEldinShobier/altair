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
    model.columnCache = undefined;
    model.columnTypeCache = undefined;
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
 * The deliberate divergence. Rails would set `state: "draft"` here.
 *
 * The trade is stated rather than hidden: a create fills in only what it was
 * given, and the cost is the case below it.
 */
describe("writing", () => {
  it("does not fill in the column the scope filters on", async () => {
    const draft = await Draft.create({ title: "C" });

    expect(draft.state).toBeNull();
  });

  /**
   * The consequence, spelled out. A record made through a default-scoped model
   * is not necessarily one that model can find — which is the price of the
   * decision above, and the reason anybody revisiting it should start here.
   */
  it("so the new record is not visible to the model that made it", async () => {
    await Draft.create({ title: "C" });

    expect(await Draft.all().count()).toBe(1);
    expect(await Draft.unscoped().count()).toBe(3);
  });

  it("keeps a value that was given, including one the scope would exclude", async () => {
    const post = await Draft.create({ title: "C", state: "live" });

    expect(post.state).toBe("live");
  });

  // The way to get Rails' behaviour, and one line rather than a framework
  // decision: the relation seeds what it builds from its own conditions.
  it("is what a relation's own create already does", async () => {
    const post = await Post.where({ state: "draft" }).create({ title: "C" });

    expect(post.state).toBe("draft");
    expect(await Draft.all().count()).toBe(2);
  });
});
