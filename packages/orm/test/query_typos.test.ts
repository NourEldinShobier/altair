/**
 * What a query builder does with a word it does not recognise.
 *
 * Both of these silently did the wrong thing, which is worse than refusing:
 * the caller asked for something, got something else, and nothing anywhere
 * said so. Neither was an injection — the payloads were escaped correctly —
 * they were found while checking that they were.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Model, SchemaStatements, setConnection } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { isSqlite, testConnection } from "./support/database.js";

interface PostRow {
  id: number;
  title: string;
}

class Post extends Model<PostRow>("posts") {}

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  Post.columnCache = undefined;
  Post.columnTypeCache = undefined;

  await new SchemaStatements(connection).createTable("posts", (t) => t.string("title"));

  for (const title of ["B", "A", "C"]) await Post.create({ title });
});

afterEach(async () => {
  if (isSqlite) await connection.close();
});

/**
 * A sort direction is usually a query parameter — `?sort=title&dir=descending`
 * — so the compiler has nothing to say about it. `descending` became `ASC`,
 * and a list asked to sort one way silently sorted the other.
 */
describe("a sort direction it does not know", () => {
  const ordering = (direction: string) =>
    (
      Post.all() as unknown as { order(c: string, d: string): { toArray(): Promise<PostRow[]> } }
    ).order("title", direction);

  const ordered = (direction: string) => ordering(direction).toArray();

  // Thrown while the relation is being built rather than when it runs, so the
  // mistake is reported where it was made.
  it("is refused rather than treated as ascending", () => {
    expect(() => ordering("descending")).toThrow(/Unknown sort direction/);
  });

  it("says what it expected", () => {
    expect(() => ordering("descending")).toThrow(/"asc" or "desc"/);
  });

  it("still takes the two it knows", async () => {
    expect((await ordered("asc")).map((post) => post.title)).toEqual(["A", "B", "C"]);
    expect((await ordered("desc")).map((post) => post.title)).toEqual(["C", "B", "A"]);
  });

  it("still defaults to ascending when given nothing", async () => {
    expect((await Post.all().order("title").toArray()).map((post) => post.title)).toEqual([
      "A",
      "B",
      "C",
    ]);
  });
});

/**
 * Rails raises here too. `unscope("wheres")` is one plural away from the right
 * word, and it left the conditions in place while reporting success.
 */
describe("a clause it does not know", () => {
  const unscoping = (clause: string) =>
    (
      Post.where({ title: "A" }) as unknown as {
        unscope(c: string): { toArray(): Promise<PostRow[]> };
      }
    ).unscope(clause);

  const unscoped = (clause: string) => unscoping(clause).toArray();

  it("is refused rather than ignored", () => {
    expect(() => unscoping("wheres")).toThrow(/Unknown clause/);
  });

  it("lists the ones it knows", () => {
    expect(() => unscoping("wheres")).toThrow(/where, order, limit/);
  });

  it("still removes one it knows", async () => {
    expect(await unscoped("where")).toHaveLength(3);
  });

  it("still removes several at once", async () => {
    const relation = Post.where({ title: "A" }).order("title").limit(1);

    expect(await relation.unscope("where", "limit").toArray()).toHaveLength(3);
  });
});
