/**
 * How many queries a preload costs, ported from
 * `activerecord/test/cases/associations/eager_test.rb` and the batching cases
 * in `preloader_test.rb`.
 *
 * Nothing here fails loudly. A preload that sends two queries where one would
 * do is slower; one that hands a loader another loader's rows is wrong in a
 * way that reads as correct.
 */

import { describe, expect, it } from "bun:test";
import {
  type Loader,
  type LoaderGroup,
  groupLoaders,
  loadRecordsForKeys,
  loadRecordsInBatch,
  loaderQueryKey,
  preloadAssociations,
} from "../src/preload-batching.js";

const loader = (klass: string, keyName: string | string[], keys: unknown[]): Loader => ({
  klass,
  keyName,
  keys,
});

describe("what makes two loaders share a query", () => {
  it("is the class and the key together", () => {
    expect(loaderQueryKey(loader("User", "id", []))).toBe(loaderQueryKey(loader("User", "id", [])));
  });

  /**
   * Sharing on the class alone would union the keys of a loader matching `id`
   * with one matching `author_id` and hand both the wrong rows — a preload that
   * silently attaches somebody else's records.
   */
  it("is not the class alone", () => {
    expect(loaderQueryKey(loader("User", "id", []))).not.toBe(
      loaderQueryKey(loader("User", "author_id", [])),
    );
  });

  it("is not the key alone", () => {
    expect(loaderQueryKey(loader("User", "id", []))).not.toBe(
      loaderQueryKey(loader("Photo", "id", [])),
    );
  });

  it("reads a composite key as one key", () => {
    expect(loaderQueryKey(loader("Order", ["shop_id", "id"], []))).toBe(
      loaderQueryKey(loader("Order", ["shop_id", "id"], [])),
    );
    expect(loaderQueryKey(loader("Order", ["shop_id", "id"], []))).not.toBe(
      loaderQueryKey(loader("Order", ["id", "shop_id"], [])),
    );
  });
});

describe("the conditions one query needs", () => {
  it("matches the column against the keys", () => {
    expect(loadRecordsForKeys("id", [1, 2])).toEqual({ id: [1, 2] });
  });

  /**
   * `WHERE id IN ()` is a syntax error on most servers and matches everything
   * on one — and either way it is a round trip for an answer already known.
   */
  it("is nothing at all for no keys", () => {
    expect(loadRecordsForKeys("id", [])).toBeUndefined();
    expect(loadRecordsForKeys(["shop_id", "id"], [])).toBeUndefined();
  });

  /**
   * One set per column rather than a list of tuples, because that is what every
   * adapter can express — and it is wider than the tuple form, which is why the
   * caller still has to match each row back to its owner.
   */
  it("splits a composite key into a set per column", () => {
    expect(
      loadRecordsForKeys(
        ["shop_id", "id"],
        [
          [1, 10],
          [1, 11],
          [2, 10],
        ],
      ),
    ).toEqual({ shop_id: [1, 2], id: [10, 11] });
  });

  it("does not repeat a value in a column's set", () => {
    expect(
      loadRecordsForKeys(
        ["shop_id", "id"],
        [
          [1, 10],
          [1, 10],
        ],
      ),
    ).toEqual({ shop_id: [1], id: [10] });
  });
});

describe("grouping loaders", () => {
  /**
   * `includes("author", "editor")` loads twice from `users` on the same key.
   * Two queries for one table is the cost `includes` was written to avoid.
   */
  it("puts loaders on one class and key together", () => {
    const author = loader("User", "id", [1, 2]);
    const editor = loader("User", "id", [2, 3]);
    const groups = groupLoaders([author, editor]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.loaders).toEqual([author, editor]);
  });

  it("unions their keys, without repeating one", () => {
    const groups = groupLoaders([loader("User", "id", [1, 2]), loader("User", "id", [2, 3])]);

    expect(groups[0]?.keys).toEqual([1, 2, 3]);
  });

  it("keeps loaders on different classes apart", () => {
    const groups = groupLoaders([loader("User", "id", [1]), loader("Photo", "id", [1])]);

    expect(groups.map((group) => group.klass)).toEqual(["User", "Photo"]);
  });

  it("keeps loaders on different keys apart", () => {
    const groups = groupLoaders([loader("User", "id", [1]), loader("User", "author_id", [1])]);

    expect(groups).toHaveLength(2);
  });

  /** So the queries a preload sends read in the order they were written. */
  it("keeps the order the loaders came in", () => {
    const groups = groupLoaders([
      loader("Photo", "id", [1]),
      loader("User", "id", [1]),
      loader("Photo", "id", [2]),
    ]);

    expect(groups.map((group) => group.klass)).toEqual(["Photo", "User"]);
    expect(groups[0]?.keys).toEqual([1, 2]);
  });

  it("has nothing to group when there is nothing to load", () => {
    expect(groupLoaders([])).toEqual([]);
  });
});

describe("running the queries", () => {
  interface Row {
    id: number;
  }

  const rowsFor = (keys: unknown[]): Row[] => keys.map((key) => ({ id: Number(key) }));

  it("sends one query per group", async () => {
    const sent: LoaderGroup[] = [];
    const author = loader("User", "id", [1]);
    const editor = loader("User", "id", [2]);

    await loadRecordsInBatch<Row>(
      [author, editor],
      (group) => {
        sent.push(group);

        return rowsFor(group.keys);
      },
      (row) => row.id,
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]?.keys).toEqual([1, 2]);
  });

  /**
   * Handing the union to every loader would attach another association's
   * records to this one — which reads as a correctly preloaded association
   * containing rows nobody asked for.
   */
  it("gives each loader only its own rows", async () => {
    const author = loader("User", "id", [1]);
    const editor = loader("User", "id", [2]);

    const results = await loadRecordsInBatch<Row>(
      [author, editor],
      (group) => rowsFor(group.keys),
      (row) => row.id,
    );

    expect(results.get(author)).toEqual([{ id: 1 }]);
    expect(results.get(editor)).toEqual([{ id: 2 }]);
  });

  /** A string key from one driver and a number from another still match. */
  it("matches a key however the driver typed it", async () => {
    const author = loader("User", "id", ["1"]);

    const results = await loadRecordsInBatch<Row>(
      [author],
      () => [{ id: 1 }],
      (row) => row.id,
    );

    expect(results.get(author)).toEqual([{ id: 1 }]);
  });

  it("sends no query for a loader with no keys", async () => {
    let queries = 0;
    const empty = loader("User", "id", []);

    const results = await loadRecordsInBatch<Row>(
      [empty],
      () => {
        queries += 1;

        return [];
      },
      (row) => row.id,
    );

    expect(queries).toBe(0);
    expect(results.get(empty)).toEqual([]);
  });

  it("gives a loader nothing when the query found nothing", async () => {
    const author = loader("User", "id", [1]);

    const results = await loadRecordsInBatch<Row>(
      [author],
      () => [],
      (row) => row.id,
    );

    expect(results.get(author)).toEqual([]);
  });
});

describe("which associations a relation preloads", () => {
  it("is what preload named", () => {
    expect(preloadAssociations({ preload: ["author"] })).toEqual(["author"]);
  });

  it("is what includes named too", () => {
    expect(preloadAssociations({ preload: ["author"], includes: ["comments"] })).toEqual([
      "author",
      "comments",
    ]);
  });

  /**
   * An `includes` the planner turned into a join has already loaded the
   * association; preloading it as well fetches the same rows again and
   * replaces the first copy — invisible except in the query log.
   */
  it("leaves includes out when the relation is eager loading", () => {
    expect(
      preloadAssociations({ preload: ["author"], includes: ["comments"], eagerLoading: true }),
    ).toEqual(["author"]);
  });

  /** One association named twice is one association. */
  it("does not name one twice", () => {
    expect(preloadAssociations({ preload: ["author"], includes: ["author"] })).toEqual(["author"]);
  });

  it("is nothing when nothing was named", () => {
    expect(preloadAssociations()).toEqual([]);
  });
});
