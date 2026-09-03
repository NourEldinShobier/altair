/**
 * Undoing a comment change, ported from the
 * `invert_change_column_comment` / `invert_change_table_comment` cases in
 * `activerecord/test/cases/migration/command_recorder_test.rb`.
 *
 * A comment is where the reason for a column lives, so a rollback that blanked
 * one nobody asked it to blank is a silent edit to the schema.
 */

import { describe, expect, it } from "bun:test";
import {
  CommandRecorder,
  IrreversibleMigration,
  invert,
  invertChangeColumnComment,
  invertChangeTableComment,
} from "../src/command_recorder.js";

describe("a column comment", () => {
  it("is recorded with what it was and what it became", () => {
    const recorder = new CommandRecorder();

    recorder.changeColumnComment("posts", "body", { from: "old", to: "new" });

    expect(recorder.commands).toEqual([
      { name: "changeColumnComment", args: ["posts", "body", { from: "old", to: "new" }] },
    ]);
  });

  it("inverts by swapping the two halves", () => {
    expect(invertChangeColumnComment(["posts", "body", { from: "old", to: "new" }])).toEqual({
      name: "changeColumnComment",
      args: ["posts", "body", { from: "new", to: "old" }],
    });
  });

  /**
   * The recorder is not connected to a database, and by the time the rollback
   * runs the old comment is gone — so it has to have been said up front.
   */
  it("cannot be inverted without both halves", () => {
    expect(() => invertChangeColumnComment(["posts", "body", { to: "new" }])).toThrow(
      IrreversibleMigration,
    );
    expect(() => invertChangeColumnComment(["posts", "body", { from: "old" }])).toThrow(
      IrreversibleMigration,
    );
    expect(() => invertChangeColumnComment(["posts", "body"])).toThrow(IrreversibleMigration);
  });

  it("says which step it could not undo", () => {
    expect(() => invertChangeColumnComment(["posts", "body", {}])).toThrow(
      "changeColumnComment without from: and to:",
    );
  });

  /** Clearing a comment on purpose is a change like any other. */
  it("inverts a comment that was cleared", () => {
    expect(invertChangeColumnComment(["posts", "body", { from: "why", to: null }])).toEqual({
      name: "changeColumnComment",
      args: ["posts", "body", { from: null, to: "why" }],
    });
  });
});

describe("a table comment", () => {
  it("inverts by swapping the two halves", () => {
    expect(invertChangeTableComment(["posts", { from: "old", to: "new" }])).toEqual({
      name: "changeTableComment",
      args: ["posts", { from: "new", to: "old" }],
    });
  });

  it("cannot be inverted without both halves", () => {
    expect(() => invertChangeTableComment(["posts", { to: "new" }])).toThrow(IrreversibleMigration);
  });

  it("is recorded through the recorder", () => {
    const recorder = new CommandRecorder();

    recorder.changeTableComment("posts", { from: "old", to: "new" });

    expect(recorder.commands).toEqual([
      { name: "changeTableComment", args: ["posts", { from: "old", to: "new" }] },
    ]);
  });
});

describe("inverting through the general path", () => {
  it("routes a comment change to its own inversion", () => {
    expect(
      invert({ name: "changeColumnComment", args: ["posts", "body", { from: "a", to: "b" }] }),
    ).toEqual({
      name: "changeColumnComment",
      args: ["posts", "body", { from: "b", to: "a" }],
    });

    expect(invert({ name: "changeTableComment", args: ["posts", { from: "a", to: "b" }] })).toEqual(
      {
        name: "changeTableComment",
        args: ["posts", { from: "b", to: "a" }],
      },
    );
  });

  /** A `revert` block inverts as it records. */
  it("inverts while reverting", async () => {
    const recorder = new CommandRecorder();

    await recorder.revert(() => {
      recorder.changeTableComment("posts", { from: "old", to: "new" });
    });

    expect(recorder.commands).toEqual([
      { name: "changeTableComment", args: ["posts", { from: "new", to: "old" }] },
    ]);
  });
});
