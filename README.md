<h1>Altair</h1>

**Ruby on Rails' conventions, rebuilt in TypeScript on Bun.**

Altair keeps the way Rails works — resourceful routing, ActiveRecord-style models,
migrations, generators, convention over configuration — and replaces everything
underneath it. Where Rails asks you to trust a string, Altair asks the compiler.

> Named after Altair: a star in Aquila, and the machine that started the personal
> computer era.

---

> [!WARNING]
> **Altair is pre-alpha and under active construction.** It does not run applications
> yet. Follow [`PARITY.md`](PARITY.md) for what's been migrated.

## Why

Rails is 206,760 lines of library code. About a third of it solves problems that Bun 1.4
already solves — 21,714 of those lines are database drivers alone, and Bun ships
PostgreSQL, MySQL and SQLite in the runtime. Another 13,926 are HTML helpers that exist
because ERB can't compose, which TSX makes unnecessary.

What's left is the part worth keeping: the conventions. Rebuilt on a runtime that starts
in 5 ms, deploys as a single binary, and lets the type system check what Rails checks at
runtime.

## What it looks like

```ts
// config/routes.ts
router.resources("posts", (r) => r.resources("comments"));

// app/controllers/posts_controller.ts
export default class PostsController {
  async show({ params, render }: Context) {
    const post = await Post.find(params.id).includes("author");

    // props are type-checked against app/pages/posts/show.tsx
    return render("posts/show", { post, canEdit: Current.user?.owns(post) });
  }
}
```

Three render targets from one controller API, chosen per action:

- **Hypermedia** — server-rendered TSX, no client JavaScript
- **Inertia** — typed props to React (or Solid), with server-side rendering
- **JSON** — typed serializers

## Design decisions

- **Conventions resolve at build time, not runtime.** Rails uses metaprogramming;
  Altair generates typed manifests from the filesystem and the database schema. Same
  conventions, but your editor knows your columns.
- **Reuse beats rewrite.** `Bun.sql` for drivers, a typed query builder under the ORM,
  Zod for validation, Vite for the browser. We write the conventions, not the plumbing.
- **No new template language.** TSX is the template language.
- **Rails' tests are the spec.** See [`TESTING.md`](TESTING.md).

## Getting started

Nothing to install yet. To work on Altair:

```sh
bun install
bun test
```

## Project layout

```
packages/
  support/     @altair/support — inflector, callbacks, cache
tools/
  port-fixtures.ts   generates test fixtures from a Rails clone
```

## Documentation

- [`PARITY.md`](PARITY.md) — what's migrated, what's next, measured against Rails
- [`TESTING.md`](TESTING.md) — how the test suite mirrors Rails'
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — how to port a subsystem

## License

MIT
