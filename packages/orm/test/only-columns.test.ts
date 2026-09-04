/**
 * `onlyColumns`, ported from `only_columns` in
 * `activerecord/lib/active_record/model_schema.rb` and the "only columns are
 * enumerated in SELECT" case in `activerecord/test/cases/base_test.rb`.
 *
 * `ignoreColumns` was here and this was not, and they are not the same tool
 * pointed in opposite directions. `ignoreColumns` is for a column on its way
 * out: named once, dropped, list back to empty. This is for a table that is
 * not going to change — the wide one another system owns, where the model
 * wants six of forty columns.
 *
 * The difference is what happens to a column nobody mentioned. Under
 * `ignoreColumns` it arrives, gets an accessor and joins every `SELECT`; under
 * this it does not exist. Only the second still holds the day the other system
 * ships a migration.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Connection, setConnection } from "../src/connection.js";
import { testConnection } from "./support/database.js";
import { SchemaStatements } from "../src/schema.js";
import { Model } from "../src/model.js";

interface DeveloperRow {
  id: number;
  name: string;
  first_name: string;
  salary: number;
}

let connection: Connection;

function developerClass(): typeof Model<DeveloperRow> extends never ? never : any {
  return class Developer extends Model<DeveloperRow>("developers") {
    declare id: number;
    declare name: string;
    declare first_name: string;
    declare salary: number;
  };
}

function timestampedClass(): any {
  return class Timestamped extends Model<{ id: number; name: string; updated_at: Date }>(
    "timestamped",
  ) {
    declare id: number;
    declare name: string;
  };
}

// A fresh class per test: `onlyColumns` is class-level state, and a shared
// class would make the order the tests happen to run in part of the result.
let Developer: ReturnType<typeof developerClass>;
let Timestamped: ReturnType<typeof timestampedClass>;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  Developer = developerClass();
  Timestamped = timestampedClass();

  await new SchemaStatements(connection).createTable("developers", (t) => {
    t.string("name");
    t.string("first_name");
    t.integer("salary");
  });
  await new SchemaStatements(connection).createTable("timestamped", (t) => {
    t.string("name");
    t.datetime("updated_at");
  });
});

describe("the columns the model knows about", () => {
  it("is the ones named, and nothing else", async () => {
    Developer.onlyColumns("id", "name");

    expect(await Developer.columnNames()).toEqual(["id", "name"]);
  });

  it("is every column when nothing was named", async () => {
    expect(await Developer.columnNames()).toEqual(["id", "name", "first_name", "salary"]);
  });

  it("keeps the table's own order, not the order they were listed in", async () => {
    Developer.onlyColumns("salary", "id", "name");

    expect(await Developer.columnNames()).toEqual(["id", "name", "salary"]);
  });

  it("ignores a name that is not a column", async () => {
    Developer.onlyColumns("id", "name", "nonexistent");

    expect(await Developer.columnNames()).toEqual(["id", "name"]);
  });

  it("adds to what an earlier call named", async () => {
    Developer.onlyColumns("id");
    Developer.onlyColumns("salary");

    expect(await Developer.columnNames()).toEqual(["id", "salary"]);
  });

  /** The cache is read once per class, so naming columns has to clear it. */
  it("takes effect after the columns have already been read", async () => {
    expect(await Developer.columnNames()).toHaveLength(4);

    Developer.onlyColumns("id", "name");

    expect(await Developer.columnNames()).toEqual(["id", "name"]);
  });
});

describe("what the restriction reaches", () => {
  /**
   * A column the model does not have is a mistake, and saying so is the point:
   * a `first_name` left in an `updateColumns` after the column was walled off
   * would otherwise write to a column this class claims not to know.
   */
  it("makes a column left out unknown to updateColumns", async () => {
    const developer = await Developer.create({ name: "david" });

    Developer.onlyColumns("id", "name");

    await expect(developer.updateColumns({ first_name: "David" } as never)).rejects.toThrow(
      /Invalid column name: first_name/,
    );
  });

  it("leaves a column that was named alone", async () => {
    const developer = await Developer.create({ name: "david" });

    Developer.onlyColumns("id", "name");

    expect(await developer.updateColumns({ name: "dave" } as never)).toBe(true);
  });

  it("makes it unknown to incrementCounter too", async () => {
    const developer = await Developer.create({ name: "david", salary: 1 });

    Developer.onlyColumns("id", "name");

    await expect(Developer.incrementCounter("salary", developer.id)).rejects.toThrow(
      /Invalid column name: salary/,
    );
  });

  /**
   * Timestamps are maintained only for columns the model has. Walling off
   * `updated_at` therefore stops it being written, which is the behaviour a
   * read-mostly view of somebody else's table wants and the reason this is not
   * only a validation list.
   */
  it("stops a timestamp column that was left out from being written", async () => {
    Timestamped.onlyColumns("id", "name");

    const row = await Timestamped.create({ name: "david" });

    expect((row as unknown as { updated_at: unknown }).updated_at).toBeNull();
  });

  it("writes it when it was named", async () => {
    Timestamped.onlyColumns("id", "name", "updated_at");

    const row = await Timestamped.create({ name: "david" });

    expect((row as unknown as { updated_at: unknown }).updated_at).toBeDefined();
  });
});

describe("with ignoreColumns", () => {
  /**
   * Rails refuses the pair rather than picking one. They disagree about every
   * column neither of them names, and the disagreement is silent: the model
   * reads a column the author believed was excluded, or does not read one they
   * believed was kept.
   */
  it("is refused, whichever came first", () => {
    Developer.onlyColumns("id", "name");

    expect(() => Developer.ignoreColumns("salary")).toThrow(/both/);
  });

  it("is refused the other way round too", () => {
    Developer.ignoreColumns("salary");

    expect(() => Developer.onlyColumns("id", "name")).toThrow(/both/);
  });

  it("leaves ignoreColumns working on its own", async () => {
    Developer.ignoreColumns("first_name");

    expect(await Developer.columnNames()).toEqual(["id", "name", "salary"]);
  });
});

describe("a subclass", () => {
  it("inherits what the parent allowed", async () => {
    Developer.onlyColumns("id", "name");

    class Senior extends Developer {}

    expect(await Senior.columnNames()).toEqual(["id", "name"]);
  });

  /**
   * The copy-on-write that makes inheritance usable: a subclass naming another
   * column must not name it for the parent as well.
   */
  it("does not widen the parent by naming more", async () => {
    Developer.onlyColumns("id", "name");

    class Senior extends Developer {}
    Senior.onlyColumns("salary");

    expect(await Senior.columnNames()).toEqual(["id", "name", "salary"]);
    expect(await Developer.columnNames()).toEqual(["id", "name"]);
  });
});
