/**
 * `resetColumnInformation`, ported from
 * `activerecord/lib/active_record/model_schema.rb` and the
 * `test_reset_column_information` cases in
 * `activerecord/test/cases/base_test.rb`.
 *
 * A migration has run and the table is no longer the one this class read at
 * boot. Rails documents the method for exactly that, and a test suite that
 * builds a schema per case is the same situation four hundred times over.
 *
 * One call rather than two assignments, and the difference is not keystrokes.
 * There are two caches today, and the next one added would otherwise have to
 * be found at every place that clears them — a hundred and sixteen of them,
 * most in tests. A test that clears two of three passes while asking the
 * wrong schema, which is the quietest way a suite can be wrong.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Connection, setConnection } from "../src/connection.js";
import { testConnection } from "./support/database.js";
import { SchemaStatements } from "../src/schema.js";
import { Model } from "../src/model.js";

interface PostRow {
  id: number;
  title: string;
}

class Post extends Model<PostRow>("posts") {
  declare id: number;
  declare title: string;
}

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);
  Post.resetColumnInformation();

  await new SchemaStatements(connection).createTable("posts", (t) => {
    t.string("title");
  });
});

describe("after a column is added", () => {
  /** The situation the method exists for: the class read the old table. */
  it("finds it once the class has been told to forget", async () => {
    expect(await Post.columnNames()).not.toContain("body");

    await new SchemaStatements(connection).addColumn("posts", "body", "text");
    Post.resetColumnInformation();

    expect(await Post.columnNames()).toContain("body");
  });

  it("does not find it while the class still remembers", async () => {
    await Post.columnNames();
    await new SchemaStatements(connection).addColumn("posts", "body", "text");

    expect(await Post.columnNames()).not.toContain("body");
  });

  it("reads the new column's type too, not only its name", async () => {
    await Post.columnTypes();
    await new SchemaStatements(connection).addColumn("posts", "views", "integer");
    Post.resetColumnInformation();

    expect((await Post.columnTypes())["views"]).toBe("integer");
  });
});

describe("what it clears", () => {
  /**
   * Both caches, which is the whole point of having a method: clearing the
   * names and leaving the types is a class that agrees a column exists and
   * disagrees about what is in it.
   */
  it("clears the names and the types together", async () => {
    await Post.columnNames();
    await Post.columnTypes();

    Post.resetColumnInformation();

    expect(Post.columnCache).toBeUndefined();
    expect(Post.columnTypeCache).toBeUndefined();
  });

  it("can be called when there was nothing to clear", () => {
    Post.resetColumnInformation();

    expect(() => {
      Post.resetColumnInformation();
    }).not.toThrow();
  });
});

describe("ignoring a column", () => {
  /** Which is a change to what the class should read, so it clears too. */
  it("takes effect without a caller clearing anything", async () => {
    expect(await Post.columnNames()).toContain("title");

    Post.ignoreColumns("title");

    expect(await Post.columnNames()).not.toContain("title");

    Post.ignoredColumns = [];
    Post.resetColumnInformation();
  });
});
