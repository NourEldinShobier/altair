/**
 * Model suite.
 *
 * Mirrors activerecord/test/cases/persistence_test.rb, finder_test.rb,
 * dirty_test.rb and relations_test.rb. Runs against in-memory SQLite.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Connection, setConnection } from "../src/connection.js";
import { SchemaStatements } from "../src/schema.js";
import {
  Model,
  RecordInvalid,
  RecordNotFound,
  afterSave,
  beforeSave,
  modelName,
} from "../src/model.js";

interface PostAttributes {
  id: number;
  title: string;
  body: string | null;
  published: number;
  views: number;
  created_at: string;
  updated_at: string;
}

class Post extends Model<PostAttributes>("posts") {}

let connection: Connection;

beforeEach(async () => {
  connection = new Connection("sqlite://:memory:");
  setConnection(connection);

  const schema = new SchemaStatements(connection);
  await schema.createTable("posts", (t) => {
    t.string("title", { null: false });
    t.text("body");
    t.integer("published", { default: 0 });
    t.integer("views", { default: 0 });
    t.timestamps();
  });
});

describe("creating", () => {
  it("creates and assigns an id", async () => {
    const post = await Post.create({ title: "Hello", body: "World" });

    expect(post.id).toBe(1);
    expect(post.title).toBe("Hello");
    expect(post.isPersisted).toBe(true);
    expect(post.isNewRecord).toBe(false);
  });

  it("builds without saving", async () => {
    const post = Post.build({ title: "Draft" });

    expect(post.isNewRecord).toBe(true);
    expect(await Post.count()).toBe(0);
  });

  it("saves a built record", async () => {
    const post = Post.build({ title: "Draft" });
    expect(await post.save()).toBe(true);
    expect(await Post.count()).toBe(1);
  });

  // Rails: timestamps are maintained automatically.
  it("sets created_at and updated_at", async () => {
    const post = await Post.create({ title: "Timed" });

    expect(typeof post.created_at).toBe("string");
    expect(post.updated_at).toBe(post.created_at);
  });

  it("applies database defaults on the way back", async () => {
    const post = await Post.create({ title: "Defaults" });
    expect(post.views).toBe(0);
    expect(post.published).toBe(0);
  });
});

describe("finding", () => {
  beforeEach(async () => {
    await Post.create({ title: "First", published: 1, views: 10 });
    await Post.create({ title: "Second", published: 0, views: 20 });
    await Post.create({ title: "Third", published: 1, views: 30 });
  });

  it("finds by primary key", async () => {
    const post = await Post.find(2);
    expect(post.title).toBe("Second");
  });

  // Rails: RecordNotFound, not nil.
  it("throws when find misses", async () => {
    await expect(Post.find(999)).rejects.toThrow(RecordNotFound);
  });

  // Rails: find_by returns nil.
  it("returns null when findBy misses", async () => {
    expect(await Post.findBy({ title: "Nope" })).toBeNull();
  });

  it("finds by conditions", async () => {
    const post = await Post.findBy({ title: "Third" });
    expect(post?.views).toBe(30);
  });

  it("returns all records", async () => {
    expect(await Post.all()).toHaveLength(3);
  });

  it("counts", async () => {
    expect(await Post.count()).toBe(3);
    expect(await Post.where({ published: 1 }).count()).toBe(2);
  });

  it("reports existence", async () => {
    expect(await Post.exists({ title: "First" })).toBe(true);
    expect(await Post.exists({ title: "Nope" })).toBe(false);
  });

  it("finds first and last", async () => {
    expect((await Post.first())?.title).toBe("First");
    expect((await Post.last())?.title).toBe("Third");
  });
});

describe("relations", () => {
  beforeEach(async () => {
    // Bodies are set here so the IS NULL test can tell the rows apart.
    await Post.create({ title: "Alpha", body: "a", published: 1, views: 5 });
    await Post.create({ title: "Beta", body: "b", published: 0, views: 15 });
    await Post.create({ title: "Gamma", body: "c", published: 1, views: 25 });
  });

  it("chains lazily and runs on await", async () => {
    const relation = Post.where({ published: 1 }).order("views", "desc").limit(1);
    const posts = await relation;

    expect(posts).toHaveLength(1);
    expect(posts[0]!.title).toBe("Gamma");
  });

  it("orders", async () => {
    const titles = (await Post.order("title", "desc")).map((p) => p.title);
    expect(titles).toEqual(["Gamma", "Beta", "Alpha"]);
  });

  it("limits and offsets", async () => {
    const posts = await Post.all().order("title").limit(1).offset(1);
    expect(posts.map((p) => p.title)).toEqual(["Beta"]);
  });

  // Rails: where(column: [a, b]) becomes IN.
  it("turns an array into IN", async () => {
    const posts = await Post.where({ title: ["Alpha", "Gamma"] }).order("title");
    expect(posts.map((p) => p.title)).toEqual(["Alpha", "Gamma"]);
  });

  // Rails: an empty array matches nothing rather than erroring.
  it("matches nothing for an empty array", async () => {
    expect(await Post.where({ title: [] })).toHaveLength(0);
  });

  it("turns null into IS NULL", async () => {
    await Post.create({ title: "Bodyless" });
    const posts = await Post.where({ body: null });
    expect(posts.map((p) => p.title)).toEqual(["Bodyless"]);
  });

  it("negates with whereNot", async () => {
    const posts = await Post.all().whereNot({ published: 1 });
    expect(posts.map((p) => p.title)).toEqual(["Beta"]);
  });

  it("accepts a raw fragment with bindings", async () => {
    const posts = await Post.all().where("views > ?", 10).order("views");
    expect(posts.map((p) => p.title)).toEqual(["Beta", "Gamma"]);
  });

  it("plucks a column", async () => {
    expect(await Post.all().order("title").pluck("title")).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("iterates in batches", async () => {
    const seen: string[] = [];
    for await (const post of Post.all().each(2)) seen.push(post.title);
    expect(seen).toHaveLength(3);
  });

  it("deletes everything matching", async () => {
    await Post.where({ published: 1 }).deleteAll();
    expect(await Post.count()).toBe(1);
  });

  it("rejects an invalid column name", () => {
    expect(() => Post.where({ "title; DROP TABLE posts": 1 }).toSql()).toThrow(
      "Invalid column name",
    );
  });

  it("builds readable SQL", () => {
    const { sql, bindings } = Post.where({ published: 1 }).order("title").limit(5).toSql();

    expect(sql).toBe(
      'SELECT "posts".* FROM "posts" WHERE "posts"."published" = ? ORDER BY "posts"."title" ASC LIMIT 5',
    );
    expect(bindings).toEqual([1]);
  });
});

describe("updating", () => {
  it("updates changed attributes", async () => {
    const post = await Post.create({ title: "Original" });
    expect(await post.update({ title: "Changed" })).toBe(true);

    const reloaded = await Post.find(post.id);
    expect(reloaded.title).toBe("Changed");
  });

  // Rails: dirty tracking reports what differs from the loaded values.
  it("tracks changes", async () => {
    const post = await Post.create({ title: "Original" });
    expect(post.hasChanged()).toBe(false);

    post.title = "Edited";
    expect(post.hasChanged()).toBe(true);
    expect(post.changed()).toContain("title");
    expect(post.changedAttributes()).toMatchObject({ title: "Edited" });
  });

  it("clears changes after save", async () => {
    const post = await Post.create({ title: "Original" });
    post.title = "Edited";
    await post.save();

    expect(post.hasChanged()).toBe(false);
  });

  it("reloads from the database", async () => {
    const post = await Post.create({ title: "Original" });
    await connection.execute("UPDATE posts SET title = 'Elsewhere' WHERE id = ?", [post.id]);

    await post.reload();
    expect(post.title).toBe("Elsewhere");
  });

  it("bumps updated_at but not created_at", async () => {
    const post = await Post.create({ title: "Timed" });
    const created = post.created_at;

    await Bun.sleep(5);
    await post.update({ title: "Later" });

    expect(post.created_at).toBe(created);
    expect(post.updated_at >= created).toBe(true);
  });
});

describe("destroying", () => {
  it("deletes the row", async () => {
    const post = await Post.create({ title: "Doomed" });
    expect(await post.destroy()).toBe(true);
    expect(await Post.count()).toBe(0);
    expect(post.isNewRecord).toBe(true);
  });

  it("does nothing for an unsaved record", async () => {
    expect(await Post.build({ title: "Never saved" }).destroy()).toBe(false);
  });
});

describe("validations", () => {
  class Article extends Model<PostAttributes>("posts") {
    override async runValidations(): Promise<void> {
      if (!this.title || String(this.title).trim() === "") {
        this.errors.add("title", "can't be blank");
      }
    }
  }

  it("refuses to save an invalid record", async () => {
    const article = Article.build({ title: "" });

    expect(await article.save()).toBe(false);
    expect(article.errors.on("title")).toEqual(["can't be blank"]);
    expect(await Article.count()).toBe(0);
  });

  // Rails: save! raises RecordInvalid.
  it("throws from saveOrFail", async () => {
    await expect(Article.build({ title: "" }).saveOrFail()).rejects.toThrow(RecordInvalid);
  });

  it("saves a valid record", async () => {
    expect(await Article.build({ title: "Fine" }).save()).toBe(true);
  });

  it("reports full messages", async () => {
    const article = Article.build({ title: "" });
    await article.validate();

    expect(article.errors.fullMessages()).toEqual(["title can't be blank"]);
    expect(article.errors.count).toBe(1);
    expect(article.errors.isEmpty).toBe(false);
  });
});

describe("callbacks", () => {
  it("runs save callbacks in Rails' order", async () => {
    const order: string[] = [];

    class Tracked extends Model<PostAttributes>("posts") {
      @beforeSave
      before(): void {
        order.push("before");
      }

      @afterSave
      after(): void {
        order.push("after");
      }
    }

    await Tracked.create({ title: "Hooked" });
    expect(order).toEqual(["before", "after"]);
  });

  it("lets a before callback modify attributes", async () => {
    class Slugged extends Model<PostAttributes>("posts") {
      @beforeSave
      normalize(): void {
        this.title = String(this.title).trim();
      }
    }

    const record = await Slugged.create({ title: "  Padded  " });
    expect(record.title).toBe("Padded");
  });
});

describe("conventions", () => {
  it("infers the table name from the class name", () => {
    class LineItem extends Model<{ id: number }>() {}
    expect(LineItem.table).toBe("line_items");
  });

  it("uses an explicit table name when given", () => {
    expect(Post.table).toBe("posts");
  });

  it("underscores the model name", () => {
    class LineItem extends Model<{ id: number }>() {}
    expect(modelName(LineItem)).toBe("line_item");
  });

  // The router's path helpers call toParam on a record.
  it("returns the primary key from toParam", async () => {
    const post = await Post.create({ title: "Param" });
    expect(post.toParam()).toBe("1");
  });

  it("serializes to JSON", async () => {
    const post = await Post.create({ title: "Serialized" });
    expect(JSON.parse(JSON.stringify(post))).toMatchObject({ title: "Serialized", id: 1 });
  });
});
