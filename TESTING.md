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
