/**
 * Fragment caching.
 *
 * Mirrors actionview/test/template/digestor_test.rb's intent and the
 * fragment-caching half of render_test.rb. The tests that matter are the
 * nesting ones: reusing one fragment is easy, and reusing the expensive parts
 * of an outer fragment while rebuilding its shell is the whole feature.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { Cache, i18n, MemoryStore } from "@altair/support";
import { renderToString } from "../src/render.js";
import { Cached, configureFragmentCache, fragmentCache } from "../src/cache.js";

interface Post {
  id: number;
  title: string;
  cacheKey(): string;
}

const post = (id: number, title: string, version = 1): Post => ({
  id,
  title,
  cacheKey: () => `posts/${id}-${version}`,
});

let renders = 0;

function Body({ post }: { post: Post }) {
  renders += 1;
  return <p>{post.title}</p>;
}

afterEach(() => {
  configureFragmentCache(undefined);
  renders = 0;
});

const fresh = () => {
  const cache = new Cache(new MemoryStore());
  configureFragmentCache(cache);
  return cache;
};

describe("caching a fragment", () => {
  it("renders the children the first time", async () => {
    fresh();

    const html = await renderToString(
      <Cached on={post(1, "Hello")}>
        <Body post={post(1, "Hello")} />
      </Cached>,
    );

    expect(html).toBe("<p>Hello</p>");
    expect(renders).toBe(1);
  });

  it("reuses the html the second time", async () => {
    fresh();
    const subject = post(1, "Hello");

    const once = await renderToString(
      <Cached on={subject}>
        <Body post={subject} />
      </Cached>,
    );
    const twice = await renderToString(
      <Cached on={subject}>
        <Body post={subject} />
      </Cached>,
    );

    expect(twice).toBe(once);
    expect(renders).toBe(1);
  });

  // The key carries updated_at, so a changed record is a different key and the
  // stale fragment expires by becoming unreachable rather than being swept.
  it("renders again once the record changes", async () => {
    fresh();

    await renderToString(
      <Cached on={post(1, "Hello", 1)}>
        <Body post={post(1, "Hello", 1)} />
      </Cached>,
    );

    const after = await renderToString(
      <Cached on={post(1, "Goodbye", 2)}>
        <Body post={post(1, "Goodbye", 2)} />
      </Cached>,
    );

    expect(after).toBe("<p>Goodbye</p>");
    expect(renders).toBe(2);
  });

  it("keeps different records apart", async () => {
    fresh();

    const one = await renderToString(
      <Cached on={post(1, "One")}>
        <Body post={post(1, "One")} />
      </Cached>,
    );
    const two = await renderToString(
      <Cached on={post(2, "Two")}>
        <Body post={post(2, "Two")} />
      </Cached>,
    );

    expect(one).toBe("<p>One</p>");
    expect(two).toBe("<p>Two</p>");
  });

  // `[post, "sidebar"]` distinguishes two fragments about the same record.
  it("keys on an array as a path", async () => {
    fresh();
    const subject = post(1, "Hello");

    await renderToString(
      <Cached on={[subject, "sidebar"]}>
        <Body post={subject} />
      </Cached>,
    );
    await renderToString(
      <Cached on={[subject, "footer"]}>
        <Body post={subject} />
      </Cached>,
    );

    expect(renders).toBe(2);
  });

  it("escapes on the way in, so nothing is trusted on the way out", async () => {
    fresh();
    const nasty = { id: 1, title: "<script>alert(1)</script>", cacheKey: () => "posts/1-1" };

    const first = await renderToString(
      <Cached on={nasty}>
        <Body post={nasty} />
      </Cached>,
    );
    const second = await renderToString(
      <Cached on={nasty}>
        <Body post={nasty} />
      </Cached>,
    );

    expect(first).not.toContain("<script>");
    expect(second).toBe(first);
  });

  it("takes an expiry", async () => {
    const cache = fresh();
    const subject = post(1, "Hello");

    await renderToString(
      <Cached on={subject} expiresIn={300}>
        <Body post={subject} />
      </Cached>,
    );

    expect(await cache.read(["views", i18n.locale, subject])).not.toBeNull();
  });

  // For the request where an editor should see their own unsaved change.
  it("can be skipped without moving the block", async () => {
    fresh();
    const subject = post(1, "Hello");

    await renderToString(
      <Cached on={subject} skip>
        <Body post={subject} />
      </Cached>,
    );
    await renderToString(
      <Cached on={subject} skip>
        <Body post={subject} />
      </Cached>,
    );

    expect(renders).toBe(2);
  });

  it("uses a store of its own when none is configured", async () => {
    expect(fragmentCache()).toBeInstanceOf(Cache);
  });
});

// Found by running a real application: a fragment rendered in English and
// stored under the record alone was handed to the next French reader, and
// nothing about that looks like a bug until somebody reports the wrong
// language.
describe("locales", () => {
  it("does not serve one language's fragment in another", async () => {
    fresh();
    i18n.store("fr", {});
    const subject = post(1, "Hello");

    const english = await i18n.withLocale("en", async () =>
      renderToString(
        <Cached on={subject}>
          <Body post={subject} />
        </Cached>,
      ),
    );

    await i18n.withLocale("fr", async () =>
      renderToString(
        <Cached on={subject}>
          <Body post={subject} />
        </Cached>,
      ),
    );

    expect(english).toBe("<p>Hello</p>");
    expect(renders).toBe(2);
  });

  it("still reuses within one language", async () => {
    fresh();
    const subject = post(1, "Hello");

    for (let index = 0; index < 2; index += 1) {
      await i18n.withLocale("fr", async () =>
        renderToString(
          <Cached on={subject}>
            <Body post={subject} />
          </Cached>,
        ),
      );
    }

    expect(renders).toBe(1);
  });
});

// Reusing one fragment is easy. Reusing the expensive parts of an outer
// fragment while rebuilding its shell is the whole feature.
describe("nesting", () => {
  const board = (version = 1) => ({ id: 9, cacheKey: () => `boards/9-${version}` });

  const page = (boardVersion: number, posts: Post[]) => (
    <Cached on={board(boardVersion)}>
      <div>
        {posts.map((one) => (
          <Cached on={one}>
            <Body post={one} />
          </Cached>
        ))}
      </div>
    </Cached>
  );

  it("renders everything the first time", async () => {
    fresh();
    await renderToString(page(1, [post(1, "One"), post(2, "Two")]));

    expect(renders).toBe(2);
  });

  it("reuses the whole thing when nothing changed", async () => {
    fresh();
    const posts = [post(1, "One"), post(2, "Two")];

    await renderToString(page(1, posts));
    await renderToString(page(1, posts));

    expect(renders).toBe(2);
  });

  // The one that matters: editing one post rebuilds the outer shell, reuses
  // every sibling, and re-renders only what changed.
  it("re-renders only the fragment that changed", async () => {
    fresh();

    await renderToString(page(1, [post(1, "One"), post(2, "Two")]));
    renders = 0;

    // The edited post has a new key; so does the board, since a `touch: true`
    // child moves its parent's clock.
    await renderToString(page(2, [post(1, "One edited", 2), post(2, "Two")]));

    expect(renders).toBe(1);
  });

  it("produces the same html either way", async () => {
    fresh();
    const posts = [post(1, "One"), post(2, "Two")];

    const cold = await renderToString(page(1, posts));
    const warm = await renderToString(page(1, posts));

    expect(warm).toBe(cold);
    expect(cold).toContain("<p>One</p>");
    expect(cold).toContain("<p>Two</p>");
  });
});
