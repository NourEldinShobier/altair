/**
 * The manual savepoint protocol, ported from the savepoint cases in
 * `activerecord/test/cases/transactions_test.rb`.
 *
 * The block form is tested elsewhere. These cases are about the manual one,
 * which exists for the same reason beginTransaction does: a test harness opens
 * a savepoint in one hook and rolls it back in another, and no block spans
 * those two calls.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SchemaStatements, setConnection } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { isSqlite, testConnection } from "./support/database.js";
import { selectValue } from "../src/select_statements.js";

let connection: Connection;

async function titles(): Promise<unknown> {
  return await selectValue(connection, "SELECT COUNT(*) FROM posts");
}

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  await new SchemaStatements(connection).createTable("posts", (t) => {
    t.string("title");
  });
});

afterEach(async () => {
  if (isSqlite) await connection.close();
});

describe("createSavepoint", () => {
  it("names the savepoint it opened", async () => {
    await connection.beginTransaction();
    const name = await connection.createSavepoint();

    expect(name).toMatch(/^altair_savepoint_/);

    await connection.rollbackTransaction();
  });

  it("takes a name of its own", async () => {
    await connection.beginTransaction();

    expect(await connection.createSavepoint("mine")).toBe("mine");

    await connection.rollbackTransaction();
  });

  /** Two in the same scope must not collide. */
  it("gives each one a different name", async () => {
    await connection.beginTransaction();
    const first = await connection.createSavepoint();
    const second = await connection.createSavepoint();

    expect(first).not.toBe(second);

    await connection.rollbackTransaction();
  });
});

describe("rolling back to one", () => {
  it("undoes what happened after it", async () => {
    await connection.beginTransaction();
    await connection.execute("INSERT INTO posts (title) VALUES ('kept')");

    const name = await connection.createSavepoint();
    await connection.execute("INSERT INTO posts (title) VALUES ('undone')");
    await connection.rollbackToSavepoint(name);

    expect(Number(await titles())).toBe(1);

    await connection.rollbackTransaction();
  });

  it("keeps what happened before it", async () => {
    await connection.beginTransaction();
    await connection.execute("INSERT INTO posts (title) VALUES ('kept')");

    const name = await connection.createSavepoint();
    await connection.execute("INSERT INTO posts (title) VALUES ('undone')");
    await connection.rollbackToSavepoint(name);

    expect(await selectValue(connection, "SELECT title FROM posts")).toBe("kept");

    await connection.rollbackTransaction();
  });

  it("lets work continue afterwards", async () => {
    await connection.beginTransaction();
    const name = await connection.createSavepoint();
    await connection.execute("INSERT INTO posts (title) VALUES ('undone')");
    await connection.rollbackToSavepoint(name);
    await connection.execute("INSERT INTO posts (title) VALUES ('after')");

    expect(Number(await titles())).toBe(1);

    await connection.rollbackTransaction();
  });
});

describe("releasing one", () => {
  /**
   * Releasing is not committing. The work stays inside the enclosing
   * transaction and is still undone when that rolls back — which is the part
   * the name hides.
   */
  it("keeps the work inside the transaction", async () => {
    await connection.beginTransaction();
    const name = await connection.createSavepoint();
    await connection.execute("INSERT INTO posts (title) VALUES ('released')");
    await connection.releaseSavepoint(name);

    expect(Number(await titles())).toBe(1);

    await connection.rollbackTransaction();

    expect(Number(await titles())).toBe(0);
  });

  it("survives a commit of the enclosing transaction", async () => {
    await connection.beginTransaction();
    const name = await connection.createSavepoint();
    await connection.execute("INSERT INTO posts (title) VALUES ('released')");
    await connection.releaseSavepoint(name);
    await connection.commitTransaction();

    expect(Number(await titles())).toBe(1);
  });
});

describe("introspection", () => {
  it("counts nothing open to begin with", () => {
    expect(connection.openTransactions).toBe(0);
    expect(connection.transactionOpen).toBe(false);
  });

  it("counts the transaction", async () => {
    await connection.beginTransaction();

    expect(connection.openTransactions).toBe(1);
    expect(connection.transactionOpen).toBe(true);

    await connection.rollbackTransaction();
  });

  /** The depth is what `isInTransaction` cannot answer as a boolean. */
  it("counts each savepoint inside it", async () => {
    await connection.beginTransaction();
    await connection.createSavepoint();
    await connection.createSavepoint();

    expect(connection.openTransactions).toBe(3);

    await connection.rollbackTransaction();
  });

  it("counts back down as they are released", async () => {
    await connection.beginTransaction();
    const name = await connection.createSavepoint();

    expect(connection.openTransactions).toBe(2);

    await connection.releaseSavepoint(name);

    expect(connection.openTransactions).toBe(1);

    await connection.rollbackTransaction();
  });

  it("is back to nothing after the transaction ends", async () => {
    await connection.beginTransaction();
    await connection.createSavepoint();
    await connection.rollbackTransaction();

    expect(connection.openTransactions).toBe(0);
  });

  it("names the savepoint depth it is at", async () => {
    await connection.beginTransaction();
    await connection.createSavepoint();

    expect(connection.currentSavepointName).toBe("altair_savepoint_1");

    await connection.rollbackTransaction();
  });
});
