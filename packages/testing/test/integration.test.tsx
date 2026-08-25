/**
 * A whole application, end to end.
 *
 * Mirrors what Rails puts in `test/integration`: not a unit of anything, but a
 * real application booted and served real requests. It exists because three
 * bugs got through a suite of two thousand passing unit tests — every one of
 * them living *between* two features rather than inside either.
 *
 *   - a cache key cut to whole seconds, so `touch` moved the clock and the
 *     etag did not move with it
 *   - a fragment keyed on the record but not the locale, so the English render
 *     was served to the next French reader
 *   - a response that varied by language without a `Vary` to say so
 *
 * None of those is visible from inside the feature that owns it. So the rule
 * this file encodes is: when a change touches caching, negotiation, i18n or
 * the request lifecycle, it has to survive being used the way an application
 * uses them — all at once.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Model, SchemaStatements } from "@altair/orm";
import { Controller, setLocale } from "@altair/controller";
import { createApplication, type Application } from "@altair/core";
import { i18n, t } from "@altair/support";
import { Cached, configureFragmentCache, renderToString } from "@altair/view";
import { Cache, MemoryStore } from "@altair/support";

interface PostRow {
  id: number;
  title: string;
  comments_count: number;
  created_at: Date;
  updated_at: Date;
}

interface CommentRow {
  id: number;
  post_id: number;
  body: string;
  created_at: Date;
  updated_at: Date;
}

class Post extends Model<PostRow>("posts") {}

class Comment extends Model<CommentRow>("comments") {
  declare post: Post;

  static {
    this.belongsTo("post", () => Post, { touch: true, counterCache: true });
  }
}

/** Counted so the tests can prove a fragment was reused rather than rebuilt. */
let renders = 0;

function PostCard({ post }: { post: Post }) {
  renders += 1;

  return (
    <li>
      {String(post.title)} — {t("posts.comments", { count: Number(post.comments_count) })}
    </li>
  );
}

class PostsController extends Controller {
  async index(): Promise<void> {
    const posts = await Post.order("id").toArray();

    const newest = posts.reduce(
      (latest: Date, post) =>
        (post.updated_at as Date) > latest ? (post.updated_at as Date) : latest,
      new Date(0),
    );

    if (this.stale({ etag: posts.map((post) => post.cacheKey()), lastModified: newest })) {
      await this.respondTo({
        html: async () =>
          this.render.html(
            await renderToString(
              <ul>
                {posts.map((post) => (
                  <Cached on={post}>
                    <PostCard post={post} />
                  </Cached>
                ))}
              </ul>,
            ),
          ),
        json: () => this.render.json(posts.map((post) => post.attributes())),
      });
    }
  }
}

let app: Application;
let handler: (request: Request) => Promise<Response>;
let firstPost: Post;

const get = (headers: Record<string, string> = {}, path = "/posts") =>
  handler(new Request(`http://test.host${path}`, { headers }));

beforeAll(async () => {
  i18n.store("en", { posts: { comments: { one: "1 comment", other: "%{count} comments" } } });
  i18n.store("fr", {
    posts: { comments: { one: "1 commentaire", other: "%{count} commentaires" } },
  });

  configureFragmentCache(new Cache(new MemoryStore()));

  app = createApplication({
    env: "test",
    secretKeyBase: "x".repeat(64),
    database: { url: "sqlite://:memory:" },
    log: { level: "fatal", format: "json", queries: false },
    routes: (r) => r.resources("posts"),
    controllers: { posts: PostsController },
    middleware: (stack) => stack.use("locale", setLocale({ available: ["en", "fr"] })),
  });

  await app.boot();

  const schema = new SchemaStatements(app.connection);
  await schema.createTable("posts", (t) => {
    t.string("title");
    t.integer("comments_count", { default: 0 });
    t.datetime("created_at");
    t.datetime("updated_at");
  });
  await schema.createTable("comments", (t) => {
    t.bigint("post_id");
    t.text("body");
    t.datetime("created_at");
    t.datetime("updated_at");
  });

  handler = app.handler();

  firstPost = await Post.create({ title: "Hello" });
  await Post.create({ title: "Second" });
  await Comment.create({ post_id: firstPost.id as number, body: "nice" });
});

afterAll(async () => {
  configureFragmentCache(undefined);
  i18n.reset();
  await app.stop();
});

describe("serving a page", () => {
  it("renders the records", async () => {
    const body = await (await get({ accept: "text/html" })).text();

    expect(body).toContain("<li>");
    expect(body).toContain("Hello");
  });

  it("counts the comments through the counter cache", async () => {
    const body = await (await get({ accept: "text/html" })).text();

    expect(body).toContain("1 comment");
    expect(body).toContain("0 comments");
  });

  it("negotiates JSON from the extension", async () => {
    const response = await get({}, "/posts.json");

    expect(response.headers.get("content-type")).toContain("json");
  });

  it("refuses what it cannot produce", async () => {
    expect((await get({ accept: "application/pdf" })).status).toBe(406);
  });
});

// Both axes at once. Each layer sets its own, and neither may drop the other's
// — a shared cache reading only one of them serves the wrong thing.
describe("telling caches what it varies by", () => {
  it("names the format and the language", async () => {
    const response = await get({ accept: "text/html" });

    expect(response.headers.get("vary")).toBe("Accept, Accept-Language");
  });
});

describe("conditional GET", () => {
  it("answers 304 when the client is current", async () => {
    const first = await get({ accept: "text/html" });
    const etag = first.headers.get("etag");

    expect(etag).toStartWith('W/"');

    const second = await get({ accept: "text/html", "if-none-match": etag as string });
    expect(second.status).toBe(304);
  });
});

describe("fragment caching", () => {
  it("reuses the fragments on a second render", async () => {
    await get({ accept: "text/html" });
    const before = renders;

    await get({ accept: "text/html", "cache-control": "no-cache" });

    expect(renders).toBe(before);
  });

  // The bug this file exists for: a fragment rendered in one language must
  // never be served in another, and nothing about that failure looks like a
  // bug until somebody reports the wrong words.
  it("does not serve an English fragment to a French reader", async () => {
    await get({ accept: "text/html" });

    const french = await (await get({ accept: "text/html", "accept-language": "fr" })).text();

    expect(french).toContain("commentaire");
    expect(french).not.toContain("1 comment<");
  });
});

// Writing a comment has to reach all the way out: the counter, the parent's
// clock, its cache key, the etag built from that key, and the fragment stored
// under it. Any one of those links being broken shows up here and nowhere else.
describe("a write invalidating everything downstream", () => {
  it("busts the etag, the fragment and the count together", async () => {
    const before = await get({ accept: "text/html" });
    const etag = before.headers.get("etag") as string;
    const rendersBefore = renders;

    // A couple of milliseconds, since the cache key's resolution is
    // milliseconds and two writes inside one still collide.
    await new Promise((resolve) => setTimeout(resolve, 2));
    await Comment.create({ post_id: firstPost.id as number, body: "another" });

    const after = await get({ accept: "text/html", "if-none-match": etag });

    expect(after.status).toBe(200);
    expect(await after.text()).toContain("2 comments");
    expect(renders).toBeGreaterThan(rendersBefore);
  });
});
