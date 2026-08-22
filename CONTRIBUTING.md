# Contributing

## Commits

This repository uses [Conventional Commits](https://www.conventionalcommits.org/).

```
<type>(<scope>): <subject>
```

Types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`, `ci`, `build`, `revert`.
Scope is the package or area — `support`, `router`, `orm`, `view`, `cli`, `fixtures`.

```
feat(support): port ActiveSupport inflector
fix(router): match nested resources before wildcards
test(orm): port association fixtures from Rails
```

Keep the subject imperative and under ~72 characters. Anything that changes behaviour
should say so in the body.

## Porting a subsystem from Rails

The workflow that keeps parity honest:

1. **Measure it first.** Find the Rails source and its tests, and record the line and
   test counts in `PARITY.md`. You want to know the size of the job before starting.

2. **Port the test data mechanically.** If the Rails tests use fixture files, extend
   `tools/port-fixtures.ts` to generate them rather than copying by hand. Generated
   fixtures carry a header saying so and are committed.

3. **Read the Rails implementation before writing yours.** Especially the ordering
   rules and the edge cases — they are usually load-bearing and rarely documented.
   Clone it as a sibling of this repo:

   ```sh
   git clone --depth 1 https://github.com/rails/rails ../research/rails
   ```

4. **Write the tests first, from Rails' cases.** Each test gets a comment naming the
   Rails test it mirrors, so parity can be audited.

5. **Match Rails' behaviour, including the odd parts.** `pluralize("safe")` is
   `"saves"` in Rails and here. If you believe Rails is wrong, say so in a comment and
   match it anyway — applications being ported depend on the old answer.

6. **Mark deliberate shortcuts.** A simplification with a known ceiling gets a
   `ponytail:` comment naming the ceiling and the upgrade path, so it can be found
   later instead of rotting.

7. **Update `PARITY.md`.** Flip the status, record the ported test count, update the
   progress total.

## Running things

```sh
bun install
bun test                  # full suite
bun test --changed        # only what your branch touched
bun run typecheck
bun run port:fixtures     # needs the Rails clone
bunx oxlint        # lint
bunx oxfmt .       # format
```

## Pull requests

CI must be green: tests on Linux, macOS and Windows, typecheck, lint, and formatting.
The fixture-drift job is advisory — if it fails, Rails changed something upstream and
we should re-port, but it won't block you.
