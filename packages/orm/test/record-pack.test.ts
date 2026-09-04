/**
 * Putting a record in a cache and getting it back without a query, ported from
 * `activerecord/test/cases/message_pack_test.rb`.
 *
 * The cases that matter are the ones where the naive version does not merely
 * produce a bigger payload: a cycle that does not terminate, an unloaded
 * association that issues a query while writing to the cache, and a persisted
 * flag that goes missing and turns the next save into an UPDATE against a row
 * that is not there.
 */

import { describe, expect, it } from "bun:test";
import {
  RECORD_PACK_VERSION,
  type RecordReader,
  type RecordWriter,
  UnknownPackVersion,
  dumpRecords,
  loadRecords,
  readRecord,
  writeRecord,
} from "../src/record-pack.js";

interface Fake {
  klass: string;
  attributes: Record<string, unknown>;
  isNew: boolean;
  loaded: [string, Fake | Fake[] | null][];
}

function record(klass: string, attributes: Record<string, unknown>, isNew = false): Fake {
  return { klass, attributes, isNew, loaded: [] };
}

const reader: RecordReader<Fake> = {
  className: (one) => one.klass,
  attributes: (one) => one.attributes,
  isNew: (one) => one.isNew,
  loadedAssociations: (one) => one.loaded,
};

/** Rebuilds the same shape, so a round trip can be compared. */
function writerFor(missing: readonly string[] = []): RecordWriter<Fake> {
  return {
    build: (klass, attributes, isNew) => ({ klass, attributes, isNew, loaded: [] }),
    setAssociation: (one, name, target) => {
      if (missing.includes(name)) throw new Error(`no association ${name}`);

      one.loaded.push([name, target]);
    },
  };
}

function roundTrip(input: Fake | Fake[] | null, missing?: readonly string[]) {
  return loadRecords(dumpRecords(input, reader), writerFor(missing));
}

describe("one record", () => {
  it("comes back with its class and columns", () => {
    const loaded = roundTrip(record("Post", { id: 7, title: "Hello" })) as Fake;

    expect(loaded.klass).toBe("Post");
    expect(loaded.attributes).toEqual({ id: 7, title: "Hello" });
  });

  /**
   * Without this a cached unsaved record loads as a persisted one and its next
   * save is an UPDATE against a row that does not exist: no error, no row, no
   * record.
   */
  it("remembers whether it was saved", () => {
    expect((roundTrip(record("Post", { id: 7 }, true)) as Fake).isNew).toBe(true);
    expect((roundTrip(record("Post", { id: 7 }, false)) as Fake).isNew).toBe(false);
  });

  it("is nothing for nothing", () => {
    expect(roundTrip(null)).toBeNull();
  });
});

describe("a list", () => {
  it("comes back as a list", () => {
    const loaded = roundTrip([record("Post", { id: 1 }), record("Post", { id: 2 })]) as Fake[];

    expect(loaded.map((one) => one.attributes["id"])).toEqual([1, 2]);
  });

  it("comes back empty for an empty one", () => {
    expect(roundTrip([])).toEqual([]);
  });

  /** Fifty comments on one post must not carry fifty copies of the post. */
  it("stores a shared record once", () => {
    const author = record("Author", { id: 1 });
    const first = record("Post", { id: 1 });
    const second = record("Post", { id: 2 });

    first.loaded = [["author", author]];
    second.loaded = [["author", author]];

    const packed = dumpRecords([first, second], reader);

    expect(packed.entries).toHaveLength(3);
  });

  it("hands the same object back for a shared record", () => {
    const author = record("Author", { id: 1 });
    const first = record("Post", { id: 1 });
    const second = record("Post", { id: 2 });

    first.loaded = [["author", author]];
    second.loaded = [["author", author]];

    const [one, two] = roundTrip([first, second]) as Fake[];

    expect(one?.loaded[0]?.[1]).toBe(two?.loaded[0]?.[1] as Fake);
  });
});

describe("associations", () => {
  it("carries a loaded one", () => {
    const post = record("Post", { id: 1 });
    post.loaded = [["author", record("Author", { id: 9, name: "Ada" })]];

    const loaded = roundTrip(post) as Fake;

    const [, author] = loaded.loaded[0] as [string, Fake];

    expect(author.attributes).toEqual({ id: 9, name: "Ada" });
  });

  it("carries a loaded collection", () => {
    const post = record("Post", { id: 1 });
    post.loaded = [["comments", [record("Comment", { id: 1 }), record("Comment", { id: 2 })]]];

    const loaded = roundTrip(post) as Fake;

    const [, comments] = loaded.loaded[0] as [string, Fake[]];

    expect(comments.map((one) => one.attributes["id"])).toEqual([1, 2]);
  });

  it("carries an association that is loaded and empty", () => {
    const post = record("Post", { id: 1 });
    post.loaded = [
      ["author", null],
      ["comments", []],
    ];

    const loaded = roundTrip(post) as Fake;

    expect(loaded.loaded[0]?.[1]).toBeNull();
    expect(loaded.loaded[1]?.[1]).toEqual([]);
  });

  /**
   * Walking an unloaded association would issue the query at dump time, so
   * writing to the cache would run exactly the queries the cache exists to
   * avoid.
   */
  it("carries nothing for one that was never loaded", () => {
    const post = record("Post", { id: 1 });

    expect(dumpRecords(post, reader).entries[0]).toHaveLength(3);
  });

  /**
   * A post holds its author and the author holds their posts. Encoding that
   * naively does not produce a big payload; it does not terminate.
   */
  it("closes a cycle instead of recursing", () => {
    const post = record("Post", { id: 1 });
    const author = record("Author", { id: 9 });

    post.loaded = [["author", author]];
    author.loaded = [["posts", [post]]];

    const packed = dumpRecords(post, reader);

    expect(packed.entries).toHaveLength(2);

    const loaded = roundTrip(post) as Fake;
    const [, sameAuthor] = loaded.loaded[0] as [string, Fake];
    const [, backToPosts] = sameAuthor.loaded[0] as [string, Fake[]];

    expect(backToPosts[0]).toBe(loaded);
  });

  it("closes a cycle a record makes with itself", () => {
    const post = record("Post", { id: 1 });
    post.loaded = [["canonical", post]];

    expect(dumpRecords(post, reader).entries).toHaveLength(1);
  });

  /**
   * A cache outlives the code that filled it, and a deploy that removed one
   * association should not make every record written before it unloadable.
   */
  it("skips one the class no longer has", () => {
    const post = record("Post", { id: 1 });
    post.loaded = [
      ["author", record("Author", { id: 9 })],
      ["tags", [record("Tag", { id: 3 })]],
    ];

    const loaded = roundTrip(post, ["tags"]) as Fake;

    expect(loaded.loaded.map(([name]) => name)).toEqual(["author"]);
  });
});

describe("the payload itself", () => {
  it("is stamped with a version", () => {
    expect(dumpRecords(record("Post", { id: 1 }), reader).version).toBe(RECORD_PACK_VERSION);
  });

  /** An old payload is refused rather than read as though the fields still meant the same. */
  it("refuses a version it does not know", () => {
    const packed = dumpRecords(record("Post", { id: 1 }), reader);

    expect(() => loadRecords({ ...packed, version: 99 }, writerFor())).toThrow(UnknownPackVersion);
    expect(() => loadRecords({ ...packed, version: 99 }, writerFor())).toThrow("version 99");
  });
});

describe("one entry on its own", () => {
  it("is the class, the columns and the saved flag", () => {
    expect(writeRecord(record("Post", { id: 1 }, true), reader)).toEqual(["Post", { id: 1 }, true]);
  });

  it("builds a record back from one", () => {
    const built = readRecord<Fake>(["Post", { id: 1 }, false], writerFor());

    expect(built.klass).toBe("Post");
    expect(built.attributes).toEqual({ id: 1 });
    expect(built.isNew).toBe(false);
  });
});
