# Wiring

`PARITY.md` counts declarations. It answers "is this ported", which is the
right question for parity and the wrong one for whether an application gets
the benefit. A module can be complete, correct and thoroughly tested while no
code path in the framework routes through it, and the coverage number cannot
tell the difference.

`bun run tools/unwired-modules.ts` asks the other question: for each module,
does anything else in `src` name any of its exports? As of this writing, 112 of
335 modules do not.

That number is not a defect count. Three different things land in the list.

## Public API, by design

Application code calls it; framework code has no reason to. Every test helper
(`testing/*`), view component (`date_select`, `meta_tags`, `collection`),
migration DSL (`schema_creation`, `database_tasks`, `editor`) and standalone
support helper (`numbers`, `mutex`, `acts_like`) is here, correctly. This is
most of the list and needs nothing.

## A second implementation of something already done another way

These are worth attention, because two implementations means one of them is
what runs and the other is what gets maintained.

| Unwired                                                     | What actually runs                            |
| ----------------------------------------------------------- | --------------------------------------------- |
| `orm/preloader.ts`, `orm/preload_batching.ts`               | `preloadAssociation` in `orm/associations.ts` |
| `orm/binds.ts`, `orm/select_statements.ts`, `orm/arel.ts`\* | `relation.ts` builds SQL strings directly     |
| `orm/schema_cache.ts`                                       | each model's own `columnCache`                |
| `orm/generated_methods.ts`                                  | nothing generates methods through it          |
| `orm/attribute_patterns.ts`, `orm/attribute_methods.ts`     | attribute handling inside `model.ts`          |

None of these is wrong. Each was ported against its Rails counterpart and each
has its own tests. The question they raise is which one should survive, and
that is a decision rather than a bug.

## Joined up since

- **`support/file_update_checker.ts`** and the `Reloader` in `execution.ts`
  were two halves nothing connected, so nothing reloaded on an edit.
  `watchForChanges` in `autoloading.ts` is the joint — and it also gave
  `directoriesToWatch` and `watchedDirsWithExtensions`, which existed for
  exactly this and had no caller, something to do.

## A feature ported ahead of the thing it serves

- **`orm/join_dependency.ts`** builds column aliases for a single-JOIN eager
  load — `t0_r0`, `t0_r1`, and `extractRecord` to take them apart again.
  `includes` preloads with separate queries instead, which is Rails' default
  and correct. Nothing in the ORM issues the joined query these exist for.
- **`orm/record_pack.ts`** turns a record into a cacheable payload and back,
  through a `RecordReader`/`RecordWriter` pair. No adapter for `Model` exists,
  so nothing can pack an actual record yet.

## What the tool can and cannot see

It matches exported names, not import paths, because a package's `index.ts`
re-exports everything and cross-package callers name the symbol either way. An
`index.ts` is never counted as a caller: re-exporting a thing is not using it.

Two false-positive modes are handled, and both were found by checking a result
by hand rather than by trusting it. Comments are stripped, because
`preloader.ts` read as called on the strength of another module _mentioning it
in a sentence_. And a name the other module declares for itself is discounted,
because `relation.ts` has its own `WhereClause` interface and `arel.ts` exports
one too.

\* One mode is left. A _method_ of the same name still reads as a call:
`relation.ts` has a `toSql()` method and `arel.ts` exports a `toSql`, so
`arel.ts` does not appear in the list even though nothing calls it. Telling
`foo() {` in a class from `foo();` in a function body needs a parser rather
than a regex, so instead there is `--why`, which prints every match with the
file it came from:

```
bun run tools/unwired-modules.ts --why=orm/src/arel.ts
```

Both of its matches are collisions, which takes seconds to see and would take a
parser to rule out. Assume the list is a floor, not a total.
