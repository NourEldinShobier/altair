# Wiring

`PARITY.md` counts declarations. It answers "is this ported", which is the
right question for parity and the wrong one for whether an application gets
the benefit. A module can be complete, correct and thoroughly tested while no
code path in the framework routes through it, and the coverage number cannot
tell the difference.

`bun run tools/unwired-modules.ts` asks the other question: for each module,
does anything else in `src` name any of its exports? As of this writing, 106 of
336 modules do not.

That number is not a defect count. Three different things land in the list.

## Public API, by design

Application code calls it; framework code has no reason to. Every test helper
(`testing/*`), view component (`date_select`, `meta_tags`, `collection`),
migration DSL (`schema_creation`, `database_tasks`, `editor`) and standalone
support helper (`numbers`, `mutex`, `acts_like`) is here, correctly. This is
most of the list and needs nothing.

It is worth checking rather than assuming, though. `controller/instrumentation.ts`
and `controller/filtered_logging.ts` looked like this bucket and were not:
nothing published an action's timings, so an application got no request log at
all, and the module that redacts passwords out of one had nothing to redact
from. A middleware or a store an application installs — `permissions_policy`,
`session_store` — really is public API. A module the framework should be
calling on every request is not.

## A second implementation of something already done another way

These are worth attention, because two implementations means one of them is
what runs and the other is what gets maintained.

| Unwired                                                     | What actually runs                            |
| ----------------------------------------------------------- | --------------------------------------------- |
| `orm/preloader.ts`, `orm/preload_batching.ts`               | `preloadAssociation` in `orm/associations.ts` |
| `orm/binds.ts`, `orm/select_statements.ts`, `orm/arel.ts`\* | `relation.ts` builds SQL strings directly     |
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
- **`orm/record_pack.ts`** knew the shape of a payload and nothing about
  `Model`, which is what makes it testable without a database — and also what
  stopped it packing an actual record. `model_packing.ts` is the adapter.
- **`orm/schema_cache.ts`** could dump the schema to a file and load it back,
  and no model looked at it. `schemaReflection()` is the process-wide one a
  model now consults — but only once something has loaded a dump into it, so
  an application that never does behaves exactly as before. The per-model
  `columnCache` is still there and still what runs by default; which of the two
  should survive is the open question, not something this decided.
- **`controller/instrumentation.ts`** and **`controller/filtered_logging.ts`**
  were a complete request-log module with no publisher and a redactor with
  nothing to redact. `processAction` now publishes `start_processing` and
  `process_action`, with the parameters filtered before they leave the
  framework.
- **`mailer/delivery_registry.ts`** could hold a named delivery method and
  nothing consulted it, so an application could not plug in a
  transactional-email API however it registered one. `defaultDelivery` reads
  `MAIL_DELIVERY_METHOD` now, and the built-in methods register themselves the
  first time one is asked for rather than when the module is imported — an
  import-time side effect makes the order of imports decide what is registered,
  which a suite sharing one process between files cannot observe. That is not a
  guess: the first version registered on import, and the test proving it passed
  alone and failed in the full run.
- **`cable/worker_pool.ts`** had the hooks a channel action runs inside — the
  ones where a database connection is checked out and returned — and the server
  called `channel.dispatch` directly. So an action had no connection management
  at all, and `currentWork()` was always undefined, which made every line in a
  cable log anonymous. Subscribing, unsubscribing and every message go through
  `performWork` now. Calling it also exposed a bug in it: the running context
  was a module-level variable, which cannot survive two sockets working at
  once. It is an `AsyncLocalStorage` now.
- **`router/route_declaration.ts`** was a module this repository added and then
  never called, which is worth saying plainly. `router.ts` handles `via:`
  itself. Only the refusal is taken from it — `via: []` drew a route that
  exists and answers no method, findable by `url_for` and a 404 for every
  request — because the lowercasing there is for the symbols Rails' `via:`
  accepts and `Route` stores the method as it was written. An absent `via`
  still means GET, which is this router's own safer choice.

## A feature ported ahead of the thing it serves

- **`orm/join_dependency.ts`** builds column aliases for a single-JOIN eager
  load — `t0_r0`, `t0_r1`, and `extractRecord` to take them apart again.
  `includes` preloads with separate queries instead, which is Rails' default
  and correct. Nothing in the ORM issues the joined query these exist for.

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
