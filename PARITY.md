# Parity tracker

What has been migrated from Rails, and what hasn't. Every number here was measured from
a clone of `rails/rails@main` (8.2.0.alpha), not estimated.

**Totals to beat:** 206,760 lines of library code across 1,502 files, covered by
**26,775 test methods across 1,871 files.**

Status key: **done** · **wip** · **next** · **todo** · **n/a** (Bun or the language
already provides it)

---

## Progress

|           | Tests ported | of Rails' |      |
| --------- | ------------ | --------- | ---- |
| **Total** | **1,079**    | 26,775    | 4.0% |

---

## ActiveSupport → `@altair/support`

Rails: 36,129 lines · 3,670 tests

| Subsystem                   | Rails LOC | Rails tests | Status   | Notes                                               |
| --------------------------- | --------- | ----------- | -------- | --------------------------------------------------- |
| Inflector                   | 972       | ~120        | **done** | 544 tests, 246 fixture cases ported                 |
| Callbacks                   | 1,048     | 59          | **done** | 34 tests; async chains, halting, inheritance        |
| Cache                       | 3,951     | —           | **done** | Stores over `Bun.RedisClient`, SQLite, memory       |
| Notifications               | 769       | —           | todo     | Instrumentation bus                                 |
| CurrentAttributes           | —         | —           | todo     | `AsyncLocalStorage`                                 |
| Core extensions             | 8,549     | —           | **n/a**  | JavaScript has these; port only what's load-bearing |
| Duration / TimeWithZone     | ~1,200    | —           | todo     | `Temporal` where possible                           |
| MessageEncryptor / Verifier | 576       | —           | **done** | AES-256-GCM, HMAC, PBKDF2 key derivation            |
| XmlMini                     | 650       | —           | **n/a**  | `Bun.XML`                                           |

## ActiveRecord → `@altair/orm`

Rails: 71,873 lines · 10,602 tests — the largest single body of work

| Subsystem                   | Rails LOC | Status   | Notes                                                   |
| --------------------------- | --------- | -------- | ------------------------------------------------------- |
| Connection adapters         | 21,714    | **n/a**  | `Bun.sql` — Postgres, MySQL/MariaDB, SQLite             |
| Attributes & dirty tracking | 1,144     | **done** | Typed via an attributes interface                       |
| Persistence                 | 1,006     | **done** | save, update, destroy, create, reload                   |
| Associations                | 6,031     | **wip**  | belongsTo/hasMany/hasOne/through/polymorphic + includes |
| Relation / query interface  | 5,579     | **wip**  | where/order/limit/pluck/each; lazy thenable             |
| Migrations                  | 2,705     | **done** | DSL, versions, rollback; type emission todo             |
| Validations                 | —         | **wip**  | errors object, save/saveOrFail                          |
| Callbacks                   | —         | **done** | save/create/update/destroy/validation chains            |
| Encryption                  | 2,046     | todo     | Late phase                                              |
| Fixtures                    | 860       | todo     | Needed early for testing other packages                 |

## ActionPack → `@altair/router`, `@altair/controller`

Rails: 30,329 lines · 3,828 tests

| Subsystem                 | Rails LOC | Rails tests | Status   | Notes                                                  |
| ------------------------- | --------- | ----------- | -------- | ------------------------------------------------------ |
| Routing DSL & recognition | 4,816     | 305 + 79    | **done** | 44 tests; resources, nesting, member/collection, scope |
| Typed path helpers        | —         | —           | **done** | New surface; generated per named route                 |
| Journey (route matcher)   | 2,190     | —           | **done** | Compiled regex per route, verb-bucketed                |
| Controllers               | 9,508     | —           | **next** | Filters, strong params, rendering                      |
| Middleware stack          | 4,749     | —           | todo     | Plain functions over one context                       |
| Request / Response        | 4,673     | 1,733       | todo     | Web `Request`/`Response` underneath                    |
| CSRF protection           | —         | 2,029       | todo     | Security-critical: full port, no shortcuts             |
| Cookies & sessions        | —         | 1,651       | todo     |                                                        |
| Content Security Policy   | 842       | —           | todo     |                                                        |

## ActionView → `@altair/view`

Rails: 21,159 lines · 2,699 tests

| Subsystem                          | Rails LOC | Status   | Notes                                |
| ---------------------------------- | --------- | -------- | ------------------------------------ |
| Helpers (form, tag, asset, number) | 13,926    | **n/a**  | TSX composes; these disappear        |
| Template resolution & layouts      | 2,356     | **done** | Layouts and partials are components  |
| Renderer                           | 1,178     | **done** | TSX → string; Inertia protocol; JSON |
| Number/date formatting             | ~1,000    | todo     | `Intl`                               |

## Everything else

| Component                        | Rails LOC | Rails tests | Target                        | Status                                       |
| -------------------------------- | --------- | ----------- | ----------------------------- | -------------------------------------------- |
| Railties (boot, generators, CLI) | 16,874    | 2,791       | `@altair/cli`, `@altair/core` | **wip** — boot, config, generators, db tasks |
| ActiveModel                      | 9,210     | 1,091       | `@altair/orm`                 | **wip** — validations done                   |
| ActiveJob                        | 4,965     | 515         | `@altair/jobs`                | todo                                         |
| ActionCable                      | 4,496     | 220         | `@altair/cable`               | todo — `Bun.serve` WebSockets                |
| ActiveStorage                    | 4,110     | 626         | `@altair/storage`             | todo — `Bun.S3Client` + `Bun.Image`          |
| ActionMailer                     | 2,795     | 292         | `@altair/mailer`              | todo                                         |
| ActionText                       | 2,617     | 318         | —                             | todo — late phase                            |
| ActionMailbox                    | 750       | 123         | —                             | todo — late phase                            |

---

## How to update this file

When you finish a subsystem: flip its status, record the ported test count, and update
the progress table at the top. `bun test` prints the current total.
