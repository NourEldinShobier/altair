# Testing

Altair's test suite has one job beyond catching bugs: **making the claim "this behaves like Rails" checkable by someone who doesn't trust us.**

## The rule

> Where Rails has a test for something, we use Rails' test case — not one we made up.

Rails has **26,775 test methods across 1,871 files**. Those tests encode two decades of
edge cases, bug reports, and deliberate decisions. Rewriting them from scratch would mean
re-deriving all of that from memory, and quietly testing only the cases we happened to
think of. So we don't. We take Rails' cases and make our code pass them.

Concretely, for each subsystem we port:

1. **Copy the test data mechanically**, not by hand. `tools/port-fixtures.ts` reads
   Rails' fixture files out of a local clone and generates TypeScript. When Rails updates
   a fixture, we re-run the tool and the diff shows exactly what changed.
2. **Name each test after the Rails test it mirrors**, in a comment. Anyone can open
   Rails' source and check we didn't quietly skip the hard half.
3. **Match Rails' behaviour, including where it's odd.** `pluralize("safe")` returns
   `"saves"` in Rails. It returns `"saves"` here. Parity is the contract; "fixing" Rails
   silently would break real applications being ported.

Where Rails has _no_ test — new surface that only exists here, like typed route helpers —
we write our own, and mark them as such.

## Anything that touches a database

> Take the connection from the harness. Never write `new Connection("sqlite://:memory:")`.

```ts
import { isSqlite, testConnection } from "./support/database.js";

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);
});

afterEach(async () => {
  // A server connection is one pool the harness replaces; closing it here
  // would pull it out from under the next file.
  if (isSqlite) await connection.close();
});
```

`testConnection()` honours `ALTAIR_TEST_DATABASE_URL`, which is what CI sets for the
PostgreSQL and MariaDB legs. The default is in-memory SQLite, so running the suite needs
nothing installed.

This is not a style preference. A test pinned to SQLite passes on SQLite and says nothing
about the other two, and it _looks_ like coverage. In one afternoon, turning this on
across the ORM suite found five bugs that each broke a real application on PostgreSQL:

- every boolean write, because `true` was serialised to `1` and PostgreSQL has a real
  `BOOLEAN`;
- every `has_and_belongs_to_many` read and write, because the placeholder helper is
  zero-based and the join statements passed 1 and 2 — on SQLite every placeholder is `?`,
  so the numbers never mattered;
- `offset` with no `limit`, because SQLite and MySQL need a `LIMIT` to accept an `OFFSET`
  and PostgreSQL rejects the `LIMIT -1` they are given;
- duplicate-key detection, because Bun's PostgreSQL driver puts the SQLSTATE in `errno`
  and a generic value in `code`;
- `pluck`, which returned strings where a record returned numbers, because PostgreSQL
  sends a `BIGINT` as a string and only the record path cast it.

Three of those had shipped weeks earlier. None was found by reading.

### Writing an assertion that survives all three

- **Quote through the connection.** `connection.quote("title")` — MySQL uses backticks
  where the other two use double quotes.
- **Match placeholders as `?` _or_ `$n`.** Counting only `?` asserts the database.
- **Compare types logically, not textually.** PostgreSQL says `character varying`, MySQL
  says `int`. `columnExists(table, column, "string")` handles it.
- **Do not count every statement.** MySQL's driver asks for the inserted id, so "one
  SELECT after this write" is an assertion about the driver.
- **Skip, do not fake.** A case that is genuinely about one adapter takes
  `it.skipIf(!isSqlite)` and says why.

### Awaiting the assertion

`expect(promise).rejects.toThrow()` without `await` asserts nothing: the expectation is
dropped and the rejection surfaces as an unhandled one. Three of these were found in one
file, and one of them could only ever have failed — it had never run, because it is
skipped on SQLite and nothing else ever reached it.

## Running tests

```sh
bun test                  # everything
bun test --parallel       # across cores
bun test packages/support # one package
bun test --changed        # only what your branch touched
bun test --coverage
```

## Setting up the Rails clone

Fixture porting needs a Rails checkout as a **sibling of this repo**, so its 61 MB of
history never lands in ours:

```sh
git clone --depth 1 https://github.com/rails/rails ../research/rails
bun run port:fixtures
```

Generated fixtures are committed, so CI and day-to-day work need no clone. You only need
one when porting a new subsystem or refreshing existing fixtures.

## Current coverage

| Package                       | Tests | Ported from                                               |
| ----------------------------- | ----- | --------------------------------------------------------- |
| `@altair/support` — inflector | 544   | `activesupport/test/inflector_test.rb`, 246 fixture cases |

Run `bun test` for the live number. `PARITY.md` tracks what's been migrated and what
hasn't.
