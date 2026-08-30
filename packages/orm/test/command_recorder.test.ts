/**
 * Migration reversibility, ported from
 * `activerecord/test/cases/migration/command_recorder_test.rb`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SchemaStatements, setConnection } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { isSqlite, testConnection } from "./support/database.js";
import {
  CommandRecorder,
  IrreversibleMigration,
  invert,
  invertAll,
  replay,
  replayInverted,
} from "../src/command_recorder.js";

describe("recording", () => {
  it("remembers what it was asked for", () => {
    const recorder = new CommandRecorder();
    recorder.addColumn("posts", "title", "string");

    expect(recorder.commands).toEqual([
      { name: "addColumn", args: ["posts", "title", "string", undefined] },
    ]);
  });

  it("keeps them in order", () => {
    const recorder = new CommandRecorder();
    recorder.addColumn("posts", "title", "string");
    recorder.addIndex("posts", ["title"]);

    expect(recorder.commands.map((one) => one.name)).toEqual(["addColumn", "addIndex"]);
  });

  it("runs nothing while recording", () => {
    const recorder = new CommandRecorder();
    recorder.dropTable("posts");

    expect(recorder.commands).toHaveLength(1);
  });

  it("clears", () => {
    const recorder = new CommandRecorder();
    recorder.addColumn("posts", "title", "string");
    recorder.clear();

    expect(recorder.commands).toEqual([]);
  });
});

describe("inverting one command", () => {
  it("turns createTable into dropTable", () => {
    expect(invert({ name: "createTable", args: ["posts"] }).name).toBe("dropTable");
  });

  it("turns addColumn into removeColumn", () => {
    expect(invert({ name: "addColumn", args: ["posts", "title", "string"] }).name).toBe(
      "removeColumn",
    );
  });

  it("keeps the arguments so the inverse names the same thing", () => {
    const inverted = invert({ name: "addColumn", args: ["posts", "title", "string"] });

    expect(inverted.args.slice(0, 2)).toEqual(["posts", "title"]);
  });

  /** A rename is its own inverse with the arguments the other way round. */
  it("swaps a column rename", () => {
    expect(invert({ name: "renameColumn", args: ["posts", "old", "new"] })).toEqual({
      name: "renameColumn",
      args: ["posts", "new", "old"],
    });
  });

  it("swaps a table rename", () => {
    expect(invert({ name: "renameTable", args: ["old", "new"] })).toEqual({
      name: "renameTable",
      args: ["new", "old"],
    });
  });

  it("swaps an index rename", () => {
    expect(invert({ name: "renameIndex", args: ["posts", "old", "new"] })).toEqual({
      name: "renameIndex",
      args: ["posts", "new", "old"],
    });
  });

  /** removeIndex takes the name rather than the columns. */
  it("inverts addIndex to a removeIndex naming the same index", () => {
    const inverted = invert({
      name: "addIndex",
      args: ["posts", ["title"], { name: "by_title" }],
    });

    expect(inverted).toEqual({ name: "removeIndex", args: ["posts", { name: "by_title" }] });
  });

  it("inverts the constraint and reference commands", () => {
    expect(invert({ name: "addReference", args: ["posts", "author"] }).name).toBe(
      "removeReference",
    );
    expect(invert({ name: "addForeignKey", args: ["posts", "authors"] }).name).toBe(
      "removeForeignKey",
    );
    expect(invert({ name: "addTimestamps", args: ["posts"] }).name).toBe("removeTimestamps");
    expect(invert({ name: "createJoinTable", args: ["a", "b"] }).name).toBe("dropJoinTable");
  });
});

describe("what cannot be inverted", () => {
  /**
   * Undoing a removeColumn means adding it back, and nothing in the call says
   * what type it was. Refusing beats a rollback that adds the wrong column.
   */
  it("refuses removeColumn", () => {
    expect(() => invert({ name: "removeColumn", args: ["posts", "title"] })).toThrow(
      IrreversibleMigration,
    );
  });

  it("refuses a column change", () => {
    expect(() => invert({ name: "changeColumn", args: ["posts", "title", "text"] })).toThrow(
      IrreversibleMigration,
    );
    expect(() => invert({ name: "changeColumnNull", args: ["posts", "title", false] })).toThrow(
      IrreversibleMigration,
    );
  });

  it("refuses raw execution", () => {
    expect(() => invert({ name: "execute", args: ["DELETE FROM posts"] })).toThrow(
      IrreversibleMigration,
    );
  });

  /** dropTable inverts only when the call said what the table looked like. */
  it("refuses a bare dropTable", () => {
    expect(() => invert({ name: "dropTable", args: ["posts"] })).toThrow(IrreversibleMigration);
  });

  it("accepts a dropTable that carries its definition", () => {
    expect(invert({ name: "dropTable", args: ["posts", () => undefined] }).name).toBe(
      "createTable",
    );
  });

  it("names the command it could not reverse", () => {
    expect(() => invert({ name: "changeColumn", args: [] })).toThrow(/changeColumn/);
  });

  it("refuses one it has never heard of", () => {
    expect(() => invert({ name: "somethingElse", args: [] })).toThrow(IrreversibleMigration);
  });
});

describe("inverting a whole migration", () => {
  /**
   * Backwards, because undoing a migration that added a column and then
   * indexed it has to drop the index while the column is still there.
   */
  it("runs the commands in reverse order", () => {
    const recorder = new CommandRecorder();
    recorder.createTable("posts");
    recorder.addColumn("posts", "title", "string");
    recorder.addIndex("posts", ["title"], { name: "by_title" });

    expect(invertAll(recorder.commands).map((one) => one.name)).toEqual([
      "removeIndex",
      "removeColumn",
      "dropTable",
    ]);
  });

  it("refuses the whole thing when one step cannot be undone", () => {
    const recorder = new CommandRecorder();
    recorder.addColumn("posts", "title", "string");
    recorder.removeColumn("posts", "old");

    expect(() => invertAll(recorder.commands)).toThrow(IrreversibleMigration);
  });
});

describe("revert and reversible", () => {
  /** For a migration that undoes an earlier one. */
  it("records a block's commands inverted", async () => {
    const recorder = new CommandRecorder();

    await recorder.revert((r) => {
      r.addColumn("posts", "title", "string");
    });

    expect(recorder.commands[0]?.name).toBe("removeColumn");
  });

  it("goes back to recording normally afterwards", async () => {
    const recorder = new CommandRecorder();

    await recorder.revert((r) => {
      r.addColumn("posts", "a", "string");
    });
    recorder.addColumn("posts", "b", "string");

    expect(recorder.commands.map((one) => one.name)).toEqual(["removeColumn", "addColumn"]);
  });

  it("restores the direction after the block throws", async () => {
    const recorder = new CommandRecorder();

    await expect(
      recorder.revert(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    recorder.addColumn("posts", "a", "string");

    expect(recorder.commands[0]?.name).toBe("addColumn");
  });

  it("nests, so reverting a revert records forwards again", async () => {
    const recorder = new CommandRecorder();

    await recorder.revert(async (outer) => {
      await outer.revert((inner) => {
        inner.addColumn("posts", "a", "string");
      });
    });

    expect(recorder.commands[0]?.name).toBe("addColumn");
  });

  /** The escape hatch for a step no rule can invert. */
  it("takes the up branch going forwards", async () => {
    const recorder = new CommandRecorder();

    await recorder.reversible({
      up: (r) => r.addColumn("posts", "up", "string"),
      down: (r) => r.addColumn("posts", "down", "string"),
    });

    expect(recorder.commands[0]?.args[1]).toBe("up");
  });

  it("takes the down branch while reverting", async () => {
    const recorder = new CommandRecorder();

    await recorder.revert(async (r) => {
      await r.reversible({
        up: (one) => one.addColumn("posts", "up", "string"),
        down: (one) => one.addColumn("posts", "down", "string"),
      });
    });

    // Recorded through revert, so the down branch's own command is inverted.
    expect(recorder.commands[0]?.name).toBe("removeColumn");
    expect(recorder.commands[0]?.args[1]).toBe("down");
  });

  it("does nothing when the direction has no branch", async () => {
    const recorder = new CommandRecorder();
    await recorder.reversible({ down: (r) => r.addColumn("posts", "x", "string") });

    expect(recorder.commands).toEqual([]);
  });
});

describe("replaying against a real schema", () => {
  let connection: Connection;
  let schema: SchemaStatements;

  beforeEach(async () => {
    connection = await testConnection();
    setConnection(connection);
    schema = new SchemaStatements(connection);
  });

  afterEach(async () => {
    if (isSqlite) await connection.close();
  });

  it("runs what was recorded", async () => {
    const recorder = new CommandRecorder();
    recorder.createTable("posts", (t) => {
      t.string("title");
    });

    await replay(schema, recorder.commands);

    expect(await schema.tableExists("posts")).toBe(true);
  });

  /** Write change once; the rollback comes free. */
  it("undoes what was recorded", async () => {
    const recorder = new CommandRecorder();
    recorder.createTable("posts", (t) => {
      t.string("title");
    });

    await replay(schema, recorder.commands);
    await replayInverted(schema, recorder.commands);

    expect(await schema.tableExists("posts")).toBe(false);
  });

  it("undoes several steps in the right order", async () => {
    await schema.createTable("posts", (t) => {
      t.string("title");
    });

    const recorder = new CommandRecorder();
    recorder.addColumn("posts", "body", "string");
    recorder.addIndex("posts", ["body"], { name: "by_body" });

    await replay(schema, recorder.commands);

    expect(await schema.indexNameExists("posts", "by_body")).toBe(true);

    await replayInverted(schema, recorder.commands);

    expect(await schema.indexNameExists("posts", "by_body")).toBe(false);
    expect((await schema.columns("posts")).map((one) => one.name)).not.toContain("body");
  });

  it("round-trips a rename", async () => {
    await schema.createTable("posts", (t) => {
      t.string("title");
    });

    const recorder = new CommandRecorder();
    recorder.renameColumn("posts", "title", "headline");

    await replay(schema, recorder.commands);

    expect((await schema.columns("posts")).map((one) => one.name)).toContain("headline");

    await replayInverted(schema, recorder.commands);

    expect((await schema.columns("posts")).map((one) => one.name)).toContain("title");
  });

  it("refuses a command the schema does not have", async () => {
    await expect(replay(schema, [{ name: "nonexistent", args: [] }])).rejects.toThrow(
      /No schema statement/,
    );
  });
});
