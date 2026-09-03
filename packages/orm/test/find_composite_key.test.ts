/**
 * `find` on a model that queries itself by more than one column, ported from
 * the `#find with a single composite primary key` group in
 * `activerecord/test/cases/finder_test.rb` and the `Key#where_hash` /
 * `expects_multiple_ids?` contracts in `activerecord/lib/active_record/key.rb`.
 *
 * `queryConstraints` was already honoured by `update`, `delete` and `reload`,
 * and `find` alone still went to `primaryKey`. So a tenanted model wrote to the
 * right row and read the wrong one: `find([4, 7])` became an `IN` on the tenant
 * column, matching every account's row 4 and row 7 — two records handed back
 * where one was asked for, from accounts the caller never named.
 *
 * That is the failure this file is really about. A cross-tenant read produces
 * plausible records rather than an error, so nothing downstream has any reason
 * to doubt them.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Connection, setConnection } from "../src/connection.js";
import { testConnection } from "./support/database.js";
import { SchemaStatements } from "../src/schema.js";
import { Model } from "../src/model.js";
import { RecordNotFound } from "../src/relation.js";
import { PartialCompositeKey } from "../src/composite_key.js";

interface EntryRow {
  id: number;
  account_id: number;
  title: string;
}

class Entry extends Model<EntryRow>("entries", { queryConstraints: ["account_id", "id"] }) {
  declare id: number;
  declare account_id: number;
  declare title: string;
}

interface PageRow {
  id: number;
  tenant: string;
  slug: string;
  title: string;
}

/** A key of two string columns, which is where a separator has to be chosen. */
class Page extends Model<PageRow>("pages", { queryConstraints: ["tenant", "slug"] }) {
  declare id: number;
  declare tenant: string;
  declare slug: string;
  declare title: string;
}

interface NoteRow {
  id: number;
  title: string;
}

class Note extends Model<NoteRow>("notes") {
  declare id: number;
  declare title: string;
}

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  for (const model of [Entry, Note, Page]) {
    model.resetColumnInformation();
  }

  const schema = new SchemaStatements(connection);

  await schema.createTable("entries", (t) => {
    t.integer("account_id");
    t.string("title");
  });

  await schema.createTable("notes", (t) => {
    t.string("title");
  });

  await schema.createTable("pages", (t) => {
    t.string("tenant");
    t.string("slug");
    t.string("title");
  });

  // Two accounts holding rows with deliberately overlapping ids: account 2's
  // first row shares an id with nothing, but the ids across accounts run
  // 1..4, so a query that forgets the account has plenty to match wrongly.
  await Entry.create({ account_id: 1, title: "one for the first account" });
  await Entry.create({ account_id: 1, title: "two for the first account" });
  await Entry.create({ account_id: 2, title: "three for the second account" });
  await Entry.create({ account_id: 2, title: "four for the second account" });
});

/**
 * One composite id is an array, and so is a list of single ids — the overloads
 * on `find` read every array as the second, because the key's arity is a
 * runtime value and the return type would have to depend on it. The runtime
 * answers with one record; the cast is where that is written down.
 */
async function findOne(id: readonly unknown[]): Promise<Entry> {
  return (await Entry.find(id)) as unknown as Entry;
}

describe("one composite id", () => {
  it("finds the row both columns name", async () => {
    const entry = await findOne([2, 3]);

    expect(entry.title).toBe("three for the second account");
  });

  /**
   * The regression itself. `[1, 3]` reads as one id under a composite key and
   * as two ids under a single one, and the old code always took the second
   * reading — so this asked for account 1's row 3, which does not exist, and
   * used to come back with account 1's row 1 and account 2's row 3.
   */
  it("does not read the pair as a list of two ids", async () => {
    await expect(Entry.find([1, 3])).rejects.toThrow(RecordNotFound);
  });

  it("says which pair it could not find", async () => {
    await expect(Entry.find([1, 3])).rejects.toThrow(/\(1, 3\)/);
  });

  it("takes the id parts as strings, the way a URL supplies them", async () => {
    const entry = await findOne(["2", "4"]);

    expect(entry.title).toBe("four for the second account");
  });
});

describe("a composite id of the wrong shape", () => {
  /**
   * Refused rather than zipped short. One column of two still produces valid
   * SQL — a `WHERE` on the account alone — and would answer with whichever of
   * that account's rows came back first.
   */
  it("refuses a single value where two columns are asked for", async () => {
    await expect(Entry.find(2)).rejects.toThrow(PartialCompositeKey);
  });

  it("refuses a pair with a part missing", async () => {
    await expect(Entry.find([2])).rejects.toThrow(PartialCompositeKey);
  });
});

describe("several composite ids", () => {
  it("finds each pair", async () => {
    const entries = await Entry.find([
      [1, 1],
      [2, 4],
    ]);

    expect(entries.map((entry) => entry.title)).toEqual([
      "one for the first account",
      "four for the second account",
    ]);
  });

  /** An OR of pairs, not a pair of INs: `(1, 3)` is not one of the rows asked for. */
  it("does not match a pair the caller did not ask for", async () => {
    await expect(
      Entry.find([
        [1, 1],
        [2, 3],
        [1, 3],
      ]),
    ).rejects.toThrow(RecordNotFound);
  });

  it("answers in the order the ids were given", async () => {
    const entries = await Entry.find([
      [2, 4],
      [1, 1],
    ]);

    expect(entries.map((entry) => entry.account_id)).toEqual([2, 1]);
  });

  it("wraps a single pair in an array when it was given as one", async () => {
    const entries = await Entry.find([[1, 2]]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.title).toBe("two for the first account");
  });

  it("answers with nothing for an empty list", async () => {
    expect(await Entry.find([])).toEqual([]);
  });

  it("raises when one of the pairs is not there", async () => {
    await expect(
      Entry.find([
        [1, 1],
        [1, 99],
      ]),
    ).rejects.toThrow(/found 1 results, but was looking for 2/);
  });
});

describe("a composite id whose parts hold the separator", () => {
  beforeEach(async () => {
    await Page.create({ tenant: "acme,ltd", slug: "about", title: "the comma tenant" });
    await Page.create({ tenant: "acme", slug: "ltd,about", title: "the comma slug" });
  });

  /**
   * `("acme,ltd", "about")` and `("acme", "ltd,about")` are different rows that
   * a comma-joined key writes to the same string. Both would then land on one
   * entry and every id would come back as whichever row was read last — the
   * right *number* of records, the wrong ones, and nothing raised.
   */
  it("keeps two ids apart that a comma would run together", async () => {
    const pages = await Page.find([
      ["acme,ltd", "about"],
      ["acme", "ltd,about"],
    ]);

    expect(pages.map((page) => page.title)).toEqual(["the comma tenant", "the comma slug"]);
  });
});

describe("a model with an ordinary primary key", () => {
  beforeEach(async () => {
    await Note.create({ title: "first" });
    await Note.create({ title: "second" });
  });

  it("still finds one by its id", async () => {
    expect((await Note.find(1)).title).toBe("first");
  });

  it("still reads an array as a list of ids", async () => {
    const notes = await Note.find([2, 1]);

    expect(notes.map((note) => note.title)).toEqual(["second", "first"]);
  });

  it("still takes an id as a string", async () => {
    expect((await Note.find("2")).title).toBe("second");
  });

  it("still raises for one that is not there", async () => {
    await expect(Note.find(99)).rejects.toThrow(RecordNotFound);
  });

  it("still raises when one of several is not there", async () => {
    await expect(Note.find([1, 99])).rejects.toThrow(RecordNotFound);
  });

  it("still answers with nothing for an empty list", async () => {
    expect(await Note.find([])).toEqual([]);
  });
});
