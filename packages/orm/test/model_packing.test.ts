/**
 * Packing an actual record, ported from
 * `activerecord/test/cases/message_pack_test.rb`.
 *
 * `record_pack.test.ts` covers the payload's shape against a fake. These are
 * about the half that touches `Model`: what a real record's columns look like
 * on the way out, what comes back, and the two things a cache must not do —
 * carry plaintext, and build whatever class a payload names.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Connection, setConnection } from "../src/connection.js";
import { testConnection } from "./support/database.js";
import { SchemaStatements } from "../src/schema.js";
import { Model } from "../src/model.js";
import { configureEncryption, resetEncryption } from "../src/encryption.js";
import { dumpRecords, loadRecords } from "../src/record_pack.js";
import {
  UnknownPackedClass,
  modelRecordReader,
  modelRecordWriter,
  type PackableModel,
  type PackableRecord,
} from "../src/model_packing.js";

interface AuthorRow {
  id: number;
  name: string;
  secret: string | null;
}

interface PostRow {
  id: number;
  title: string;
  author_id: number | null;
}

class Author extends Model<AuthorRow>("authors") {
  declare id: number;
  declare name: string;
  declare secret: string | null;
  declare posts: () => Promise<Post[]>;

  static {
    this.encrypts("secret");
  }
}

class Post extends Model<PostRow>("posts") {
  declare id: number;
  declare title: string;
  declare author_id: number | null;
  declare author: () => Promise<Author | null>;
}

Author.hasMany("posts", () => Post, { foreignKey: "author_id" });
Post.belongsTo("author", () => Author, { foreignKey: "author_id", optional: true });

let connection: Connection;

const reader = modelRecordReader();
const writer = () => modelRecordWriter([Author, Post] as unknown as PackableModel[]);

function roundTrip(input: unknown) {
  return loadRecords(dumpRecords(input as unknown as PackableRecord, reader), writer());
}

beforeEach(async () => {
  configureEncryption("a".repeat(64));

  connection = await testConnection();
  setConnection(connection);

  for (const klass of [Author, Post]) {
    klass.resetColumnInformation();
  }

  const schema = new SchemaStatements(connection);

  await schema.createTable("authors", (t) => {
    t.string("name");
    t.string("secret", { limit: 500 });
  });
  await schema.createTable("posts", (t) => {
    t.string("title");
    t.integer("author_id");
  });
});

afterEach(() => {
  resetEncryption();
});

describe("one record", () => {
  it("comes back as the same class with the same columns", async () => {
    const author = await Author.create({ name: "Ada" });

    const loaded = roundTrip(author) as unknown as Author;

    expect(loaded).toBeInstanceOf(Author);
    expect(loaded.name).toBe("Ada");
    expect(loaded.id).toBe(author.id);
  });

  it("comes back persisted when it was", async () => {
    const author = await Author.create({ name: "Ada" });

    expect((roundTrip(author) as unknown as Author).isNewRecord).toBe(false);
  });

  /** Or its next save is an UPDATE against a row that does not exist. */
  it("comes back new when it was", () => {
    const author = Author.build({ name: "Ada" });

    expect((roundTrip(author) as unknown as Author).isNewRecord).toBe(true);
  });

  it("comes back with its types, not with strings", async () => {
    const author = await Author.create({ name: "Ada" });
    const post = await Post.create({ title: "Hello", author_id: author.id });

    expect(typeof (roundTrip(post) as unknown as Post).author_id).toBe("number");
  });
});

describe("an encrypted column", () => {
  /**
   * A cache is another datastore. Packing the plaintext would put it in Redis,
   * or on a disk — which is where the column is encrypted so it will not be.
   */
  it("is ciphertext in the payload", async () => {
    const author = await Author.create({ name: "Ada", secret: "the passphrase" });

    const packed = JSON.stringify(dumpRecords(author as unknown as PackableRecord, reader));

    expect(packed).not.toContain("the passphrase");
  });

  it("reads back as the plain value", async () => {
    const author = await Author.create({ name: "Ada", secret: "the passphrase" });

    expect((roundTrip(author) as unknown as Author).secret).toBe("the passphrase");
  });
});

describe("the class a payload names", () => {
  /** A payload is data, and building whatever it names constructs arbitrary objects. */
  it("has to be one the loader was given", () => {
    const packed = dumpRecords(Author.build({ name: "Ada" }) as unknown as PackableRecord, reader);

    expect(() => loadRecords(packed, modelRecordWriter([]))).toThrow(UnknownPackedClass);
  });

  it("says which classes were on offer", () => {
    const packed = dumpRecords(Author.build({ name: "Ada" }) as unknown as PackableRecord, reader);

    expect(() =>
      loadRecords(packed, modelRecordWriter([Post] as unknown as PackableModel[])),
    ).toThrow("Post");
  });

  it("is built when it was offered", () => {
    const packed = dumpRecords(Author.build({ name: "Ada" }) as unknown as PackableRecord, reader);

    expect(loadRecords(packed, writer())).toBeInstanceOf(Author);
  });
});

describe("associations", () => {
  it("carries one that was loaded", async () => {
    const author = await Author.create({ name: "Ada" });
    const post = await Post.create({ title: "Hello", author_id: author.id });

    await post.loadTarget("author");

    const loaded = roundTrip(post) as unknown as Post;

    expect(loaded.isAssociationLoaded("author")).toBe(true);
    expect(((await loaded.author()) as unknown as Author).name).toBe("Ada");
  });

  /**
   * Walking one that was never loaded would issue the query at pack time —
   * running exactly the queries the cache exists to avoid.
   */
  it("carries nothing for one that was not", async () => {
    const author = await Author.create({ name: "Ada" });
    const post = await Post.create({ title: "Hello", author_id: author.id });

    const packed = dumpRecords(post as unknown as PackableRecord, reader);

    expect(packed.entries).toHaveLength(1);
  });

  it("does not pretend an unloaded association is loaded", async () => {
    const author = await Author.create({ name: "Ada" });
    const post = await Post.create({ title: "Hello", author_id: author.id });

    const loaded = roundTrip(post) as unknown as Post;

    expect(loaded.isAssociationLoaded("author")).toBe(false);
  });

  it("carries a loaded collection", async () => {
    const author = await Author.create({ name: "Ada" });
    await Post.create({ title: "One", author_id: author.id });
    await Post.create({ title: "Two", author_id: author.id });

    await author.loadTarget("posts");

    // Three entries, not one: the collection is in the payload rather than
    // being fetched again by the record that comes out of it.
    expect(dumpRecords(author as unknown as PackableRecord, reader).entries).toHaveLength(3);

    const loaded = roundTrip(author) as unknown as Author;

    expect(loaded.isAssociationLoaded("posts")).toBe(true);

    const posts = (await loaded.posts()) as unknown as Post[];

    expect(posts.map((one) => one.title).sort()).toEqual(["One", "Two"]);
  });

  /**
   * A `belongsTo` that was loaded and found nothing. Dropping it would send
   * the loaded record looking again, and finding nothing again, on every read.
   */
  it("carries an association that was loaded and empty", async () => {
    const post = await Post.create({ title: "Orphan", author_id: null });

    await post.loadTarget("author");

    const loaded = roundTrip(post) as unknown as Post;

    expect(loaded.isAssociationLoaded("author")).toBe(true);
    expect(await loaded.author()).toBeNull();
  });

  /**
   * A cached value that is neither a record nor a list of them is skipped
   * rather than guessed at, and the loaded record simply fetches the
   * association the first time it is asked.
   */
  it("skips a cached value it cannot pack", async () => {
    const author = await Author.create({ name: "Ada" });
    const post = await Post.create({ title: "Hello", author_id: author.id });

    await post.loadTarget("author");
    // Something that is not a record, in the place one would be.
    (post as unknown as Record<string, unknown>)["__preloaded_author"] = { not: "a record" };

    const packed = dumpRecords(post as unknown as PackableRecord, reader);

    expect(packed.entries).toHaveLength(1);
  });

  it("skips a list holding something it cannot pack", async () => {
    const author = await Author.create({ name: "Ada" });
    await Post.create({ title: "One", author_id: author.id });

    await author.loadTarget("posts");

    const held = (author as unknown as Record<string, unknown>)["__preloaded_posts"] as unknown[];
    (author as unknown as Record<string, unknown>)["__preloaded_posts"] = [
      ...held,
      { not: "a record" },
    ];

    expect(dumpRecords(author as unknown as PackableRecord, reader).entries).toHaveLength(1);
  });

  /** The cache holds the post once, not once per side of the cycle. */
  it("closes a cycle between two records", async () => {
    const author = await Author.create({ name: "Ada" });
    const post = await Post.create({ title: "Hello", author_id: author.id });

    await post.loadTarget("author");

    const packed = dumpRecords(post as unknown as PackableRecord, reader);

    expect(packed.entries).toHaveLength(2);
  });
});
