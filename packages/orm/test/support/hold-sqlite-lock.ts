/**
 * Holds SQLite's write lock from another process, for the tests in
 * `sqlite-pragmas.test.ts`.
 *
 * A second process is the only way to have a second writer: Bun's `SQL`
 * shares one handle per file within a process, so two `Connection` objects in
 * one test are one connection, and the second `BEGIN` is a nested
 * transaction rather than a contended one.
 *
 *     bun test/support/hold-sqlite-lock.ts <file> <holdMs> [n]
 *
 * Opens the file, takes the write lock with `BEGIN IMMEDIATE` (waiting up to
 * five seconds for it, as the adapter does), inserts `n` into `rows`, holds
 * for `holdMs`, commits. Prints how long the lock took to acquire — which is
 * how a test tells whether the *other* side held it first.
 */

import { SQL } from "bun";

const [file, holdMs = "300", n = "-1", busy = "5000"] = process.argv.slice(2);

if (!file) {
  console.error("usage: hold-sqlite-lock.ts <file> <holdMs> [n] [busyTimeoutMs]");
  process.exit(2);
}

const sql = new SQL(`sqlite://${file}`);

// A busy timeout of 0 turns this into a probe: it either takes the lock at
// once or reports `busy` and exits 3, which is a yes/no answer to "is the
// write lock held right now" that no amount of timing can give.
await sql.unsafe(`PRAGMA busy_timeout = ${Number(busy)}`);

const started = performance.now();

try {
  await sql.unsafe("BEGIN IMMEDIATE");
} catch (error) {
  console.log(
    `busy after ${Math.round(performance.now() - started)}ms: ${(error as Error).message}`,
  );
  await sql.close();
  process.exit(3);
}
console.log(`acquired after ${Math.round(performance.now() - started)}ms`);

// A sentinel the test can poll for, so it knows the lock is held rather than
// guessing with a sleep. Stdout would do, but reading it here and again at
// the end means two consumers of one stream; a file has no such problem.
await Bun.write(`${file}.held`, "held");

await sql.unsafe(`INSERT INTO rows (n) VALUES (${Number(n)})`);
await Bun.sleep(Number(holdMs));
await sql.unsafe("COMMIT");
console.log("released");

await sql.close();
