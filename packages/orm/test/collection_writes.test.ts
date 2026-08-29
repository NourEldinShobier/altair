/**
 * Writing through a relation, ported from
 * `activerecord/test/cases/associations/has_many_associations_test.rb`.
 *
 * An association was a relation you could only read from. `author.books()`
 * would query, count and filter, and creating a book meant setting `author_id`
 * by hand — which is the one thing an association exists to stop you doing.
 *
 * Rails seeds a new record from the relation's own equality conditions, so the
 * same implementation gives `author.books().create()` and
 * `Post.where({ published: 1 }).create()`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Model, SchemaStatements, setConnection } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { isSqlite, testConnection } from "./support/database.js";

interface AuthorRow {
  id: number;
  name: string;
}

interface BookRow {
  id: number;
  author_id: number | null;
  title: string;
  published: number | null;
}

class Author extends Model<AuthorRow>("authors") {
  declare books: () => import("../src/relation.js").Relation<Book>;

  static {
    this.hasMany("books", () => Book);
  }
}

class Book extends Model<BookRow>("books") {
  declare author: () => Promise<Author | null>;

  static {
    this.belongsTo("author", () => Author, { optional: true });
  }
}

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  for (const model of [Author, Book]) {
    model.columnCache = undefined;
    model.columnTypeCache = undefined;
  }

  const schema = new SchemaStatements(connection);

  await schema.createTable("authors", (t) => t.string("name"));
  await schema.createTable("books", (t) => {
    t.integer("author_id");
    t.string("title");
    t.integer("published");
  });
});

afterEach(async () => {
  if (isSqlite) await connection.close();
});

describe("creating through an association", () => {
  it("links the record without being told to", async () => {
    const author = await Author.create({ name: "Ada" });

    const book = await author.books().create({ title: "One" });

    expect(book.author_id).toBe(author.id);
  });

  it("saves it", async () => {
    const author = await Author.create({ name: "Ada" });

    await author.books().create({ title: "One" });

    expect(await author.books().count()).toBe(1);
  });

  it("builds one without saving", async () => {
    const author = await Author.create({ name: "Ada" });

    const book = author.books().build({ title: "One" });

    expect(book.author_id).toBe(author.id);
    expect(book.isNewRecord).toBe(true);
    expect(await author.books().count()).toBe(0);
  });

  it("takes the attributes it was given over the ones it seeded", async () => {
    const ada = await Author.create({ name: "Ada" });
    const grace = await Author.create({ name: "Grace" });

    const book = ada.books().build({ title: "One", author_id: grace.id });

    expect(book.author_id).toBe(grace.id);
  });

  it("keeps two authors' books apart", async () => {
    const ada = await Author.create({ name: "Ada" });
    const grace = await Author.create({ name: "Grace" });

    await ada.books().create({ title: "One" });
    await grace.books().create({ title: "Two" });

    expect(await ada.books().count()).toBe(1);
    expect((await ada.books().first())?.title).toBe("One");
  });
});

/**
 * The same seeding, on a plain relation. Rails does this too, and it is why
 * the association version needs no special case.
 */
describe("creating through a where", () => {
  it("carries the conditions onto the new record", async () => {
    const book = await Book.where({ published: 1 }).create({ title: "One" });

    expect(book.published).toBe(1);
  });

  it("carries several", async () => {
    const author = await Author.create({ name: "Ada" });

    const book = await Book.where({ published: 1, author_id: author.id }).create({ title: "One" });

    expect([book.published, book.author_id]).toEqual([1, author.id]);
  });

  /**
   * A list, a range or raw SQL has no single value to seed from — `where({ id:
   * [1, 2] })` does not mean the new record's id is anything in particular.
   */
  it("seeds nothing from a condition that is not one value", async () => {
    const book = await Book.where({ published: [1, 0] }).create({ title: "One" });

    expect(book.published).toBeNull();
  });

  it("seeds nothing from raw SQL", async () => {
    const book = await Book.where("published = ?", 1).create({ title: "One" });

    expect(book.published).toBeNull();
  });
});

describe("linking records that already exist", () => {
  it("takes one", async () => {
    const author = await Author.create({ name: "Ada" });
    const book = await Book.create({ title: "One" });

    await author.books().push(book);

    expect(book.author_id).toBe(author.id);
    expect(await author.books().count()).toBe(1);
  });

  it("takes several", async () => {
    const author = await Author.create({ name: "Ada" });
    const first = await Book.create({ title: "One" });
    const second = await Book.create({ title: "Two" });

    await author.books().push(first, second);

    expect(await author.books().count()).toBe(2);
  });

  // One at a time rather than a single UPDATE: each record's own callbacks and
  // validations are the reason to reach for this instead of `updateAll`.
  it("runs each record's callbacks", async () => {
    const saved: string[] = [];

    class Volume extends Model<BookRow>("books") {
      static {
        this.setCallback("save", "before", function (this: Volume) {
          saved.push(String(this.title));
        });
      }
    }

    const author = await Author.create({ name: "Ada" });
    const volume = await Volume.create({ title: "One" });
    saved.length = 0;

    await (author.books() as unknown as { push(...records: Volume[]): Promise<unknown> }).push(
      volume,
    );

    expect(saved).toEqual(["One"]);
  });
});

describe("asking how many and whether any", () => {
  it("counts", async () => {
    const author = await Author.create({ name: "Ada" });
    await author.books().create({ title: "One" });

    expect(await author.books().size()).toBe(1);
  });

  it("says when there are none", async () => {
    const author = await Author.create({ name: "Ada" });

    expect(await author.books().isEmpty()).toBe(true);

    await author.books().create({ title: "One" });

    expect(await author.books().isEmpty()).toBe(false);
  });
});

/**
 * Taking records out of a collection, ported from the same Rails file.
 *
 * Two methods because there are two things a caller might mean, and Rails
 * keeps them apart for good reason: removing a book from an author should not
 * usually burn the book.
 */
describe("taking records out", () => {
  it("unlinks without deleting", async () => {
    const author = await Author.create({ name: "Ada" });
    const book = await author.books().create({ title: "One" });

    await author.books().unlink(book);

    expect(await author.books().count()).toBe(0);
    // Still there, belonging to nobody.
    expect(await Book.count()).toBe(1);
    expect((await Book.find(book.id)).author_id).toBeNull();
  });

  it("unlinks several", async () => {
    const author = await Author.create({ name: "Ada" });
    const first = await author.books().create({ title: "One" });
    const second = await author.books().create({ title: "Two" });

    await author.books().unlink(first, second);

    expect(await author.books().count()).toBe(0);
    expect(await Book.count()).toBe(2);
  });

  it("destroys when that is what was meant", async () => {
    const author = await Author.create({ name: "Ada" });
    const book = await author.books().create({ title: "One" });

    await author.books().destroy(book);

    expect(await Book.count()).toBe(0);
    expect(book.isDestroyed).toBe(true);
  });

  // One at a time, because each record's own callbacks are what separate this
  // from deleteAll.
  it("runs each record's destroy callbacks", async () => {
    const gone: string[] = [];

    class Volume extends Model<BookRow>("books") {
      static {
        this.setCallback("destroy", "before", function (this: Volume) {
          gone.push(String(this.title));
        });
      }
    }

    const author = await Author.create({ name: "Ada" });
    const volume = await Volume.create({ title: "One", author_id: author.id });

    await (author.books() as unknown as { destroy(...r: Volume[]): Promise<unknown> }).destroy(
      volume,
    );

    expect(gone).toEqual(["One"]);
  });

  it("leaves the other author's books alone", async () => {
    const ada = await Author.create({ name: "Ada" });
    const grace = await Author.create({ name: "Grace" });

    const hers = await ada.books().create({ title: "One" });
    await grace.books().create({ title: "Two" });

    await ada.books().unlink(hers);

    expect(await grace.books().count()).toBe(1);
  });
});
