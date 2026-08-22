# Parity tracker

What has been migrated from Rails, and what hasn't. Every Rails number here was
measured from a clone of `rails/rails@main` (8.2.0.alpha), not estimated.

**Totals to beat:** 206,760 lines of library code across 1,502 files, covered by
**26,775 test methods across 1,871 files.**

|           | Tests     | of Rails' |      |
| --------- | --------- | --------- | ---- |
| **Total** | **1,428** | 26,775    | 5.3% |

Status key: **done** · **wip** · **next** · **todo** · **n/a** (Bun or the
language already provides it)

The ORM suite runs against SQLite, PostgreSQL and MySQL/MariaDB on every push.
Anything marked done for ActiveRecord has passed on all three, not just on the
one that needs no server.

---

## Shipped

| Package              | Tests | Covers                                                                      |
| -------------------- | ----- | --------------------------------------------------------------------------- |
| `@altair/support`    | 649   | Inflector, callbacks + decorators, cache, message signing/encryption        |
| `@altair/orm`        | 284   | Connection, migrations, models, relations, associations, validations        |
| `@altair/controller` | 132   | Filters, strong params, rendering, dispatch, cookies, sessions, flash, CSRF |
| `@altair/cli`        | 67    | Generators, db tasks, file loading                                          |
| `@altair/router`     | 45    | Resourceful routing, typed path helpers                                     |
| `@altair/cable`      | 43    | Action Cable, protocol-compatible with Rails' client                        |
| `@altair/storage`    | 56    | Disk and S3 services, blobs, attachments, signed URLs                       |
| `@altair/view`       | 39    | TSX rendering, layouts, Inertia protocol                                    |
| `@altair/jobs`       | 34    | Jobs, queues, retries, worker                                               |
| `@altair/testing`    | 31    | Transactional tests, fixtures, factories, test databases                    |
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

| Subsystem                     | Rails LOC | Status   | Notes                                                              |
| ----------------------------- | --------- | -------- | ------------------------------------------------------------------ |
| Connection adapters           | 21,714    | **n/a**  | `Bun.sql`                                                          |
| Attributes & dirty tracking   | 1,144     | **done** | Typed via an attributes interface                                  |
| Persistence                   | 1,006     | **done** | save, update, destroy, create, reload                              |
| Migrations                    | 2,705     | **done** | DSL, versions, rollback, opt-in foreign keys                       |
| Callbacks                     | —         | **done** | save/create/update/destroy/validation                              |
| Validations                   | —         | **done** | presence, length, format, uniqueness, and the rest                 |
| Associations                  | 6,031     | **wip**  | belongsTo/hasMany/hasOne/through/polymorphic both ways, `includes` |
| Relation / query interface    | 5,579     | **wip**  | where/order/group/aggregates/scopes/bulk writes                    |
| Fixtures & test helpers       | 860       | **done** | Transactional tests, savepoint nesting, fixtures, factories        |
| Schema dump & type emission   | —         | **done** | Types generated from the database itself                           |
| Nested attributes             | 1,146     | **done** | Collections, to-one, to-many, `_destroy`, limit, rejectIf          |
| Single-table inheritance      | —         | **done** | Subclass queries, typed instantiation, `unscoped`                  |
| Counter cache                 | —         | **done** | Adjusted on create and destroy                                     |
| Optimistic locking            | —         | **done** | `lock_version`, StaleObjectError                                   |
| Multiple databases & sharding | —         | **wip**  | Named databases, roles, read-only guard; no sharding yet           |
| Encryption                    | 2,046     | todo     | Late phase                                                         |

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

| Component                        | Rails LOC | Rails tests | Target                        | Status                                |
| -------------------------------- | --------- | ----------- | ----------------------------- | ------------------------------------- |
| ActionCable                      | 4,496     | 220         | `@altair/cable`               | **done**                              |
| ActionMailer                     | 2,795     | 292         | `@altair/mailer`              | **wip** — previews, attachments todo  |
| ActiveJob                        | 4,965     | 515         | `@altair/jobs`                | **wip** — cron and more adapters todo |
| Railties (boot, generators, CLI) | 16,874    | 2,791       | `@altair/cli`, `@altair/core` | **wip** — dev server, console todo    |
| ActiveModel                      | 9,210     | 1,091       | `@altair/orm`                 | **wip** — validations done            |
| ActiveStorage                    | 4,110     | 626         | `@altair/storage`             | **wip** — no variants (see below)     |
| ActionText                       | 2,617     | 318         | —                             | todo — late phase                     |
| ActionMailbox                    | 750       | 123         | —                             | todo — late phase                     |

---

## What is left, in short

The framework's shape is complete: every Rails component has an Altair
counterpart that runs. What remains is depth. Next up: form builders, Vite
integration and the dev server, then ActiveSupport's time handling and number
formatting, content security policy and rate limiting. ActionText and
ActionMailbox are deliberately last, being the two components most
applications never touch.

**Image variants are not built.** Early research recorded a `Bun.Image` API;
it does not exist in Bun 1.4, which was checked rather than assumed the second
time. Variants need an image library, so they wait until it is worth taking
that dependency. Everything else ActiveStorage does — services, blobs,
attachments, signed URLs, purging — is here.

Horizontal sharding is also not built, and direct uploads from the browser
have no endpoint yet.

## How to update this file

When you finish a subsystem: flip its status, update the shipped table, and
update the total. `bun test` prints the current number.
