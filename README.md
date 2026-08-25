<h1>Altair</h1>

**Ruby on Rails' conventions, rebuilt in TypeScript on Bun.**

Altair keeps the way Rails works — resourceful routing, ActiveRecord-style models,
migrations, generators, convention over configuration — and replaces everything
underneath it. Where Rails asks you to trust a string, Altair asks the compiler.

> Named after Altair: a star in Aquila, and the machine that started the personal
> computer era.

---

> [!WARNING]
> **Altair is pre-alpha.** It runs applications — there is an end-to-end test that boots
> one and serves requests through it — but nothing here is stable, and it has not been
> used for anything real. Follow [`PARITY.md`](PARITY.md) for what is migrated, measured
> against Rails rather than estimated.

## Why

Rails is 206,760 lines of library code. About a third of it solves problems that Bun 1.4
already solves — 21,714 of those lines are database drivers alone, and Bun ships
PostgreSQL, MySQL and SQLite in the runtime. Another 13,926 are HTML helpers that exist
because ERB cannot compose, which TSX makes unnecessary.

What is left is the part worth keeping: the conventions. Rebuilt on a runtime that starts
in 5 ms, deploys as a single binary, and lets the type system check what Rails checks at
runtime.

## What it looks like

```ts
// config/routes.ts
export default function routes(r: Mapper) {
  r.resources("posts", () => r.resources("comments"));
}

// app/models/post.ts
export class Post extends Model<PostRow>("posts") {
  declare comments: Comment[];

  static {
    this.hasMany("comments", () => Comment, { dependent: "destroy" });
    this.validates("title", { presence: true });
  }
}

// app/controllers/posts_controller.ts
export class PostsController extends Controller {
  async show() {
    const post = await Post.find(this.params.get("id"));

    // 304 and no body when the browser already has this version
    if (this.stale({ etag: post, lastModified: post.updated_at })) {
      await this.respondTo({
        html: async () => this.render.html(await renderToString(<Show post={post} />)),
        json: () => this.render.json(post),
      });
    }
  }
}
```

Three render targets from one controller API, chosen per action:

- **Hypermedia** — server-rendered TSX, no client JavaScript
- **Inertia** — typed props to React (or Solid), with server-side rendering
- **JSON** — negotiated from `Accept`, an extension, or a parameter

## Design decisions

- **Conventions resolve at build time, not runtime.** Rails uses metaprogramming; Altair
  generates typed manifests from the filesystem and the database schema. Same
  conventions, but your editor knows your columns.
- **Reuse the runtime, not a library.** `Bun.sql` for drivers, `Bun.password` for
  hashing, `Bun.Image` for variants, `Intl` for formatting and plurals, `HTMLRewriter`
  for sanitizing. Altair has no runtime dependencies at all, which is a decision it
  re-checks rather than assumes — see [`tools/log-benchmark.ts`](tools/log-benchmark.ts)
  for one of those checks.
- **No new template language.** TSX is the template language.
- **Rails' tests are the spec.** See [`TESTING.md`](TESTING.md).

## Getting started

Nothing published yet. To work on Altair:

```sh
bun install
bun test
./verify.sh     # format, typecheck, lint, test, and check PARITY's numbers
```

The ORM suite runs against SQLite by default and against PostgreSQL and MySQL in CI, so
anything marked done for ActiveRecord has passed on all three.

## Project layout

```
packages/
  support/     inflector, callbacks, cache, i18n, logging, durations, time zones
  orm/         connection, migrations, models, relations, associations, ActiveModel
  router/      resourceful routing, typed path helpers
  controller/  filters, params, rendering, sessions, CSRF, caching, negotiation
  view/        TSX rendering, layouts, forms, Inertia, fragment caching
  core/        config, boot, credentials, request handling, logging
  cli/         generators, database tasks, console, server
  jobs/        jobs, queues, retries, cron, worker
  mailer/      messages, TSX bodies, delivery, inbound mail
  storage/     disk and S3 services, blobs, attachments, variants, direct uploads
  cable/       Action Cable, protocol-compatible with Rails' client
  testing/     transactional tests, fixtures, factories, end-to-end tests
tools/
  port-fixtures.ts    generates test fixtures from a Rails clone
  check-parity.ts     keeps PARITY.md honest about its own numbers
  log-benchmark.ts    Altair's logger against the ones people usually reach for
```

## Documentation

- [`PARITY.md`](PARITY.md) — what is migrated, what is next, measured against Rails
- [`TESTING.md`](TESTING.md) — how the test suite mirrors Rails'
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — how to port a subsystem

## License

MIT
