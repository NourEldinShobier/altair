/**
 * SQLite's session settings, ported from `DEFAULT_PRAGMAS` and
 * `configure_connection` in
 * `activerecord/lib/active_record/connection_adapters/sqlite3_adapter.rb`, and
 * from `begin_db_transaction` in `sqlite3/database_statements.rb`, with the
 * pragma cases from `activerecord/test/cases/adapters/sqlite3/sqlite3_adapter_test.rb`.
 *
 * Only `foreign_keys` was set before. The other six are what make SQLite
 * usable under more than one writer: without a busy timeout a second
 * transaction gets `SQLITE_BUSY` at once instead of waiting; with the rollback
 * journal and `synchronous=FULL`, every commit syncs the disk twice; and a
 * deferred `BEGIN` cannot upgrade to a write lock while another writer holds
 * one, whatever the timeout says.
 *
 * Measured before this: sixty-four concurrent single-row writes took five to
 * seven seconds *each* — sixteen a second against four hundred for Rails on
 * the same file. The whole difference was these settings.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connection, sqlitePragmas } from "../src/connection.js";

let dir: string;
const open: Connection[] = [];

const file = (name = "app.sqlite3", query = ""): Connection => {
  const connection = new Connection(`sqlite://${join(dir, name).replaceAll("\\", "/")}${query}`);

  open.push(connection);

  return connection;
};

const pragma = async (connection: Connection, name: string): Promise<unknown> => {
  const rows = await connection.query<Record<string, unknown>>(`PRAGMA ${name}`);

  return Object.values(rows[0] ?? {})[0];
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "altair-sqlite-"));
});

afterEach(async () => {
  for (const connection of open.splice(0)) await connection.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the defaults on a file database", () => {
  it("uses the write-ahead log", async () => {
    expect(await pragma(file(), "journal_mode")).toBe("wal");
  });

  /** 1 is NORMAL. FULL (2) is the SQLite default and syncs twice per commit. */
  it("syncs normally rather than fully", async () => {
    expect(await pragma(file(), "synchronous")).toBe(1);
  });

  it("enforces foreign keys, as it always did", async () => {
    expect(await pragma(file(), "foreign_keys")).toBe(1);
  });

  /** The value in the `database.yml` every Rails application is generated with. */
  it("waits five seconds for a lock", async () => {
    expect(await pragma(file(), "busy_timeout")).toBe(5000);
  });

  it("sets the cache, mmap and journal limits Rails sets", async () => {
    const connection = file();

    expect(await pragma(connection, "cache_size")).toBe(2000);
    expect(await pragma(connection, "mmap_size")).toBe(134217728);
    expect(await pragma(connection, "journal_size_limit")).toBe(67108864);
  });
});

describe("an in-memory database", () => {
  /** SQLite documents that `:memory:` reports `memory` whatever is asked. */
  it("cannot use a write-ahead log and says so", async () => {
    const connection = new Connection("sqlite://:memory:");
    open.push(connection);

    expect(await pragma(connection, "journal_mode")).toBe("memory");
  });

  it("still gets every other setting", async () => {
    const connection = new Connection("sqlite://:memory:");
    open.push(connection);

    expect(await pragma(connection, "synchronous")).toBe(1);
    expect(await pragma(connection, "busy_timeout")).toBe(5000);
    expect(await pragma(connection, "foreign_keys")).toBe(1);
  });
});

describe("overriding through the URL", () => {
  /** Rails' `pragmas: { journal_mode: :delete }`, spelled where this adapter's config lives. */
  it("takes a pragma from the query string", async () => {
    expect(await pragma(file("o.sqlite3", "?journal_mode=delete"), "journal_mode")).toBe("delete");
  });

  it("takes a busy timeout from the query string", async () => {
    expect(await pragma(file("t.sqlite3", "?busy_timeout=250"), "busy_timeout")).toBe(250);
  });

  it("leaves the other defaults in place", async () => {
    const connection = file("p.sqlite3", "?busy_timeout=250");

    expect(await pragma(connection, "synchronous")).toBe(1);
    expect(await pragma(connection, "journal_mode")).toBe("wal");
  });

  /** A pragma is interpolated into a statement. A URL is not where SQL comes from. */
  it("refuses a value that is not a pragma value", () => {
    expect(() => sqlitePragmas("sqlite://x.db?journal_mode=wal;DROP TABLE posts")).toThrow(
      /not a pragma/,
    );
    expect(() => sqlitePragmas("sqlite://x.db?journal mode=wal")).toThrow(/not a pragma/);
  });

  it("puts overrides after the defaults, so the last word wins", () => {
    const pairs = sqlitePragmas("sqlite://x.db?journal_mode=delete");
    const journal = pairs.filter(([name]) => name === "journal_mode");

    expect(journal).toEqual([["journal_mode", "delete"]]);
    expect(pairs.some(([name]) => name === "busy_timeout")).toBe(true);
  });
});

/**
 * A second writer has to be a second *process*. Bun's `SQL` shares one handle
 * per file within a process, so two `Connection` objects here are one
 * connection — the first version of these tests found that out when the
 * second connection's pragma setup ran inside the first one's transaction.
 */
describe("a second writer in another process", () => {
  const HOLDER = join(import.meta.dir, "support", "hold-sqlite-lock.ts");

  const setup = async (connection: Connection): Promise<string> => {
    await connection.execute("CREATE TABLE IF NOT EXISTS rows (id INTEGER PRIMARY KEY, n INTEGER)");

    return connection.url.replace(/^sqlite:\/\//, "").replace(/\?.*$/, "");
  };

  /** Starts the holder without waiting for it: it may be *meant* to block. */
  const spawnHolder = (path: string, holdMs: number, n: number) => {
    const sentinel = `${path}.held`;

    rmSync(sentinel, { force: true });

    const proc = Bun.spawn(["bun", HOLDER, path, String(holdMs), String(n)], {
      stdout: "pipe",
      stderr: "pipe",
    });

    return { proc, output: new Response(proc.stdout).text(), sentinel };
  };

  const hold = async (path: string, holdMs: number, n: number) => {
    const holder = spawnHolder(path, holdMs, n);
    const deadline = performance.now() + 5000;

    while (!existsSync(holder.sentinel)) {
      if (performance.now() > deadline) {
        throw new Error(
          `holder never took the lock: ${await new Response(holder.proc.stderr).text()}`,
        );
      }
      await Bun.sleep(20);
    }

    return holder;
  };

  const count = async (connection: Connection): Promise<number> =>
    (await connection.query<{ c: number }>("SELECT COUNT(*) AS c FROM rows"))[0]?.c ?? -1;

  /** The benchmark's shape: many writers at once, every one of them commits. */
  it("lets thirty-two concurrent transactions on one connection all commit", async () => {
    const connection = file("c.sqlite3");

    await setup(connection);

    await Promise.all(
      Array.from({ length: 32 }, (_, index) =>
        connection.transaction(async (tx) => {
          await tx.execute("INSERT INTO rows (n) VALUES (?)", [index]);
        }),
      ),
    );

    expect(await count(connection)).toBe(32);
  });

  /**
   * The manual path takes the same lock, and has to give it back on both
   * exits. A commit or rollback that kept it would hang the next
   * `transaction()` for ever — which is what the runner's timeout catches.
   */
  it("releases the writer lock after a manual commit, and after a rollback", async () => {
    const connection = file("m.sqlite3");

    await setup(connection);

    await connection.beginTransaction();
    await connection.execute("INSERT INTO rows (n) VALUES (1)");
    await connection.commitTransaction();

    await connection.transaction(async (tx) => {
      await tx.execute("INSERT INTO rows (n) VALUES (2)");
    });

    await connection.beginTransaction();
    await connection.execute("INSERT INTO rows (n) VALUES (3)");
    await connection.rollbackTransaction();

    await connection.transaction(async (tx) => {
      await tx.execute("INSERT INTO rows (n) VALUES (4)");
    });

    expect(await count(connection)).toBe(3);
  });

  /**
   * The busy timeout: the second writer waits for the first rather than
   * failing on the spot. Before this, the wait was zero and the answer was
   * `SQLITE_BUSY`.
   */
  it("waits for the other process rather than failing at once", async () => {
    const connection = file("w.sqlite3");
    const path = await setup(connection);
    const { proc, output } = await hold(path, 400, 1);

    const started = performance.now();

    await connection.transaction(async (tx) => {
      await tx.execute("INSERT INTO rows (n) VALUES (2)");
    });

    const waited = performance.now() - started;

    await proc.exited;
    expect(await output).toContain("released");
    expect(waited).toBeGreaterThanOrEqual(100);
    expect(await count(connection)).toBe(2);
  });

  it("gives up only once a short timeout has run out", async () => {
    const connection = file("t.sqlite3", "?busy_timeout=200");
    const path = await setup(connection);
    const { proc } = await hold(path, 1500, 1);

    const started = performance.now();

    await expect(
      connection.transaction(async (tx) => {
        await tx.execute("INSERT INTO rows (n) VALUES (2)");
      }),
    ).rejects.toThrow();

    expect(performance.now() - started).toBeGreaterThanOrEqual(150);
    await proc.exited;
  });

  /**
   * What IMMEDIATE buys over DEFERRED, and the only shape that tells them
   * apart. This transaction reads first, then another process writes and
   * commits, then this one writes. Deferred: the read took a snapshot and no
   * lock, the other writer walked straight in, and the write here fails
   * against a snapshot that is now stale. Immediate: the lock was taken at
   * BEGIN, the other process is the one that waits, and the write here lands.
   *
   * The holder reporting that it waited is the proof — under DEFERRED it
   * acquires in a few milliseconds.
   */
  it("holds the write lock from BEGIN, so a reader-then-writer is not overtaken", async () => {
    const connection = file("i.sqlite3");
    const path = await setup(connection);
    let probe: { exitCode: number | null; output: string } | undefined;

    await connection.transaction(async (tx) => {
      await tx.query("SELECT COUNT(*) AS c FROM rows");

      // A yes/no probe rather than a timing: another process asks for the
      // write lock with a busy timeout of zero. Under IMMEDIATE it is refused
      // on the spot; under DEFERRED — no lock taken until the first write —
      // it would walk straight in, and this transaction's write below would
      // then fail against a snapshot that had gone stale.
      const proc = Bun.spawn(["bun", HOLDER, path, "0", "7", "0"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = await new Response(proc.stdout).text();

      await proc.exited;
      probe = { exitCode: proc.exitCode, output };

      await tx.execute("INSERT INTO rows (n) VALUES (2)");
    });

    expect(probe?.exitCode).toBe(3);
    expect(probe?.output).toMatch(/^busy after \d+ms/);
    expect(await count(connection)).toBe(1);
  });
});
