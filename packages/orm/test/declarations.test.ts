/**
 * Default scopes and secure tokens.
 *
 * Mirrors activerecord/test/cases/scoping/default_scoping_test.rb and
 * secure_token_test.rb. The write test is the one worth having, and it pins a
 * deliberate difference: in Rails a default scope also fills in what `create`
 * writes, and here it does not.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Model, SchemaStatements, setConnection } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { testConnection } from "./support/database.js";

interface PostRow {
  id: number;
  title: string;
  deleted_at: string | null;
  invite_token: string | null;
}

class Post extends Model<PostRow>("posts") {
  static {
    this.defaultScope((posts) => posts.where({ deleted_at: null }));
    this.hasSecureToken("invite_token");
  }
}

/** No scope, to read what is really in the table. */
class RawPost extends Model<PostRow>("posts") {}

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  for (const model of [Post, RawPost]) {
    model.resetColumnInformation();
  }

  const schema = new SchemaStatements(connection);
  await schema.dropTable("posts", { ifExists: true });
  await schema.createTable("posts", (t) => {
    t.string("title");
    t.datetime("deleted_at");
    t.string("invite_token");
  });
});

describe("a default scope", () => {
  beforeEach(async () => {
    await RawPost.create({ title: "live", deleted_at: null });
    await RawPost.create({ title: "gone", deleted_at: "2026-01-01 00:00:00" });
  });

  // The usual reason: a deleted row is still there, and every query that
  // forgot to say so would find it.
  it("narrows every query", async () => {
    expect(await Post.count()).toBe(1);
    expect((await Post.all())[0]?.title).toBe("live");
  });

  it("narrows a query that adds its own conditions", async () => {
    expect(await Post.where({ title: "gone" }).count()).toBe(0);
    expect(await Post.where({ title: "live" }).count()).toBe(1);
  });

  it("narrows find and findBy", async () => {
    expect(await Post.findBy({ title: "gone" })).toBeNull();
  });

  it("is escaped by unscoped", async () => {
    expect(await Post.unscoped().count()).toBe(2);
  });

  it("leaves a model without one alone", async () => {
    expect(await RawPost.count()).toBe(2);
  });

  it("does not leak into another model on the same table", async () => {
    expect(Post.defaultScopes).toHaveLength(1);
    expect(RawPost.defaultScopes).toHaveLength(0);
  });

  it("does not leak into a parent when a subclass adds one", () => {
    class Narrower extends Post {
      static {
        this.defaultScope((posts) => posts.where({ title: "live" }));
      }
    }

    expect(Narrower.defaultScopes).toHaveLength(2);
    expect(Post.defaultScopes).toHaveLength(1);
  });
});

// A default scope fills in what `create` writes, from its equality conditions,
// as Rails' does. This diverged for a while; the alternative made a record the
// scope could not then find, which reads as a persistence bug rather than as a
// scope doing its job.
describe("what a default scope does to a write", () => {
  it("fills the scoped column in on create", async () => {
    class Archived extends Model<PostRow>("posts") {
      static {
        this.defaultScope((posts) => posts.where({ title: "archived" }));
      }
    }

    Archived.resetColumnInformation();

    const created = await Archived.create({ deleted_at: null });

    expect(created.title).toBe("archived");

    // And so the record it just made is inside its own scope, which is the
    // point: the scope says what one of these is.
    expect(await Archived.count()).toBe(1);
  });

  it("still lets an explicit value win", async () => {
    class Archived extends Model<PostRow>("posts") {
      static {
        this.defaultScope((posts) => posts.where({ title: "archived" }));
      }
    }

    Archived.resetColumnInformation();

    // Outside its own scope, and deliberately so: the caller said what they
    // wanted and a default is only a default.
    expect((await Archived.create({ title: "live" })).title).toBe("live");
  });
});

describe("a secure token", () => {
  it("is filled in before the row is written", async () => {
    const post = await Post.create({ title: "a" });

    expect(post.invite_token).toBeTruthy();
    expect(String(post.invite_token).length).toBeGreaterThan(20);
  });

  it("is different every time", async () => {
    const one = await Post.create({ title: "a" });
    const two = await Post.create({ title: "b" });

    expect(one.invite_token).not.toBe(two.invite_token);
  });

  // Reissuing one, or a fixture that names it, should be kept.
  it("keeps a token that was given", async () => {
    const post = await Post.create({ title: "a", invite_token: "chosen" });

    expect(post.invite_token).toBe("chosen");
  });

  it("is not regenerated on update", async () => {
    const post = await Post.create({ title: "a" });
    const first = post.invite_token;

    await post.update({ title: "b" });

    expect(post.invite_token).toBe(first as string);
  });

  // The length is bytes of entropy rather than characters of output, because
  // the second is what people count and the first is what matters.
  it("takes a length in bytes of entropy", async () => {
    class Short extends Model<PostRow>("posts") {
      static {
        this.hasSecureToken("invite_token", { length: 8 });
      }
    }

    Short.resetColumnInformation();

    const post = await Short.create({ title: "a" });

    expect(String(post.invite_token).length).toBeLessThan(
      String((await Post.create({ title: "b" })).invite_token).length,
    );
  });
});
