/**
 * Enums.
 *
 * Mirrors activerecord/test/cases/enum_test.rb. The tests that matter are the
 * ones about the boundary: what the column holds, what the application sees,
 * and that a query written in words finds the rows rather than silently
 * matching nothing.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import {
  Connection,
  Model,
  type Relation,
  SchemaStatements,
  setConnection,
  UnknownEnumValue,
} from "../src/index.js";

// The attributes interface describes what the application works with, which
// for an enum is the word. Turning it into the integer the column holds is
// the whole point of the feature, and happens below this line.
interface PostRow {
  id: number;
  title: string;
  status: string;
  visibility: string | null;
}

class Post extends Model<PostRow>("posts") {
  // What `enum` defines, declared so the compiler knows about it — the same
  // bargain as an association: one line each, and everything downstream is
  // checked.
  declare isDraft: boolean;
  declare isPublished: boolean;
  declare isArchived: boolean;
  declare draft: () => Promise<boolean>;
  declare published: () => Promise<boolean>;

  declare static draft: () => Relation<Post>;
  declare static published: () => Relation<Post>;

  static {
    this.enum("status", { draft: 0, published: 1, archived: 2 });
    this.enum("visibility", { hidden: 0, listed: 1 }, { prefix: "visibility" });
  }
}

let connection: Connection;

beforeEach(async () => {
  connection = new Connection(process.env.DATABASE_URL ?? "sqlite://:memory:");
  setConnection(connection);
  Post.columnCache = undefined;
  Post.columnTypeCache = undefined;

  const schema = new SchemaStatements(connection);
  await schema.dropTable("posts", { ifExists: true });
  await schema.createTable("posts", (t) => {
    t.string("title");
    t.integer("status", { default: 0 });
    t.integer("visibility");
  });
});

describe("what the column holds and what the application sees", () => {
  it("reads back as the word", async () => {
    const post = await Post.create({ title: "A", status: "published" });

    expect(post.status).toBe("published");
  });

  // The reason for the whole feature: the index stays small, and nothing that
  // reads the record has to keep its own copy of what 1 meant.
  it("stores the integer", async () => {
    await Post.create({ title: "A", status: "published" });

    const [row] = await connection.query<{ status: number }>("SELECT status FROM posts");
    expect(row?.status).toBe(1);
  });

  it("still reads as the word after a reload", async () => {
    const post = await Post.create({ title: "A", status: "archived" });
    await post.reload();

    expect(post.status).toBe("archived");
  });

  it("takes the stored value as well as the word", async () => {
    const post = await Post.create({ title: "A", status: 2 as unknown as string });

    expect(post.status).toBe("archived");
  });

  it("leaves a nullable column null", async () => {
    const post = await Post.create({ title: "A" });

    expect(post.visibility).toBeNull();
  });

  it("refuses a value that is not one of them", () => {
    expect(() => {
      Post.build({ title: "A", status: "nonsense" });
    }).toThrow(UnknownEnumValue);
  });

  it("says what the choices are", () => {
    expect(() => Post.build({ title: "A", status: "nonsense" })).toThrow(
      /draft, published, archived/,
    );
  });

  it("refuses a mapping with two words for one value", () => {
    expect(() => {
      class Broken extends Model<PostRow>("posts") {
        static {
          this.enum("status", { draft: 0, unpublished: 0 });
        }
      }
      void Broken;
    }).toThrow(/both/);
  });
});

describe("predicates", () => {
  it("answers for the one it is", async () => {
    const post = await Post.create({ title: "A", status: "published" });

    expect(post.isPublished).toBe(true);
    expect(post.isDraft).toBe(false);
    expect(post.isArchived).toBe(false);
  });

  it("follows an assignment", async () => {
    const post = await Post.create({ title: "A", status: "draft" });
    post.status = "archived";

    expect(post.isArchived).toBe(true);
  });

  it("takes the prefix it was given", async () => {
    const post = await Post.create({ title: "A", visibility: "listed" });

    expect((post as unknown as { isVisibilityListed: boolean }).isVisibilityListed).toBe(true);
    expect((post as unknown as { isVisibilityHidden: boolean }).isVisibilityHidden).toBe(false);
  });
});

describe("mutators", () => {
  // Rails' `post.published!`: sets it and saves.
  it("set the value and write it", async () => {
    const post = await Post.create({ title: "A", status: "draft" });

    await post.published();

    expect(post.status).toBe("published");
    expect((await Post.find(post.id)).status).toBe("published");
  });

  it("leave the rest of the record alone", async () => {
    const post = await Post.create({ title: "A", status: "draft" });
    await post.published();

    expect(post.title).toBe("A");
  });
});

describe("scopes", () => {
  beforeEach(async () => {
    await Post.create({ title: "A", status: "draft" });
    await Post.create({ title: "B", status: "published" });
    await Post.create({ title: "C", status: "published" });
  });

  it("find the rows for one word", async () => {
    expect(await Post.published().count()).toBe(2);
    expect(await Post.draft().count()).toBe(1);
  });

  it("chain like any other relation", async () => {
    const posts = await Post.published().order("title", "desc").toArray();

    expect(posts.map((post) => post.title)).toEqual(["C", "B"]);
  });
});

// A query written in words that silently matched nothing would be a worse
// outcome than not supporting words at all.
describe("querying with the word", () => {
  beforeEach(async () => {
    await Post.create({ title: "A", status: "draft" });
    await Post.create({ title: "B", status: "published" });
  });

  it("matches on the word", async () => {
    expect(await Post.where({ status: "published" }).count()).toBe(1);
  });

  it("matches on the stored value too", async () => {
    expect(await Post.where({ status: 1 }).count()).toBe(1);
  });

  it("maps every member of an IN", async () => {
    expect(await Post.where({ status: ["draft", "published"] }).count()).toBe(2);
  });

  it("leaves other columns alone", async () => {
    expect(await Post.where({ title: "A" }).count()).toBe(1);
  });

  it("refuses a word that is not one of them", async () => {
    expect(() => Post.where({ status: "nonsense" })).toThrow(UnknownEnumValue);
  });
});

// A JSON response that said 1 would make every caller keep its own copy of
// the mapping.
describe("serializing", () => {
  it("gives the word, not the integer", async () => {
    const post = await Post.create({ title: "A", status: "published" });

    expect(post.attributes().status).toBe("published");
    expect(JSON.parse(JSON.stringify(post)).status).toBe("published");
  });

  it("still writes the integer", async () => {
    const post = await Post.create({ title: "A", status: "archived" });
    await post.update({ title: "B" });

    const [row] = await connection.query<{ status: number }>("SELECT status FROM posts");
    expect(row?.status).toBe(2);
  });
});
