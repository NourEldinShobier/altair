/**
 * Pessimistic locking.
 *
 * Mirrors activerecord/test/cases/locking_test.rb's pessimistic half. The
 * optimistic kind already exists — `lock_version` and StaleObjectError — and
 * they solve different problems: optimistic notices a conflict after the fact
 * and makes you retry, pessimistic prevents one by making the other writer
 * wait.
 *
 * The SQL is asserted per adapter, because SQLite has no row locking at all
 * and the whole point is that the same application code is correct on it.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import {
  Connection,
  Model,
  RecordNotFound,
  SchemaStatements,
  setConnection,
} from "../src/index.js";
import { testConnection } from "./support/database.js";

interface AccountRow {
  id: number;
  holder: string;
  balance: number;
}

class Account extends Model<AccountRow>("accounts") {}

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);
  Account.columnCache = undefined;
  Account.columnTypeCache = undefined;

  const schema = new SchemaStatements(connection);
  await schema.dropTable("accounts", { ifExists: true });
  await schema.createTable("accounts", (t) => {
    t.string("holder");
    t.integer("balance", { default: 0 });
  });

  await Account.create({ holder: "Ada", balance: 100 });
});

// Each adapter wants something different, and one wants nothing. Pinned to a
// connection each, so all three are checked without three databases running.
describe("the clause each adapter gets", () => {
  const on = (url: string) =>
    class extends Model<AccountRow>("accounts", { connection: new Connection(url) }) {};

  const Postgres = on("postgres://localhost/x");
  const MySQL = on("mysql://localhost/x");
  const SQLite = on("sqlite://:memory:");

  it("locks for update on postgres", () => {
    expect(Postgres.all().lock().toSql().sql).toEndWith("FOR UPDATE");
    expect(Postgres.all().lock("share").toSql().sql).toEndWith("FOR SHARE");
  });

  // MySQL spelled the shared lock `LOCK IN SHARE MODE` until 8.0. That is the
  // spelling every supported version understands.
  it("uses MySQL's older spelling for a shared lock", () => {
    expect(MySQL.all().lock().toSql().sql).toEndWith("FOR UPDATE");
    expect(MySQL.all().lock("share").toSql().sql).toEndWith("LOCK IN SHARE MODE");
  });

  // SQLite locks the whole database for a write transaction, so the
  // read-modify-write this protects is already serialized — and `FOR UPDATE`
  // would be a syntax error. The same application code has to work on it.
  it("asks SQLite for nothing, because it needs nothing", () => {
    const sql = SQLite.all().lock().toSql().sql;

    expect(sql).not.toContain("FOR UPDATE");
    expect(sql).not.toContain("SHARE");
  });

  it("comes after everything else in the statement", () => {
    const sql = Postgres.all().where({ holder: "Ada" }).order("id").limit(1).lock().toSql().sql;

    expect(sql).toEndWith("LIMIT 1 FOR UPDATE");
  });
});

describe("locking rows", () => {
  it("reads them like any other relation", async () => {
    await connection.transaction(async () => {
      const account = await Account.where({ holder: "Ada" }).lock().first();

      expect(account?.balance).toBe(100);
    });
  });

  it("chains with the rest of a query", async () => {
    await connection.transaction(async () => {
      const accounts = await Account.all().order("id").limit(1).lock().toArray();

      expect(accounts).toHaveLength(1);
    });
  });

  it("leaves a relation without it alone", () => {
    expect(Account.all().toSql().sql).not.toContain("FOR UPDATE");
  });
});

describe("withLock", () => {
  it("runs the block and keeps the writes", async () => {
    const account = (await Account.findBy({ holder: "Ada" })) as Account;

    await account.withLock(async () => {
      await account.update({ balance: Number(account.balance) - 10 });
    });

    expect((await Account.findBy({ holder: "Ada" }))?.balance).toBe(90);
  });

  // The part people leave out, and the reason the helper exists. A lock taken
  // on a row you read a moment ago protects nothing: the value in hand is
  // already stale, and subtracting from a stale balance is the bug the lock
  // was for.
  it("reloads inside the lock, so the block sees what the database holds", async () => {
    const stale = (await Account.findBy({ holder: "Ada" })) as Account;

    // Somebody else moves the balance after we read it.
    await Account.where({ holder: "Ada" }).updateAll({ balance: 40 });
    expect(stale.balance).toBe(100);

    await stale.withLock(async () => {
      expect(stale.balance).toBe(40);
    });
  });

  it("leaves the record clean after reloading", async () => {
    const account = (await Account.findBy({ holder: "Ada" })) as Account;

    await account.withLock(async () => {
      expect(account.hasChanged()).toBe(false);
    });
  });

  it("returns what the block returned", async () => {
    const account = (await Account.findBy({ holder: "Ada" })) as Account;

    expect(await account.withLock(async () => "done")).toBe("done");
  });

  it("rolls back when the block throws", async () => {
    const account = (await Account.findBy({ holder: "Ada" })) as Account;

    await account
      .withLock(async () => {
        await account.update({ balance: 0 });
        throw new Error("changed my mind");
      })
      .catch(() => undefined);

    expect((await Account.findBy({ holder: "Ada" }))?.balance).toBe(100);
  });

  it("says so when the row has gone", async () => {
    const account = (await Account.findBy({ holder: "Ada" })) as Account;
    await Account.where({ holder: "Ada" }).deleteAll();

    await expect(account.withLock(async () => undefined)).rejects.toThrow(RecordNotFound);
  });

  // Nesting is a savepoint, so a method that locks can be called from one that
  // already opened a transaction.
  it("works inside a transaction that is already open", async () => {
    const account = (await Account.findBy({ holder: "Ada" })) as Account;

    await connection.transaction(async () => {
      await account.withLock(async () => {
        await account.update({ balance: 50 });
      });
    });

    expect((await Account.findBy({ holder: "Ada" }))?.balance).toBe(50);
  });
});

describe("Model.transaction", () => {
  it("commits what the block wrote", async () => {
    await Account.transaction(async () => {
      await Account.create({ holder: "Grace", balance: 10 });
    });

    expect(await Account.count()).toBe(2);
  });

  it("rolls back when the block throws", async () => {
    await Account.transaction(async () => {
      await Account.create({ holder: "Grace", balance: 10 });
      throw new Error("no");
    }).catch(() => undefined);

    expect(await Account.count()).toBe(1);
  });
});
