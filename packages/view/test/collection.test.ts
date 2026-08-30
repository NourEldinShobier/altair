/**
 * Collection rendering, ported from
 * `actionview/test/template/render_test.rb` and the PartialIteration cases in
 * `actionview/test/template/partial_iteration_test.rb`.
 */

import { describe, expect, it } from "bun:test";
import { RawHtml, type Node } from "../src/render.js";
import {
  PartialIteration,
  collectionCounter,
  renderCachedCollection,
  renderCollection,
  renderPartial,
  type CollectionItemProps,
} from "../src/collection.js";

function html(node: Node): string {
  return (node as RawHtml).value;
}

const Row = ({ item }: CollectionItemProps<string>): Node => new RawHtml(`<li>${item}</li>`);

describe("PartialIteration", () => {
  it("counts from zero and knows the size", () => {
    const iteration = new PartialIteration(1, 3);

    expect(iteration.index).toBe(1);
    expect(iteration.size).toBe(3);
  });

  /** `index === size` is the line everybody writes once. */
  it("knows first and last without the caller deriving them", () => {
    expect(new PartialIteration(0, 3).first).toBe(true);
    expect(new PartialIteration(0, 3).last).toBe(false);
    expect(new PartialIteration(2, 3).last).toBe(true);
  });

  it("is both first and last in a collection of one", () => {
    const only = new PartialIteration(0, 1);

    expect(only.first).toBe(true);
    expect(only.last).toBe(true);
  });

  it("gives a one-based number for anything a person reads", () => {
    expect(new PartialIteration(0, 3).number).toBe(1);
    expect(new PartialIteration(2, 3).number).toBe(3);
  });

  it("alternates for striping", () => {
    expect(new PartialIteration(0, 3).odd).toBe(true);
    expect(new PartialIteration(1, 3).even).toBe(true);
    expect(new PartialIteration(2, 3).odd).toBe(true);
  });
});

describe("renderCollection", () => {
  it("renders one per item", () => {
    expect(html(renderCollection(["a", "b"], Row))).toBe("<li>a</li><li>b</li>");
  });

  it("gives the component where it is in the list", () => {
    const positions: string[] = [];
    const Recording = ({ iteration }: CollectionItemProps<string>): Node => {
      positions.push(`${String(iteration.index)}/${String(iteration.size)}`);
      return new RawHtml("");
    };

    renderCollection(["a", "b", "c"], Recording);

    expect(positions).toEqual(["0/3", "1/3", "2/3"]);
  });

  /** The off-by-one this helper exists to remove. */
  it("puts the spacer between items and not after the last", () => {
    const markup = html(renderCollection(["a", "b", "c"], Row, { spacer: new RawHtml("<hr>") }));

    expect(markup).toBe("<li>a</li><hr><li>b</li><hr><li>c</li>");
    expect(markup.endsWith("<hr>")).toBe(false);
  });

  it("renders no spacer for a single item", () => {
    expect(html(renderCollection(["a"], Row, { spacer: new RawHtml("<hr>") }))).toBe("<li>a</li>");
  });

  /** A blank area with no explanation reads as a bug in the page. */
  it("renders the empty case for an empty collection", () => {
    const markup = html(renderCollection([], Row, { empty: new RawHtml("<p>No posts yet</p>") }));

    expect(markup).toBe("<p>No posts yet</p>");
  });

  it("renders nothing when empty and given no empty case", () => {
    expect(html(renderCollection([], Row))).toBe("");
  });

  it("escapes a plain string returned by a component", () => {
    const Unsafe = ({ item }: CollectionItemProps<string>): Node => item;

    expect(html(renderCollection(["<script>"], Unsafe))).toBe("&lt;script&gt;");
  });
});

describe("renderPartial", () => {
  it("renders one item", () => {
    expect(html(renderPartial("a", Row))).toBe("<li>a</li>");
  });

  /** A component written for a collection must not break when rendered alone. */
  it("gives it the same iteration shape", () => {
    let seen: PartialIteration | undefined;
    const Recording = ({ iteration }: CollectionItemProps<string>): Node => {
      seen = iteration;
      return new RawHtml("");
    };

    renderPartial("a", Recording);

    expect(seen?.first).toBe(true);
    expect(seen?.last).toBe(true);
    expect(seen?.size).toBe(1);
  });
});

describe("renderCachedCollection", () => {
  function fakeCache(hits: Record<string, string> = {}) {
    const store = new Map(Object.entries(hits));
    const reads: string[][] = [];

    return {
      reads,
      store,
      cache: {
        read: async (keys: string[]) => {
          reads.push(keys);

          return new Map([...store].filter(([key]) => keys.includes(key)));
        },
        write: async (entries: Map<string, string>) => {
          for (const [key, value] of entries) store.set(key, value);
        },
      },
    };
  }

  /** Fifty rows with a cache each is fifty reads; together it is one. */
  it("reads every key in one call", async () => {
    const { cache, reads } = fakeCache();

    await renderCachedCollection(["a", "b", "c"], Row, cache, (item) => `row/${item}`);

    expect(reads).toHaveLength(1);
    expect(reads[0]).toEqual(["row/a", "row/b", "row/c"]);
  });

  it("uses what the cache had", async () => {
    const { cache } = fakeCache({ "row/a": "<li>cached</li>" });

    const markup = html(
      await renderCachedCollection(["a", "b"], Row, cache, (item) => `row/${item}`),
    );

    expect(markup).toBe("<li>cached</li><li>b</li>");
  });

  it("renders only what missed", async () => {
    const { cache } = fakeCache({ "row/a": "<li>cached</li>" });
    let rendered = 0;
    const Counting = ({ item }: CollectionItemProps<string>): Node => {
      rendered += 1;
      return new RawHtml(`<li>${item}</li>`);
    };

    await renderCachedCollection(["a", "b"], Counting, cache, (item) => `row/${item}`);

    expect(rendered).toBe(1);
  });

  it("writes back what it rendered", async () => {
    const { cache, store } = fakeCache();

    await renderCachedCollection(["a"], Row, cache, (item) => `row/${item}`);

    expect(store.get("row/a")).toBe("<li>a</li>");
  });

  it("writes nothing when everything hit", async () => {
    const { cache, store } = fakeCache({ "row/a": "<li>cached</li>" });
    const before = new Map(store);

    await renderCachedCollection(["a"], Row, cache, (item) => `row/${item}`);

    expect([...store]).toEqual([...before]);
  });

  it("renders the empty case without touching the cache", async () => {
    const { cache, reads } = fakeCache();

    const markup = html(
      await renderCachedCollection([], Row, cache, () => "unused", {
        empty: new RawHtml("<p>None</p>"),
      }),
    );

    expect(markup).toBe("<p>None</p>");
    expect(reads).toHaveLength(0);
  });

  it("puts the spacer between cached and fresh alike", async () => {
    const { cache } = fakeCache({ "row/a": "<li>cached</li>" });

    const markup = html(
      await renderCachedCollection(["a", "b"], Row, cache, (item) => `row/${item}`, {
        spacer: new RawHtml("<hr>"),
      }),
    );

    expect(markup).toBe("<li>cached</li><hr><li>b</li>");
  });
});

describe("collectionCounter", () => {
  it("counts what would be rendered", () => {
    expect(collectionCounter(["a", "b"])).toBe(2);
    expect(collectionCounter([])).toBe(0);
  });
});
