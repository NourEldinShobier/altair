# Parity tracker

What has been migrated from Rails, and what hasn't. Every Rails number here was
measured from a clone of `rails/rails@main` (8.2.0.alpha), not estimated.

**Totals to beat:** 206,760 lines of library code across 1,502 files, covered by
**26,775 test methods across 1,871 files.**

|           | Tests     | of Rails' |       |
| --------- | --------- | --------- | ----- |
| **Total** | **3,337** | 26,775    | 12.5% |

Status key: **done** · **wip** · **next** · **todo** · **n/a** (Bun or the
language already provides it)

The ORM suite runs against SQLite, PostgreSQL and MySQL/MariaDB on every push.
Anything marked done for ActiveRecord has passed on all three, not just on the
one that needs no server.

---

## Shipped

| Package              | Tests | Covers                                                                     |
| -------------------- | ----- | -------------------------------------------------------------------------- |
| `@altair/support`    | 853   | Inflector, callbacks, cache, i18n, logging, durations, time zones          |
| `@altair/orm`        | 852   | Connection, migrations, models, relations, associations, ActiveModel       |
| `@altair/controller` | 459   | Filters, strong params, rendering, dispatch, cookies, sessions, CSRF, i18n |
| `@altair/cli`        | 174   | Generators, db tasks, file loading, encrypted credentials                  |
| `@altair/router`     | 97    | Resourceful routing, typed path helpers                                    |
| `@altair/cable`      | 58    | Action Cable, protocol-compatible with Rails' client                       |
| `@altair/storage`    | 158   | Disk and S3 services, blobs, attachments, variants, direct uploads         |
| `@altair/view`       | 231   | TSX rendering, layouts, Inertia protocol, form builders                    |
| `@altair/jobs`       | 113   | Jobs, queues, retries, worker                                              |
| `@altair/testing`    | 75    | Transactional tests, fixtures, factories, test databases                   |
| `@altair/core`       | 149   | Config, boot lifecycle, request handler, credentials, logging              |
| `@altair/mailer`     | 118   | Messages, TSX bodies, delivery methods                                     |

---

## ActiveSupport → `@altair/support`

Rails: 36,129 lines · 3,670 tests

| Subsystem                   | Rails LOC | Status   | Notes                                              |
| --------------------------- | --------- | -------- | -------------------------------------------------- |
| Inflector                   | 972       | **done** | 246 fixture cases ported from Rails                |
| Callbacks                   | 1,048     | **done** | Async chains, halting, inheritance, decorators     |
| Cache                       | 3,951     | **done** | Memory and Redis stores, atomic counters, failsafe |
| MessageEncryptor / Verifier | 576       | **done** | AES-256-GCM, HMAC, PBKDF2                          |
| Notifications               | 769       | **done** | Instrumentation bus; ORM reports every query       |
| CurrentAttributes           | —         | **done** | `AsyncLocalStorage`; scoped per request            |
| Duration / TimeWithZone     | ~1,200    | **done** | `Intl`; Temporal is not in Bun 1.4                 |
| I18n                        | 2,180     | **done** | Rails' keys and `%{…}`; plurals from `Intl`        |
| Logger / TaggedLogging      | 490       | **done** | Levels, JSON or text, tags in `AsyncLocalStorage`  |
| ErrorReporter               | 240       | **done** | `handle` swallows, `record` re-raises              |
| Number / date formatting    | ~1,000    | **done** | `Intl`, in @altair/view                            |
| Core extensions             | 8,549     | **n/a**  | JavaScript has these                               |
| XmlMini                     | 650       | **n/a**  | `Bun.XML`                                          |

## ActiveRecord → `@altair/orm`

Rails: 71,873 lines · 10,602 tests — the largest remaining block

| Subsystem                     | Rails LOC | Status   | Notes                                                            |
| ----------------------------- | --------- | -------- | ---------------------------------------------------------------- |
| Connection adapters           | 21,714    | **n/a**  | `Bun.sql`                                                        |
| Attributes & dirty tracking   | 1,144     | **done** | Typed via an attributes interface                                |
| Persistence                   | 1,006     | **done** | save, update, destroy, create, reload                            |
| Migrations                    | 2,705     | **done** | DSL, versions, rollback, opt-in foreign keys                     |
| Callbacks                     | —         | **done** | save/create/update/destroy/validation, `afterCommit`             |
| Validations                   | —         | **done** | presence, length, format, uniqueness, associated, and the rest   |
| Associations                  | 6,031     | **done** | All kinds, both polymorphic directions, `includes`, `dependent`  |
| Relation / query interface    | 5,579     | **done** | where/order/group/aggregates/scopes/bulk writes, joins           |
| Fixtures & test helpers       | 860       | **done** | Transactional tests, fixtures, factories, time travel, job spies |
| Schema dump & type emission   | —         | **done** | Types generated from the database itself                         |
| Nested attributes             | 1,146     | **done** | Collections, to-one, to-many, `_destroy`, limit, rejectIf        |
| Single-table inheritance      | —         | **done** | Subclass queries, typed instantiation, `unscoped`                |
| Enums                         | 291       | **done** | Words in the app, integers in the column, mapped in queries      |
| Normalization                 | 180       | **done** | `normalizes`, applied on write and in the lookups                |
| Default scopes & tokens       | 420       | **done** | `defaultScope` (reads only), `hasSecureToken`                    |
| Serialized columns            | 640       | **done** | `serialize`/`store`, dirty tracking sees an in-place edit        |
| Counter cache                 | —         | **done** | Adjusted on create and destroy                                   |
| Touch / cache invalidation    | —         | **done** | `touch`, `belongsTo(touch: true)`, keyed off `cacheKey`          |
| Optimistic locking            | —         | **done** | `lock_version`, StaleObjectError                                 |
| Pessimistic locking           | —         | **done** | `lock()`, `withLock`, per-adapter; SQLite needs none             |
| Multiple databases & sharding | —         | **done** | Named databases, roles, read-only guard, horizontal shards       |
| Encryption                    | 2,046     | **done** | Deterministic and random-nonce, queryable when deterministic     |

## ActionPack → `@altair/router`, `@altair/controller`

Rails: 30,329 lines · 3,828 tests

| Subsystem                 | Rails LOC | Status   | Notes                                                   |
| ------------------------- | --------- | -------- | ------------------------------------------------------- |
| Routing DSL & recognition | 4,816     | **done** | resources, nesting, member/collection, scope            |
| Journey (route matcher)   | 2,190     | **done** | Compiled regex per route, verb-bucketed                 |
| Typed path helpers        | —         | **done** | Generated from the route table, arity and all           |
| Polymorphic paths         | 380       | **done** | `polymorphicPath(record)`, new vs saved, nesting        |
| Controllers & filters     | 9,508     | **done** | only/except, halting, inheritance                       |
| Strong parameters         | —         | **done** | Plus schema validation via Standard Schema              |
| Cookies & sessions        | —         | **done** | Plain/signed/encrypted jars, flash                      |
| CSRF protection           | —         | **done** | Masked tokens, constant-time compare                    |
| Request / Response        | 4,673     | **n/a**  | Web `Request`/`Response`                                |
| Middleware stack          | 4,749     | **done** | Functions; cors, ssl, security headers, id              |
| Content Security Policy   | 842       | **done** | Directive builder, per-request nonce, report-only       |
| Rate limiting             | —         | **done** | Fixed window over the cache store, 429 with retry-after |
| HTTP caching              | 620       | **done** | ETags, `freshWhen`/`stale`, 304, `Cache-Control`        |

## ActionView → `@altair/view`

Rails: 21,159 lines · 2,699 tests

| Subsystem                          | Rails LOC | Status   | Notes                                                 |
| ---------------------------------- | --------- | -------- | ----------------------------------------------------- |
| Renderer                           | 1,178     | **done** | TSX → string, escaping, async components              |
| Template resolution & layouts      | 2,356     | **done** | Layouts and partials are components                   |
| Inertia protocol                   | —         | **done** | New surface; renderer-agnostic                        |
| Helpers (form, tag, asset, number) | 13,926    | **done** | Imports, not a mixin; Intl does the formatting        |
| Form builders                      | —         | **done** | A component and a builder, not 3,000 lines of helpers |
| Vite integration                   | —         | **done** | Manifest, import-graph CSS, dev server, nonce-aware   |
| Fragment caching                   | 1,120     | **done** | `<Cached on={record}>`, nested, keyed on `cacheKey`   |

## Everything else

| Component                        | Rails LOC | Rails tests | Target                        | Status                                 |
| -------------------------------- | --------- | ----------- | ----------------------------- | -------------------------------------- |
| ActionCable                      | 4,496     | 220         | `@altair/cable`               | **done**                               |
| ActionMailer                     | 2,795     | 292         | `@altair/mailer`              | **done** — previews and attachments    |
| ActiveJob                        | 4,965     | 515         | `@altair/jobs`                | **done** — waits for the transaction   |
| Railties (boot, generators, CLI) | 16,874    | 2,791       | `@altair/cli`, `@altair/core` | **done** — environments, health check  |
| ActiveModel                      | 9,210     | 1,091       | `@altair/orm`                 | **done** — typed attributes and naming |
| ActiveStorage                    | 4,110     | 626         | `@altair/storage`             | **done** — variants and direct uploads |
| ActionText                       | 2,617     | 318         | `@altair/orm`, `@altair/view` | **done** — rich text and sanitizing    |
| ActionMailbox                    | 750       | 123         | `@altair/mailer`              | **done** — routing, ingress, retries   |

---

## What is left, in short

Every Rails component now has an Altair counterpart that runs and is tested,
ActionText and ActionMailbox included. What remains is depth in the parts
already standing, and the gaps recorded here.

**Image variants are built, on `Bun.Image`.** This file said twice that the
API did not exist. It does, and both checks were run against a Bun 1.3
runtime while the types and CI were on 1.4 — the wrong thing was tested, and
the result was written down as fact. Bun 1.4 ships libjpeg-turbo, libspng and
libwebp statically with SIMD resize and rotate, so a variant needs no libvips,
no ImageMagick and no native module to build, which is less than Rails needs.

**Direct uploads are built too**, so ActiveStorage is done. One thing works
less well here than in Rails: on S3 the presigned PUT cannot enforce the
declared content type or size, because Bun's presigner signs only `host`.
Content-MD5 is still checked by the bucket, and the disk service enforces all
three. Enforcing the rest needs a presigned POST policy, which Bun does not
generate yet.

**ActiveModel is done**: tableless models, naming, serialization, dirty
tracking, and the errors API in full.

**Internationalization is done**, which it was not before: every framework
message was a hard-coded English string. Keys and interpolation match the i18n
gem exactly, so rails-i18n's forty languages drop in. Plural categories come
from `Intl.PluralRules` rather than a one/other switch, so Polish gets `few`
and `many` without the plugin Rails needs.

**Batching was broken and is fixed.** `each()` paged with OFFSET, so a loop
that destroyed as it went saw ten of twenty rows and said nothing. Batches now
walk a cursor, as Rails does.

There is a logger now, with tags in an `AsyncLocalStorage`, a request log that
reports what the database did inside each request, and an error reporter for
an application to hang Sentry or its equivalent off. It is written here rather
than taken from a package, and the reason is the dependency, not the speed.
Measured head to head on Bun 1.4 with output discarded: 400ns an enabled call
here, 439 consola, 463 pino, 581 LogTape, 1047 winston. Nothing on offer is
faster, and pino brings 14 packages where winston brings 28 — a cost a
framework pays on behalf of every application built on it.

An earlier version of this file quoted a published benchmark showing pino at
773ns on Bun and claimed `pino-pretty` would not run there. Neither
reproduced: the numbers were someone else's machine and harness, and
pino-pretty works under Bun 1.4.

**Railties is done**, which makes every Rails component done. `config/
environments/<env>.ts` layers over the defaults, `config/initializers/*.ts`
run in filename order at boot, and `altair db:seed` runs `db/seeds.ts`.

What remains everywhere is depth: 12.5% of Rails' test count, not 12.5% of Rails.

## How to update this file

Flip a subsystem's status when you finish it. The numbers look after
themselves:

    bun run tools/check-parity.ts --fix

`verify.sh` runs the same script without `--fix` and fails if a row disagrees
with the suite, because these numbers had drifted three times before anything
was checking them — and a wrong number here is worse than a wrong number
anywhere else in the repository, since this file is the claim people read.
