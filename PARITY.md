# Parity tracker

What has been migrated from Rails, and what hasn't. Every Rails number here was
measured from a clone of `rails/rails@main` (8.2.0.alpha), not estimated.

**Totals to beat:** 206,760 lines of library code across 1,502 files, covered by
**26,775 test methods across 1,871 files.**

|           | Tests     | of Rails' |      |
| --------- | --------- | --------- | ---- |
| **Total** | **1,233** | 26,775    | 4.6% |

Status key: **done** · **wip** · **next** · **todo** · **n/a** (Bun or the
language already provides it)

---

## Shipped

| Package              | Tests | Covers                                                                      |
| -------------------- | ----- | --------------------------------------------------------------------------- |
| `@altair/support`    | 648   | Inflector, callbacks + decorators, cache, message signing/encryption        |
| `@altair/orm`        | 176   | Connection, migrations, models, relations, associations, validations        |
| `@altair/controller` | 130   | Filters, strong params, rendering, dispatch, cookies, sessions, flash, CSRF |
| `@altair/cli`        | 66    | Generators, db tasks, file loading                                          |
| `@altair/router`     | 44    | Resourceful routing, typed path helpers                                     |
| `@altair/cable`      | 43    | Action Cable, protocol-compatible with Rails' client                        |
| `@altair/view`       | 39    | TSX rendering, layouts, Inertia protocol                                    |
| `@altair/jobs`       | 34    | Jobs, queues, retries, worker                                               |
| `@altair/core`       | 27    | Config, boot lifecycle, request handler                                     |
| `@altair/mailer`     | 21    | Messages, TSX bodies, delivery methods                                      |

---

## ActiveSupport → `@altair/support`

Rails: 36,129 lines · 3,670 tests

| Subsystem                   | Rails LOC | Status   | Notes                                          |
| --------------------------- | --------- | -------- | ---------------------------------------------- |
| Inflector                   | 972       | **done** | 246 fixture cases ported from Rails            |
| Callbacks                   | 1,048     | **done** | Async chains, halting, inheritance, decorators |
| Cache                       | 3,951     | **done** | Memory and Redis stores                        |
| MessageEncryptor / Verifier | 576       | **done** | AES-256-GCM, HMAC, PBKDF2                      |
| Notifications               | 769       | **done** | Instrumentation bus; ORM reports every query   |
| CurrentAttributes           | —         | **done** | `AsyncLocalStorage`; scoped per request        |
| Duration / TimeWithZone     | ~1,200    | todo     | `Temporal` where it fits                       |
| Number / date formatting    | ~1,000    | todo     | `Intl`                                         |
| Core extensions             | 8,549     | **n/a**  | JavaScript has these                           |
| XmlMini                     | 650       | **n/a**  | `Bun.XML`                                      |

## ActiveRecord → `@altair/orm`

Rails: 71,873 lines · 10,602 tests — the largest remaining block

| Subsystem                     | Rails LOC | Status   | Notes                                                    |
| ----------------------------- | --------- | -------- | -------------------------------------------------------- |
| Connection adapters           | 21,714    | **n/a**  | `Bun.sql`                                                |
| Attributes & dirty tracking   | 1,144     | **done** | Typed via an attributes interface                        |
| Persistence                   | 1,006     | **done** | save, update, destroy, create, reload                    |
| Migrations                    | 2,705     | **done** | DSL, versions, rollback                                  |
| Callbacks                     | —         | **done** | save/create/update/destroy/validation                    |
| Validations                   | —         | **done** | presence, length, format, uniqueness, and the rest       |
| Associations                  | 6,031     | **wip**  | belongsTo/hasMany/hasOne/through/polymorphic, `includes` |
| Relation / query interface    | 5,579     | **wip**  | where/order/group/aggregates/scopes/bulk writes          |
| Fixtures & test helpers       | 860       | **next** | Transactional tests, factories; schema:load ready        |
| Schema dump & type emission   | —         | **done** | Types generated from the database itself                 |
| Nested attributes             | —         | todo     |                                                          |
| Single-table inheritance      | —         | todo     |                                                          |
| Counter cache                 | —         | todo     |                                                          |
| Optimistic locking            | —         | todo     |                                                          |
| Multiple databases & sharding | —         | todo     |                                                          |
| Encryption                    | 2,046     | todo     | Late phase                                               |

## ActionPack → `@altair/router`, `@altair/controller`

Rails: 30,329 lines · 3,828 tests

| Subsystem                 | Rails LOC | Status   | Notes                                        |
| ------------------------- | --------- | -------- | -------------------------------------------- |
| Routing DSL & recognition | 4,816     | **done** | resources, nesting, member/collection, scope |
| Journey (route matcher)   | 2,190     | **done** | Compiled regex per route, verb-bucketed      |
| Typed path helpers        | —         | **done** | New surface Rails cannot have                |
| Controllers & filters     | 9,508     | **done** | only/except, halting, inheritance            |
| Strong parameters         | —         | **done** | Plus schema validation via Standard Schema   |
| Cookies & sessions        | —         | **done** | Plain/signed/encrypted jars, flash           |
| CSRF protection           | —         | **done** | Masked tokens, constant-time compare         |
| Request / Response        | 4,673     | **n/a**  | Web `Request`/`Response`                     |
| Middleware stack          | 4,749     | **done** | Functions; cors, ssl, security headers, id   |
| Content Security Policy   | 842       | todo     |                                              |
| Rate limiting             | —         | todo     |                                              |

## ActionView → `@altair/view`

Rails: 21,159 lines · 2,699 tests

| Subsystem                          | Rails LOC | Status   | Notes                                    |
| ---------------------------------- | --------- | -------- | ---------------------------------------- |
| Renderer                           | 1,178     | **done** | TSX → string, escaping, async components |
| Template resolution & layouts      | 2,356     | **done** | Layouts and partials are components      |
| Inertia protocol                   | —         | **done** | New surface; renderer-agnostic           |
| Helpers (form, tag, asset, number) | 13,926    | **n/a**  | TSX composes; these disappear            |
| Form builders                      | —         | todo     | A component, not 3,000 lines of helpers  |
| Vite integration                   | —         | todo     | Asset manifest, dev server               |

## Everything else

| Component                        | Rails LOC | Rails tests | Target                        | Status                                  |
| -------------------------------- | --------- | ----------- | ----------------------------- | --------------------------------------- |
| ActionCable                      | 4,496     | 220         | `@altair/cable`               | **done**                                |
| ActionMailer                     | 2,795     | 292         | `@altair/mailer`              | **wip** — previews, attachments todo    |
| ActiveJob                        | 4,965     | 515         | `@altair/jobs`                | **wip** — cron and more adapters todo   |
| Railties (boot, generators, CLI) | 16,874    | 2,791       | `@altair/cli`, `@altair/core` | **wip** — dev server, console todo      |
| ActiveModel                      | 9,210     | 1,091       | `@altair/orm`                 | **wip** — validations done              |
| ActiveStorage                    | 4,110     | 626         | `@altair/storage`             | **next** — `Bun.S3Client` + `Bun.Image` |
| ActionText                       | 2,617     | 318         | —                             | todo — late phase                       |
| ActionMailbox                    | 750       | 123         | —                             | todo — late phase                       |

---

## What is left, in short

The framework's shape is complete: every Rails component has an Altair
counterpart that runs. What remains is depth, and most of it is in ActiveRecord
— fixtures and test helpers, schema dump and type emission, nested attributes,
STI, counter caches, locking and multiple databases. After that: ActiveStorage,
the middleware stack, ActiveSupport's instrumentation and time handling, form
builders, and the dev server. ActionText and ActionMailbox are deliberately
last, being the two components most applications never touch.

## How to update this file

When you finish a subsystem: flip its status, update the shipped table, and
update the total. `bun test` prints the current number.
