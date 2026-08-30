/**
 * Turning a migration's `change` into its own rollback, ported from
 * `ActiveRecord::Migration::CommandRecorder`.
 *
 *     const recorder = new CommandRecorder()
 *     await migration.change(recorder)          // records, runs nothing
 *     await recorder.replayInverted(schema)     // undoes it
 *
 * Writing `up` and `down` by hand means writing the same migration twice, and
 * the second copy is the one nobody tests — a rollback is exercised for the
 * first time in an incident, which is the worst possible moment to find it
 * drops the wrong column.
 *
 * So the recorder stands in for the schema, remembers what was asked for, and
 * inverts it. `createTable` becomes `dropTable`, `addColumn` becomes
 * `removeColumn`, a rename swaps its arguments — and the whole list runs
 * backwards, because undoing a migration that added a column and then indexed
 * it has to drop the index first.
 */

import type { ColumnOptions, ColumnType, SchemaStatements, TableDefinition } from "./schema.js";

/** One thing a migration asked for. */
export interface RecordedCommand {
  name: string;
  args: unknown[];
}

/**
 * Raised when a migration cannot be undone.
 *
 * Better than a rollback that runs and does the wrong thing. `removeColumn`
 * without a type is the usual case: undoing it means adding the column back,
 * and nothing in the call says what type it was.
 */
export class IrreversibleMigration extends Error {
  constructor(readonly command: string) {
    super(
      `${command} cannot be reversed automatically. ` +
        `Write an explicit down, or wrap the step in reversible() and say what to do each way.`,
    );
    this.name = "IrreversibleMigration";
  }
}

/** Commands that undo each other by swapping their names. */
const OPPOSITES: Record<string, string> = {
  createTable: "dropTable",
  dropTable: "createTable",
  addColumn: "removeColumn",
  addIndex: "removeIndex",
  addReference: "removeReference",
  removeReference: "addReference",
  addTimestamps: "removeTimestamps",
  removeTimestamps: "addTimestamps",
  addForeignKey: "removeForeignKey",
  addCheckConstraint: "removeCheckConstraint",
  addUniqueConstraint: "removeUniqueConstraint",
  addExclusionConstraint: "removeExclusionConstraint",
  createJoinTable: "dropJoinTable",
  dropJoinTable: "createJoinTable",
  createEnum: "dropEnum",
  createSchema: "dropSchema",
  enableExtension: "disableExtension",
  disableExtension: "enableExtension",
};

/**
 * Commands that cannot be undone from what they were given.
 *
 * `dropTable` is on neither list on purpose: it inverts to `createTable`, but
 * only when the call carried the block that describes the table. A bare
 * `dropTable("posts")` cannot be undone, and that is decided per call below
 * rather than per command name.
 */
const IRREVERSIBLE = new Set([
  "removeColumn",
  "removeColumns",
  "changeColumn",
  "changeColumnDefault",
  "changeColumnNull",
  "removeIndex",
  "dropEnum",
  "dropSchema",
  "truncateTable",
  "truncateTables",
  "execute",
]);

export class CommandRecorder {
  #commands: RecordedCommand[] = [];
  /** While true, recorded commands are inverted as they arrive. Rails' `revert`. */
  #reverting = false;

  /** What has been recorded, in the order it was asked for. */
  get commands(): RecordedCommand[] {
    return [...this.#commands];
  }

  /** Forgets everything, for a recorder reused across migrations. */
  clear(): void {
    this.#commands = [];
  }

  /** Records one command. Rails' `record`. */
  record(name: string, ...args: unknown[]): void {
    this.#commands.push(this.#reverting ? invert({ name, args }) : { name, args });
  }

  /**
   * Records the block's commands inverted. Rails' `revert`.
   *
   * For a migration that undoes an earlier one: rather than restating its
   * opposite by hand, name what it did and let this turn it round.
   */
  async revert(body: (recorder: CommandRecorder) => void | Promise<void>): Promise<void> {
    const before = this.#reverting;
    this.#reverting = !before;

    try {
      await body(this);
    } finally {
      this.#reverting = before;
    }
  }

  /**
   * Records different commands each way. Rails' `reversible`.
   *
   * The escape hatch for a step that cannot be inverted mechanically —
   * backfilling a column, say, where going up computes values and going down
   * simply drops them.
   */
  async reversible(directions: {
    up?: (recorder: CommandRecorder) => void | Promise<void>;
    down?: (recorder: CommandRecorder) => void | Promise<void>;
  }): Promise<void> {
    const chosen = this.#reverting ? directions.down : directions.up;

    await chosen?.(this);
  }

  // The schema surface a `change` method calls. Each records rather than runs.

  createTable(name: string, build?: (t: TableDefinition) => void, options?: unknown): void {
    this.record("createTable", name, build, options);
  }

  dropTable(name: string, options?: unknown): void {
    this.record("dropTable", name, options);
  }

  addColumn(table: string, column: string, type: ColumnType, options?: ColumnOptions): void {
    this.record("addColumn", table, column, type, options);
  }

  removeColumn(table: string, column: string, type?: ColumnType, options?: ColumnOptions): void {
    this.record("removeColumn", table, column, type, options);
  }

  renameColumn(table: string, from: string, to: string): void {
    this.record("renameColumn", table, from, to);
  }

  renameTable(from: string, to: string): void {
    this.record("renameTable", from, to);
  }

  addIndex(table: string, columns: string[], options?: unknown): void {
    this.record("addIndex", table, columns, options);
  }

  removeIndex(table: string, options?: unknown): void {
    this.record("removeIndex", table, options);
  }

  renameIndex(table: string, from: string, to: string): void {
    this.record("renameIndex", table, from, to);
  }

  addReference(table: string, name: string, options?: unknown): void {
    this.record("addReference", table, name, options);
  }

  removeReference(table: string, name: string, options?: unknown): void {
    this.record("removeReference", table, name, options);
  }

  addTimestamps(table: string, options?: unknown): void {
    this.record("addTimestamps", table, options);
  }

  removeTimestamps(table: string): void {
    this.record("removeTimestamps", table);
  }

  addForeignKey(table: string, to: string, options?: unknown): void {
    this.record("addForeignKey", table, to, options);
  }

  removeForeignKey(table: string, options?: unknown): void {
    this.record("removeForeignKey", table, options);
  }

  createJoinTable(first: string, second: string, options?: unknown): void {
    this.record("createJoinTable", first, second, options);
  }

  dropJoinTable(first: string, second: string, options?: unknown): void {
    this.record("dropJoinTable", first, second, options);
  }
}

/**
 * The command that undoes another. Rails' `inverse_of`.
 *
 * Throws rather than guessing. A rollback that silently skipped what it could
 * not undo would leave a schema halfway between two migrations, which is worse
 * than one that refuses and says which step it could not handle.
 */
export function invert(command: RecordedCommand): RecordedCommand {
  const { name, args } = command;

  // A rename is its own inverse with the arguments the other way round.
  if (name === "renameColumn") {
    const [table, from, to] = args;

    return { name, args: [table, to, from] };
  }

  if (name === "renameTable" || name === "renameIndex") {
    return name === "renameTable"
      ? { name, args: [args[1], args[0]] }
      : { name, args: [args[0], args[2], args[1]] };
  }

  // dropTable inverts only when the call said what the table looked like.
  if (name === "dropTable" && typeof args[1] !== "function") {
    throw new IrreversibleMigration("dropTable without a table definition");
  }

  if (IRREVERSIBLE.has(name)) throw new IrreversibleMigration(name);

  const opposite = OPPOSITES[name];
  if (!opposite) throw new IrreversibleMigration(name);

  // addIndex records its options; removeIndex takes a different shape, so the
  // columns are dropped and the name is what identifies it.
  if (name === "addIndex") {
    const [table, , options] = args;

    return { name: "removeIndex", args: [table, options] };
  }

  return { name: opposite, args };
}

/** Runs this recorder's commands, inverted, against real schema statements. */
export async function replayInverted(
  schema: SchemaStatements,
  commands: readonly RecordedCommand[],
): Promise<void> {
  await replay(schema, invertAll(commands));
}

/** Every recorded command inverted, in the order a rollback runs them. */
export function invertAll(commands: readonly RecordedCommand[]): RecordedCommand[] {
  // Reversed, because undoing a migration that added a column and then indexed
  // it has to drop the index while the column is still there.
  return [...commands].reverse().map((one) => invert(one));
}

/** Runs recorded commands against real schema statements. */
export async function replay(
  schema: SchemaStatements,
  commands: readonly RecordedCommand[],
): Promise<void> {
  for (const command of commands) {
    const method = (schema as unknown as Record<string, unknown>)[command.name];

    if (typeof method !== "function") {
      throw new Error(`No schema statement named ${command.name}`);
    }

    // Trailing undefined arguments are dropped, so a recorded call with no
    // options reaches a method whose default applies rather than being handed
    // an explicit undefined that overrides it.
    const args = [...command.args];
    while (args.length > 0 && args.at(-1) === undefined) args.pop();

    await (method as (...rest: unknown[]) => Promise<void>).apply(schema, args);
  }
}
